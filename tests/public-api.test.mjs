import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const buildDir = process.env.POOL_TEST_BUILD_DIR
  ? pathToFileURL(path.resolve(process.env.POOL_TEST_BUILD_DIR)).href
  : new URL("../dist-electron", import.meta.url).href;
const { toPublicApiRequest, toPoolJobView } = await import(`${buildDir}/public-api.js`);

const base = {
  id: 1, requestId: "doubao-1", source: "tianyan-canvas", model: "seedance_2_0_mini",
  accountId: 10, accountName: "账号 010", accountPartition: "persist:x", retryCount: 0,
  status: "running", message: "已提交豆包，等待视频完成并复制分享链接", prompt: "p",
  referenceImagePath: null, referenceImagePaths: ["a.png", "b.png"], removeWatermark: true, callbackUrl: null,
  doubaoThreadUrl: "https://www.doubao.com/chat/1", rawVideoUrl: null, cleanVideoUrl: null, outputVideoPath: null,
  aspectRatio: "16:9", resolution: null, imageCount: 1, durationSeconds: 5, imageUrls: null, outputImagePaths: null,
  createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:01:00.000Z", finishedAt: null,
  clientRequestId: "gen-1#1", parentRequestId: null, workflowPhase: "generating", submittedAt: "2026-10-17T00:00:30.000Z",
  heartbeatAt: "2026-10-17T00:01:00.000Z", errorCode: null, quotaRefunded: false, queueDeadlineAt: null,
  preferredAccountId: null, excludeAccountIds: null
};

test("the v2 view is a strict superset of the legacy public view", () => {
  const legacy = toPublicApiRequest(base);
  const view = toPoolJobView(base);
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(view[key], value, key);
});

test("running + submitted: quota consumed, cannot abandon, no error", () => {
  const view = toPoolJobView(base, { tracked: true });
  assert.equal(view.protocol, "pool-v2");
  assert.equal(view.kind, "video");
  assert.equal(view.phase, "generating");
  assert.equal(view.submitted, true);
  assert.equal(view.quotaState, "consumed");
  assert.equal(view.error, null);
  assert.deepEqual(view.actions, { canAbandon: false, canRecover: false, canRetry: false });
  assert.equal(view.referenceImageCount, 2);
});

test("queued: no account, nothing charged, can abandon", () => {
  const view = toPoolJobView({ ...base, status: "queued", accountId: null, submittedAt: null, workflowPhase: "queued" });
  assert.equal(view.quotaState, "none");
  assert.equal(view.actions.canAbandon, true);
});

test("failed after submit (interrupted): recoverable unless still tracked", () => {
  const failed = { ...base, status: "failed", errorCode: "INTERRUPTED_AFTER_SUBMIT", workflowPhase: "interrupted", finishedAt: base.updatedAt };
  const view = toPoolJobView(failed);
  assert.equal(view.error.code, "INTERRUPTED_AFTER_SUBMIT");
  assert.equal(view.error.category, "D");
  assert.equal(view.error.recoverable, true);
  assert.equal(view.error.retryCostsQuota, true);
  assert.equal(view.actions.canRecover, true);
  assert.equal(toPoolJobView(failed, { tracked: true }).actions.canRecover, false);
});

test("legacy rows: 'prepared' phase hidden, missing error code defaults by submission", () => {
  const view = toPoolJobView({ ...base, status: "failed", workflowPhase: "prepared", submittedAt: null, errorCode: null });
  assert.equal(view.phase, null);
  assert.equal(view.error.code, "UNKNOWN_BEFORE_SUBMIT");
  assert.equal(view.quotaState, "consumed");
});

test("images are never recoverable; logs are mapped when requested", () => {
  const view = toPoolJobView(
    { ...base, model: "seedream_5_0_flash", status: "failed", errorCode: "RESULT_TIMEOUT" },
    { logs: [{ id: 1, requestId: "doubao-1", accountId: 10, accountName: null, accountPartition: null, action: "任务失败", status: "failed", message: "m", targetUrl: null, createdAt: "t" }] }
  );
  assert.equal(view.kind, "image");
  assert.equal(view.error.recoverable, false);
  assert.deepEqual(view.logs, [{ at: "t", action: "任务失败", status: "failed", message: "m", targetUrl: null, accountId: 10 }]);
});
