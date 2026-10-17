// Run with Electron, never normal Node: better-sqlite3 uses the Electron ABI.
//   npx electron tests/request-supervisor.db.mjs       (POOL_TEST_BUILD_DIR=<outDir> to test an isolated build)
// 启动清扫 / 心跳清扫 / 排队派发 / 放弃 —— 在真实 SQLite 上配合假执行器验证。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-supervisor-fixture-"));
const output = process.env.POOL_TEST_BUILD_DIR || "dist-electron";
app.setPath("userData", root);

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
}

class FakeExecutor {
  tracked = new Set();
  enqueued = [];
  abandonOutcomes = new Map();
  isTracked(id) { return this.tracked.has(id); }
  enqueue(id) { this.enqueued.push(id); this.tracked.add(id); }
  abandon(id) { return this.abandonOutcomes.get(id) ?? "not_active"; }
}

app.whenReady().then(async () => {
  let db;
  let code = 0;
  try {
    const { AppDatabase } = await import(pathToFileURL(path.resolve(output, "database.js")).href);
    const { RequestSupervisor } = await import(pathToFileURL(path.resolve(output, "request-supervisor.js")).href);
    db = new AppDatabase();
    db.updateSettings({ miniCost: 2, executorEnabled: true });
    const a = db.createAccount({ remark: "A" });
    const b = db.createAccount({ remark: "B" });
    for (const acc of [a, b]) db.updateAccount({ id: acc.id, loginStatus: "logged_in", currentStatus: "idle", mediaPageKind: "consumer", quotaRemaining: 10 });

    let clock = Date.now();
    const changed = [];
    const executor = new FakeExecutor();
    const supervisor = new RequestSupervisor({
      database: db,
      executor,
      onRequestChanged: (r) => changed.push(`${r.requestId}:${r.status}:${r.errorCode ?? ""}`),
      now: () => clock
    });

    let seq = 0;
    const admit = (overrides = {}) => db.admitGenerateRequest({
      requestId: `r${++seq}`,
      clientRequestId: `job-${seq}#1`,
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

    // r1: running, not submitted (account X) ; r2: running, submitted (account Y)
    const r1 = admit();
    const r2 = admit();
    db.updateApiRequest({ requestId: "r1", status: "running" });
    db.updateApiRequest({ requestId: "r2", status: "running", doubaoThreadUrl: "https://www.doubao.com/chat/123456789" });
    db.markApiRequestSubmitted("r2");
    const quotaX = db.getAccount(r1.account.id).quotaRemaining;
    const quotaY = db.getAccount(r2.account.id).quotaRemaining;
    // r3: queued (both accounts busy)
    const r3 = admit();
    assert.equal(r3.outcome, "queued");

    await check("startup sweep: not-submitted orphans fail with refund, submitted orphans keep quota, queued untouched", () => {
      const swept = supervisor.sweepOrphans("restart");
      assert.deepEqual(swept.map((r) => [r.requestId, r.errorCode]).sort(), [["r1", "INTERRUPTED_BEFORE_SUBMIT"], ["r2", "INTERRUPTED_AFTER_SUBMIT"]]);
      // r1 退回 2；r2 已提交不退；随后排队的 r3 被派发到其中一个账号并预扣 2。
      const total = db.getAccount(r1.account.id).quotaRemaining + db.getAccount(r2.account.id).quotaRemaining;
      assert.equal(total, quotaX + 2 + quotaY - 2);
      assert.equal(db.getApiRequest("r1").quotaRefunded, true);
      const r2row = db.getApiRequest("r2");
      assert.match(r2row.message, /chat\/123456789/);
      assert.equal(r2row.workflowPhase, "interrupted");
      assert.equal(r2row.quotaRefunded, false);
    });

    await check("after the sweep released both accounts the queued request was dispatched", () => {
      const r3row = db.getApiRequest("r3");
      assert.equal(r3row.status, "accepted");
      assert.ok(r3row.accountId);
      assert.deepEqual(executor.enqueued, ["r3"]);
    });

    await check("heartbeat sweep skips tracked and fresh requests, finalizes stale untracked ones", () => {
      db.updateApiRequest({ requestId: "r3", status: "running" });
      db.touchApiRequestHeartbeat("r3");
      assert.deepEqual(supervisor.sweepOrphans("heartbeat_lost"), [], "tracked request must be skipped");
      executor.tracked.delete("r3");
      assert.deepEqual(supervisor.sweepOrphans("heartbeat_lost"), [], "fresh heartbeat must be skipped");
      clock += 4 * 60_000;
      const swept = supervisor.sweepOrphans("heartbeat_lost");
      assert.deepEqual(swept.map((r) => [r.requestId, r.errorCode]), [["r3", "INTERRUPTED_BEFORE_SUBMIT"]]);
      assert.match(swept[0].message, /心跳丢失/);
    });

    await check("queued requests time out without charge", () => {
      db.updateAccount({ id: a.id, currentStatus: "busy" });
      db.updateAccount({ id: b.id, currentStatus: "busy" });
      const q = admit({ queueTimeoutSeconds: 60 });
      assert.equal(q.outcome, "queued");
      // keep the accounts busy through the sweep by giving them active requests
      clock = Date.now() + 61_000;
      supervisor.dispatchQueued();
      const row = db.getApiRequest(q.request.requestId);
      assert.equal(row.status, "failed");
      assert.equal(row.errorCode, "QUEUE_TIMEOUT");
      assert.equal(row.accountId, null);
      clock = Date.now();
    });

    await check("queued requests are cancelled once they can never be served", () => {
      const q = admit();
      assert.equal(q.outcome, "queued");
      db.updateAccount({ id: a.id, loginStatus: "logged_out" });
      db.updateAccount({ id: b.id, loginStatus: "logged_out" });
      supervisor.dispatchQueued();
      const row = db.getApiRequest(q.request.requestId);
      assert.equal(row.status, "failed");
      assert.equal(row.errorCode, "NO_ACCOUNT_LOGIN");
      for (const acc of [a, b]) db.updateAccount({ id: acc.id, loginStatus: "logged_in", currentStatus: "idle", mediaPageKind: "consumer" });
    });

    await check("abandon: queued -> 200 ABANDONED, nothing charged", () => {
      db.updateAccount({ id: a.id, currentStatus: "busy" });
      db.updateAccount({ id: b.id, currentStatus: "busy" });
      const q = admit();
      const res = supervisor.abandon(q.request.requestId);
      assert.equal(res.httpStatus, 200);
      assert.equal(res.request.errorCode, "ABANDONED");
      assert.equal(res.alreadyFinished, false);
      db.updateAccount({ id: a.id, currentStatus: "idle" });
      db.updateAccount({ id: b.id, currentStatus: "idle" });
    });

    await check("abandon: accepted but not started -> 200, refunded, account released", () => {
      const r = admit();
      executor.abandonOutcomes.set(r.request.requestId, "dequeued");
      const before = db.getAccount(r.account.id).quotaRemaining;
      const res = supervisor.abandon(r.request.requestId);
      assert.equal(res.httpStatus, 200);
      assert.equal(res.request.errorCode, "ABANDONED");
      assert.equal(res.request.quotaRefunded, true);
      assert.equal(db.getAccount(r.account.id).quotaRemaining, before + 2);
      assert.equal(db.getAccount(r.account.id).currentStatus, "idle");
    });

    await check("abandon: running and not submitted -> 202 while the watchdog aborts", () => {
      const r = admit();
      db.updateApiRequest({ requestId: r.request.requestId, status: "running" });
      executor.abandonOutcomes.set(r.request.requestId, "aborting");
      const res = supervisor.abandon(r.request.requestId);
      assert.equal(res.httpStatus, 202);
      assert.equal(db.getApiRequest(r.request.requestId).status, "running", "finalization belongs to the watchdog");
      db.finalizeApiRequest({ requestId: r.request.requestId, expectStatuses: ["running"], message: "x", errorCode: "ABANDONED", workflowPhase: "failed", refund: true, releaseAccount: true });
    });

    await check("abandon: submitted -> 409 ABANDON_AFTER_SUBMIT, nothing changes", () => {
      const r = admit();
      db.updateApiRequest({ requestId: r.request.requestId, status: "running" });
      db.markApiRequestSubmitted(r.request.requestId);
      const res = supervisor.abandon(r.request.requestId);
      assert.equal(res.httpStatus, 409);
      assert.equal(res.code, "ABANDON_AFTER_SUBMIT");
      assert.equal(db.getApiRequest(r.request.requestId).status, "running");
    });

    await check("abandon: finished -> 200 alreadyFinished; unknown -> 404", () => {
      const res = supervisor.abandon("r1");
      assert.equal(res.httpStatus, 200);
      assert.equal(res.alreadyFinished, true);
      assert.equal(supervisor.abandon("nope").httpStatus, 404);
    });

    await check("every state change was reported", () => {
      assert.ok(changed.some((c) => c.startsWith("r1:failed:INTERRUPTED_BEFORE_SUBMIT")));
      assert.ok(changed.some((c) => c.startsWith("r3:accepted")));
      assert.ok(changed.some((c) => c.endsWith(":ABANDONED")));
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
