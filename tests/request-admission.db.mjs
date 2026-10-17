// Run with Electron, never normal Node: better-sqlite3 uses the Electron ABI.
//   npx electron tests/request-admission.db.mjs        (POOL_TEST_BUILD_DIR=<outDir> to test an isolated build)
// 覆盖执行器协议 v2 的受理/排队/派发/收尾在真实 SQLite 上的行为。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-admission-fixture-"));
const output = process.env.POOL_TEST_BUILD_DIR || "dist-electron";
app.setPath("userData", root);

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
}

app.whenReady().then(async () => {
  let db;
  let code = 0;
  try {
    const { AppDatabase } = await import(pathToFileURL(path.resolve(output, "database.js")).href);
    db = new AppDatabase();
    db.updateSettings({ miniCost: 2, fastCost: 3, standardCost: 20, imageCost: 1 });

    const a = db.createAccount({ remark: "A" });
    const b = db.createAccount({ remark: "B" });
    const work = db.createAccount({ remark: "work" });
    db.updateAccount({ id: a.id, loginStatus: "logged_in", currentStatus: "idle", mediaPageKind: "consumer", quotaRemaining: 4 });
    db.updateAccount({ id: b.id, loginStatus: "logged_in", currentStatus: "idle", mediaPageKind: "consumer", quotaRemaining: 2 });
    db.updateAccount({ id: work.id, loginStatus: "logged_in", currentStatus: "idle", mediaPageKind: "work", quotaRemaining: 10 });

    const base = (overrides = {}) => ({
      requestId: `req-${Math.random().toString(16).slice(2, 10)}`,
      source: "fixture",
      model: "seedance_2_0_mini",
      prompt: "一只在雨夜霓虹街头奔跑的橘猫，电影感镜头",
      aspectRatio: "16:9",
      durationSeconds: 5,
      executorEnabled: true,
      allowQueue: true,
      queueTimeoutSeconds: 600,
      selection: {},
      ...overrides
    });

    await check("migration adds v2 columns and the unique client_request_id index", () => {
      const columns = db.db.prepare("PRAGMA table_info(api_requests)").all().map((c) => c.name);
      for (const column of ["client_request_id", "parent_request_id", "heartbeat_at", "quota_refunded", "queue_deadline_at", "preferred_account_id", "exclude_account_ids", "workflow_phase", "submitted_at", "error_code"]) {
        assert.ok(columns.includes(column), column);
      }
      const indexes = db.db.prepare("PRAGMA index_list(api_requests)").all().map((i) => i.name);
      assert.ok(indexes.includes("idx_api_requests_client_request_id"));
    });

    let first;
    await check("admission reserves, deducts and inserts atomically", () => {
      first = db.admitGenerateRequest(base({ requestId: "req-1", clientRequestId: "gen-1#1", parentRequestId: null }));
      assert.equal(first.outcome, "accepted");
      assert.equal(first.request.status, "accepted");
      assert.equal(first.request.workflowPhase, "queued");
      assert.equal(first.request.clientRequestId, "gen-1#1");
      assert.equal(first.account.currentStatus, "busy");
      assert.equal(db.getAccount(first.account.id).quotaRemaining, first.account.id === a.id ? 2 : 0);
    });

    await check("same clientRequestId replays without a second reservation or charge", () => {
      const quotaBefore = db.listAccounts().map((acc) => [acc.id, acc.quotaRemaining, acc.currentStatus]);
      const replay = db.admitGenerateRequest(base({ requestId: "req-1-dup", clientRequestId: "gen-1#1" }));
      assert.equal(replay.outcome, "replay");
      assert.equal(replay.request.requestId, "req-1");
      assert.deepEqual(db.listAccounts().map((acc) => [acc.id, acc.quotaRemaining, acc.currentStatus]), quotaBefore);
      assert.equal(db.getApiRequest("req-1-dup"), undefined);
    });

    await check("the database itself rejects a duplicate clientRequestId", () => {
      assert.throws(() => db.createApiRequest({ requestId: "dup-raw", model: "seedance_2_0_mini", status: "failed", prompt: "x", aspectRatio: "16:9", clientRequestId: "gen-1#1" }), /UNIQUE/);
    });

    let second;
    await check("the second account is used next; excludeAccountIds is honoured", () => {
      second = db.admitGenerateRequest(base({ requestId: "req-2", clientRequestId: "gen-2#1" }));
      assert.equal(second.outcome, "accepted");
      assert.notEqual(second.account.id, first.account.id);
    });

    let queued;
    await check("when every eligible account is busy the request is queued without charge", () => {
      const quotaBefore = db.listAccounts().map((acc) => acc.quotaRemaining);
      queued = db.admitGenerateRequest(base({ requestId: "req-3", clientRequestId: "gen-3#1", selection: { excludeAccountIds: [work.id] } }));
      assert.equal(queued.outcome, "queued");
      assert.equal(queued.request.status, "queued");
      assert.equal(queued.request.accountId, null);
      assert.ok(queued.request.queueDeadlineAt);
      assert.deepEqual(queued.request.excludeAccountIds, [work.id]);
      assert.deepEqual(db.listAccounts().map((acc) => acc.quotaRemaining), quotaBefore);
      assert.deepEqual(db.listQueuedApiRequests().map((r) => r.requestId), ["req-3"]);
    });

    await check("without allowQueue the legacy behaviour is an immediate rejection", () => {
      const rejected = db.admitGenerateRequest(base({ requestId: "req-legacy", allowQueue: false }));
      assert.equal(rejected.outcome, "rejected");
      assert.equal(rejected.code, "NO_ACCOUNT");
      assert.equal(rejected.request.status, "failed");
      assert.equal(rejected.request.errorCode, "NO_ACCOUNT");
    });

    await check("requests that can never be served fail fast with a precise code", () => {
      const tooExpensive = db.admitGenerateRequest(base({ requestId: "req-big", model: "seedance_2_0", clientRequestId: "gen-big#1" }));
      assert.equal(tooExpensive.outcome, "rejected");
      assert.equal(tooExpensive.code, "NO_ACCOUNT_QUOTA");
      const onlyWork = db.admitGenerateRequest(base({ requestId: "req-work", clientRequestId: "gen-work#1", selection: { excludeAccountIds: [a.id, b.id] } }));
      assert.equal(onlyWork.code, "ACCOUNT_WORK_PAGE");
      const missing = db.admitGenerateRequest(base({ requestId: "req-missing", clientRequestId: "gen-missing#1", selection: { accountId: 9999 } }));
      assert.equal(missing.code, "ACCOUNT_UNAVAILABLE");
    });

    await check("dispatch keeps a queued request queued while accounts are busy", () => {
      assert.equal(db.dispatchQueuedRequest("req-3"), null);
      assert.equal(db.getApiRequest("req-3").status, "queued");
    });

    await check("markSubmitted records only the first submission time; heartbeat updates", () => {
      db.markApiRequestSubmitted("req-1");
      const t1 = db.getApiRequest("req-1").submittedAt;
      assert.ok(t1);
      db.markApiRequestSubmitted("req-1");
      assert.equal(db.getApiRequest("req-1").submittedAt, t1);
      db.touchApiRequestHeartbeat("req-1");
      assert.ok(db.getApiRequest("req-1").heartbeatAt);
    });

    await check("finalize (orphan, not submitted) refunds once and releases the account", () => {
      const accountId = second.account.id;
      const quotaBefore = db.getAccount(accountId).quotaRemaining;
      const done = db.finalizeApiRequest({ requestId: "req-2", expectStatuses: ["accepted", "running"], message: "执行器重启，任务中断；尚未提交到豆包", errorCode: "INTERRUPTED_BEFORE_SUBMIT", workflowPhase: "interrupted", refund: true, releaseAccount: true });
      assert.equal(done.status, "failed");
      assert.equal(done.errorCode, "INTERRUPTED_BEFORE_SUBMIT");
      assert.equal(done.quotaRefunded, true);
      assert.equal(db.getAccount(accountId).quotaRemaining, quotaBefore + 2);
      assert.equal(db.getAccount(accountId).currentStatus, "idle");
      const again = db.finalizeApiRequest({ requestId: "req-2", expectStatuses: ["accepted", "running"], message: "x", errorCode: "INTERRUPTED_BEFORE_SUBMIT", workflowPhase: "interrupted", refund: true, releaseAccount: true });
      assert.equal(again, null, "a finished request must not be finalized twice");
      assert.equal(db.getAccount(accountId).quotaRemaining, quotaBefore + 2, "no double refund");
    });

    await check("after an account is released the queued request is dispatched FIFO and charged", () => {
      const dispatched = db.dispatchQueuedRequest("req-3");
      assert.ok(dispatched);
      assert.equal(dispatched.request.status, "accepted");
      assert.equal(dispatched.account.id, second.account.id);
      assert.equal(dispatched.request.queueDeadlineAt, null);
      assert.equal(db.getAccount(second.account.id).currentStatus, "busy");
      assert.equal(db.listQueuedApiRequests().length, 0);
    });

    await check("finalize (orphan, submitted) never refunds", () => {
      const accountId = first.account.id;
      const quotaBefore = db.getAccount(accountId).quotaRemaining;
      db.updateApiRequest({ requestId: "req-1", status: "running" });
      const done = db.finalizeApiRequest({ requestId: "req-1", expectStatuses: ["accepted", "running"], message: "执行器重启，任务中断；任务已提交到豆包", errorCode: "INTERRUPTED_AFTER_SUBMIT", workflowPhase: "interrupted", refund: false, releaseAccount: true });
      assert.equal(done.quotaRefunded, false);
      assert.equal(db.getAccount(accountId).quotaRemaining, quotaBefore);
      assert.equal(db.getAccount(accountId).currentStatus, "idle");
    });

    await check("finalizing a queued request (abandon/timeout) marks it uncharged without touching accounts", () => {
      db.updateAccount({ id: a.id, currentStatus: "busy" });
      db.updateAccount({ id: b.id, currentStatus: "busy" });
      const q = db.admitGenerateRequest(base({ requestId: "req-q2", clientRequestId: "gen-q2#1", selection: { excludeAccountIds: [work.id] } }));
      assert.equal(q.outcome, "queued");
      const quotas = db.listAccounts().map((acc) => acc.quotaRemaining);
      const done = db.finalizeApiRequest({ requestId: "req-q2", expectStatuses: ["queued"], message: "排队超时", errorCode: "QUEUE_TIMEOUT", workflowPhase: "failed", refund: true, releaseAccount: true });
      assert.equal(done.status, "failed");
      assert.equal(done.quotaRefunded, true);
      assert.equal(done.queueDeadlineAt, null);
      assert.deepEqual(db.listAccounts().map((acc) => acc.quotaRemaining), quotas);
    });

    await check("releaseOrphanBusyAccounts frees busy accounts that have no active request", () => {
      const released = db.releaseOrphanBusyAccounts().sort();
      assert.ok(released.includes(first.account.id));
      assert.equal(db.getAccount(first.account.id).currentStatus, "idle");
      // req-3 is still accepted on account B -> B must stay busy
      assert.ok(!released.includes(second.account.id));
      assert.equal(db.getAccount(second.account.id).currentStatus, "busy");
    });

    await check("updateApiRequest keeps v2 fields unless explicitly changed", () => {
      db.updateApiRequest({ requestId: "req-3", status: "running", message: "正在打开豆包执行窗口", workflowPhase: "opening" });
      let row = db.getApiRequest("req-3");
      assert.equal(row.workflowPhase, "opening");
      assert.equal(row.clientRequestId, "gen-3#1");
      db.updateApiRequest({ requestId: "req-3", message: "继续" });
      row = db.getApiRequest("req-3");
      assert.equal(row.workflowPhase, "opening");
      db.updateApiRequest({ requestId: "req-3", status: "failed", message: "x", errorCode: "PAGE_LOAD", quotaRefunded: true, workflowPhase: "failed" });
      row = db.getApiRequest("req-3");
      assert.deepEqual([row.errorCode, row.quotaRefunded, row.workflowPhase], ["PAGE_LOAD", true, "failed"]);
    });

    await check("queryApiRequests filters by status, client prefix and limit; per-request logs are ordered", () => {
      const failed = db.queryApiRequests({ statuses: ["failed"], limit: 50 });
      assert.ok(failed.length >= 3);
      assert.ok(failed.every((r) => r.status === "failed"));
      const gens = db.queryApiRequests({ clientRequestIdPrefix: "gen-1#" });
      assert.deepEqual(gens.map((r) => r.requestId), ["req-1"]);
      assert.equal(db.queryApiRequests({ limit: 2 }).length, 2);
      db.appendOperationLog({ requestId: "req-1", action: "a", message: "first" });
      db.appendOperationLog({ requestId: "req-1", action: "b", message: "second" });
      db.appendOperationLog({ requestId: "other", action: "c", message: "noise" });
      assert.deepEqual(db.listOperationLogsForRequest("req-1").map((l) => l.message), ["first", "second"]);
    });

    await check("legacy rows (workflow_phase='prepared', no v2 fields) still normalize", () => {
      db.db.prepare("INSERT INTO api_requests (request_id, model, status, prompt, aspect_ratio, workflow_phase, created_at, updated_at) VALUES ('legacy', 'seedance_2_0_mini', 'failed', 'p', '16:9', 'prepared', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')").run();
      const row = db.getApiRequest("legacy");
      assert.equal(row.clientRequestId, null);
      assert.equal(row.quotaRefunded, false);
      assert.equal(row.excludeAccountIds, null);
    });

    await check("re-opening the database is a safe no-op migration", () => {
      db.db.close();
      db = new AppDatabase();
      assert.equal(db.getApiRequest("req-1").clientRequestId, "gen-1#1");
      assert.equal(db.getApiRequestByClientRequestId("gen-3#1").requestId, "req-3");
    });

    db.db.close();
    db = null;
    console.log(`PASS (${results.length}):\n - ${results.join("\n - ")}`);
  } catch (error) {
    console.error(`after PASS: ${results.join(" | ")}`);
    console.error(error);
    if (db) try { db.db.close(); } catch {}
    code = 1;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    app.exit(code);
  }
});
