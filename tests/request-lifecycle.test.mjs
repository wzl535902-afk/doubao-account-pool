import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const buildDir = process.env.POOL_TEST_BUILD_DIR
  ? pathToFileURL(path.resolve(process.env.POOL_TEST_BUILD_DIR)).href
  : new URL("../dist-electron", import.meta.url).href;
const {
  ERROR_CODES,
  canFailoverToAnotherAccount,
  classifyFailure,
  failureFlags,
  phaseForProgress,
  resolveOrphan,
  stallLimitMs,
  hardDeadlineMs,
  normalizeClientRequestId,
  normalizeQueueTimeoutSeconds,
  parseAccountIdList,
  parseOptionalAccountId
} = await import(`${buildDir}/request-lifecycle.js`);
const { WORK_MEDIA_UNSUPPORTED } = await import(`${buildDir}/media-compatibility.js`);

// 文案均取自 executor.ts / media-compatibility.ts / watermark.ts 的真实失败信息。
const classifyCases = [
  ["账号触发字节风控验证码（人机验证），请到「账号管理」重新登录该账号后再试", false, "ACCOUNT_CAPTCHA"],
  ["豆包页面长时间无响应（疑似被风控验证拦截），请到「账号管理」重新登录该豆包账号后再试", false, "ACCOUNT_CAPTCHA"],
  ["豆包账号未登录，请到「账号管理」重新登录该账号后再试", false, "ACCOUNT_LOGGED_OUT"],
  ["豆包账号未登录，无法恢复视频结果", true, "ACCOUNT_LOGGED_OUT"],
  [WORK_MEDIA_UNSUPPORTED, false, "ACCOUNT_WORK_PAGE"],
  ["豆包账号未开通会员订阅，无法使用「Seedance 2.0」标准档（网页弹出了订阅对话框）", false, "ACCOUNT_NO_SUBSCRIPTION"],
  ["请求没有分配账号", false, "ACCOUNT_UNAVAILABLE"],
  ["没有可用账号，或该模型剩余额度不足", false, "NO_ACCOUNT_QUOTA"],
  ["当前没有可用账号", false, "NO_ACCOUNT"],
  ["排队超时：10 分钟内没有空闲账号", false, "QUEUE_TIMEOUT"],
  ["豆包返回生成失败提示，未产出图片", true, "PLATFORM_FAILED"],
  ["未配置去水印 Token，无法返回可用视频", true, "EXECUTOR_MISCONFIGURED"],
  ["豆包输入框没有真正接收本次提示词（已重试 3 轮；composer=…）", false, "UI_PROMPT_REJECTED"],
  ["图片提交失败：发送后输入框未清空且未出现生成中状态", false, "UI_SUBMIT_UNCONFIRMED"],
  ["图片提交失败：发送后输入框未清空且未出现生成中状态", true, "SUBMIT_UNCERTAIN"],
  ["未能切换到「Seedance 2.0」标准档（档位菜单未生效）", false, "UI_MODE_SWITCH"],
  ["未能切换到豆包图像生成模式；现场=…", false, "UI_MODE_SWITCH"],
  ["无法确认豆包页面已选择 16:9；已停止提交，不使用默认比例替代", false, "UI_PARAM_UNCONFIRMED"],
  ["未确认选中「Seedance 2.0 Fast」，当前模型 未知", false, "UI_PARAM_UNCONFIRMED"],
  ["未能选择请求的视频模型 Seedance 2.0", false, "UI_PARAM_UNCONFIRMED"],
  ["不是允许的媒体参数控件", false, "UI_PARAM_UNCONFIRMED"],
  ["没有找到豆包页面的图片上传控件", false, "REF_UPLOAD_FAILED"],
  ["参考图不存在：D:/x.png", false, "REF_UPLOAD_FAILED"],
  ["豆包页面脚本超时，执行窗口已终止；提交结果可能未知，请勿自动重复生成", false, "PAGE_SCRIPT_TIMEOUT"],
  ["豆包页面脚本超时，执行窗口已终止；提交结果可能未知，请勿自动重复生成", true, "RESULT_CHECK_FAILED"],
  ["豆包主页面加载超时（8 秒），尚未确认页面就绪", false, "PAGE_LOAD"],
  ["豆包主页面加载超时（8 秒），尚未确认页面就绪", true, "RESULT_CHECK_FAILED"],
  ["豆包页面加载失败：ERR_CONNECTION_RESET", false, "PAGE_LOAD"],
  ["豆包页面加载失败：ERR_CONNECTION_RESET", true, "RESULT_CHECK_FAILED"],
  ["等待豆包出图超时，未获取到图片结果", true, "RESULT_TIMEOUT"],
  ["未获取到图片结果", true, "RESULT_MISSING"],
  ["视频已生成，但未捕获到视频直链，无法下载原始视频", true, "RESULT_MISSING"],
  ["下载去水印视频失败：HTTP 403", true, "DOWNLOAD_FAILED"],
  ["下载到的去水印 MP4 文件为空", true, "DOWNLOAD_FAILED"],
  ["去水印接口失败：HTTP 500 upstream（去水印已耗时 120 秒，已重试 3 次）", true, "NOMARK_PARSE"],
  ["分享链接已确认包含视频资源，但去水印服务未识别：bad", true, "NOMARK_PARSE"],
  ["复制出的豆包分享页没有包含当前视频资源", true, "SHARE_PANEL"],
  ["恢复结果失败：未找到可恢复的豆包视频（匹配对话已完成，但视频卡片仍未渲染）", true, "RECOVER_NOT_FOUND"],
  ["豆包执行窗口已关闭，停止本次执行", false, "INTERRUPTED_BEFORE_SUBMIT"],
  ["豆包执行窗口已关闭，停止本次执行", true, "INTERRUPTED_AFTER_SUBMIT"],
  ["执行器重启，任务中断；尚未提交到豆包", false, "INTERRUPTED_BEFORE_SUBMIT"],
  ["执行卡死（长时间无进展），已强制结束", true, "STALLED_AFTER_SUBMIT"],
  ["已放弃，未提交到豆包，已退回预扣额度", false, "ABANDONED"],
  ["something completely unexpected", false, "UNKNOWN_BEFORE_SUBMIT"],
  ["something completely unexpected", true, "UNKNOWN_AFTER_SUBMIT"],
  ["", true, "UNKNOWN_AFTER_SUBMIT"],
  [null, false, "UNKNOWN_BEFORE_SUBMIT"]
];

for (const [message, submitted, expected] of classifyCases) {
  test(`classifyFailure(${submitted ? "submitted" : "not submitted"}): ${String(message).slice(0, 40)} -> ${expected}`, () => {
    assert.equal(classifyFailure(message, submitted), expected);
    assert.ok(ERROR_CODES[expected], `${expected} must be a registered error code`);
  });
}

test("classifyFailure never yields a result-phase code for a request that was not submitted", () => {
  for (const [message] of classifyCases) {
    const code = classifyFailure(message, false);
    assert.ok(!["RESULT_TIMEOUT", "RESULT_CHECK_FAILED", "RESULT_MISSING", "SUBMIT_UNCERTAIN", "UNKNOWN_AFTER_SUBMIT"].includes(code), `${message} -> ${code}`);
  }
});

test("every error code has a known category and label", () => {
  for (const [code, info] of Object.entries(ERROR_CODES)) {
    assert.match(info.category, /^[ABCDEFXU]$/, code);
    assert.ok(info.label.length > 0, code);
  }
});

const flagCases = [
  { name: "interrupted after submit (video) is recoverable, not refunded", input: { code: "INTERRUPTED_AFTER_SUBMIT", submitted: true, quotaRefunded: false, isImage: false, hasThreadUrl: true }, expected: { recoverable: true, retryable: true, retryCostsQuota: true, suggestOtherAccount: false } },
  { name: "interrupted before submit is retryable for free", input: { code: "INTERRUPTED_BEFORE_SUBMIT", submitted: false, quotaRefunded: true, isImage: false, hasThreadUrl: false }, expected: { recoverable: false, retryable: true, retryCostsQuota: false, suggestOtherAccount: false } },
  { name: "image results are never recoverable", input: { code: "RESULT_TIMEOUT", submitted: true, quotaRefunded: false, isImage: true, hasThreadUrl: true }, expected: { recoverable: false, retryable: true, retryCostsQuota: true, suggestOtherAccount: false } },
  { name: "content rejection is not retryable", input: { code: "CONTENT_REJECTED", submitted: true, quotaRefunded: false, isImage: false, hasThreadUrl: true }, expected: { recoverable: false, retryable: false, retryCostsQuota: false, suggestOtherAccount: false } },
  { name: "captcha suggests another account", input: { code: "ACCOUNT_CAPTCHA", submitted: false, quotaRefunded: true, isImage: false, hasThreadUrl: false }, expected: { recoverable: false, retryable: true, retryCostsQuota: false, suggestOtherAccount: true } },
  { name: "uncertain submit without thread url is not recoverable", input: { code: "SUBMIT_UNCERTAIN", submitted: true, quotaRefunded: false, isImage: false, hasThreadUrl: false }, expected: { recoverable: false, retryable: true, retryCostsQuota: true, suggestOtherAccount: false } },
  { name: "invalid params are not retryable", input: { code: "PARAM_INVALID", submitted: false, quotaRefunded: true, isImage: false, hasThreadUrl: false }, expected: { recoverable: false, retryable: false, retryCostsQuota: false, suggestOtherAccount: false } }
];

for (const { name, input, expected } of flagCases) {
  test(`failureFlags: ${name}`, () => {
    assert.deepEqual(failureFlags(input), expected);
  });
}

const phaseCases = [
  ["正在打开豆包执行窗口", "running", null, "opening"],
  ["正在切换到 Seedance 2.0 Fast", "running", "opening", "configuring"],
  ["正在设置比例 16:9", "running", "opening", "configuring"],
  ["正在上传参考图（1/2）", "running", "configuring", "uploading"],
  ["正在填写提示词", "running", "uploading", "prompting"],
  ["正在提交豆包绘制（第 1/2 张）", "running", "prompting", "submitting"],
  ["已记录本次豆包会话", "running", "submitting", "generating"],
  ["已提交豆包，等待视频完成并复制分享链接", "running", "submitting", "generating"],
  ["正在请求去水印服务并验证真实 MP4 地址", "running", "generating", "extracting"],
  ["正在下载无水印原图", "running", "extracting", "downloading"],
  ["豆包绘制中：已捕获 0 张无水印原图", "running", "submitting", "generating"],
  ["视频已生成，正在重试复制分享链接 30s", "running", "generating", "extracting"],
  ["已提交豆包，等待生成完成 120s", "running", "generating", "generating"],
  ["正在定位豆包已生成视频", "running", null, "recovering"],
  ["当前执行窗口未同步完成状态，正在检查该账号最近对话", "running", "generating", "generating"],
  ["一些没有关键词的进度", "running", "extracting", "extracting"],
  ["一些没有关键词的进度", "running", "done", "opening"],
  ["生成完成", "success", "downloading", "done"],
  ["失败", "failed", "generating", "failed"],
  ["排队中", "queued", null, "queued"],
  ["已受理", "accepted", null, "queued"]
];

for (const [message, status, previous, expected] of phaseCases) {
  test(`phaseForProgress: ${message} (${status}) -> ${expected}`, () => {
    assert.equal(phaseForProgress(message, status, previous), expected);
  });
}

test("resolveOrphan refunds only when nothing was submitted", () => {
  const before = resolveOrphan({ reason: "restart", submitted: false });
  assert.equal(before.code, "INTERRUPTED_BEFORE_SUBMIT");
  assert.equal(before.refund, true);
  assert.equal(before.phase, "interrupted");
  assert.equal(classifyFailure(before.message, false), "INTERRUPTED_BEFORE_SUBMIT");

  const after = resolveOrphan({ reason: "heartbeat_lost", submitted: true, doubaoThreadUrl: "https://www.doubao.com/chat/1" });
  assert.equal(after.code, "INTERRUPTED_AFTER_SUBMIT");
  assert.equal(after.refund, false);
  assert.match(after.message, /chat\/1/);
  assert.match(after.message, /找回结果/);
  assert.equal(classifyFailure(after.message, true), "INTERRUPTED_AFTER_SUBMIT");

  const stalled = resolveOrphan({ reason: "stalled", submitted: true, isImage: true });
  assert.equal(stalled.code, "STALLED_AFTER_SUBMIT");
  assert.doesNotMatch(stalled.message, /找回结果/);
  assert.equal(classifyFailure(stalled.message, true), "STALLED_AFTER_SUBMIT");

  const deadline = resolveOrphan({ reason: "deadline", submitted: false });
  assert.equal(deadline.code, "STALLED_BEFORE_SUBMIT");
  assert.equal(classifyFailure(deadline.message, false), "STALLED_BEFORE_SUBMIT");

  const abandonedBefore = resolveOrphan({ reason: "abandoned", submitted: false });
  assert.deepEqual([abandonedBefore.code, abandonedBefore.refund], ["ABANDONED", true]);
  const abandonedAfter = resolveOrphan({ reason: "abandoned", submitted: true });
  assert.deepEqual([abandonedAfter.code, abandonedAfter.refund], ["ABANDONED", false]);
});

test("stall and deadline windows", () => {
  assert.equal(stallLimitMs({ submitted: false, mode: "generate" }), 300_000);
  assert.equal(stallLimitMs({ submitted: true, mode: "generate" }), 600_000);
  assert.equal(stallLimitMs({ submitted: true, mode: "recover" }), 300_000);
  assert.equal(hardDeadlineMs({ mode: "generate", generationTimeoutSeconds: 900 }), 900_000 + 1_200_000);
  assert.equal(hardDeadlineMs({ mode: "recover", generationTimeoutSeconds: 900 }), 1_200_000);
});

test("request option parsing", () => {
  assert.equal(normalizeClientRequestId(undefined), null);
  assert.equal(normalizeClientRequestId("  "), null);
  assert.equal(normalizeClientRequestId(" gen-123#2 "), "gen-123#2");
  assert.throws(() => normalizeClientRequestId("含中文"), /clientRequestId/);
  assert.throws(() => normalizeClientRequestId("x".repeat(129)), /clientRequestId/);

  assert.equal(normalizeQueueTimeoutSeconds(undefined), 600);
  assert.equal(normalizeQueueTimeoutSeconds("5"), 30);
  assert.equal(normalizeQueueTimeoutSeconds(99999), 3600);

  assert.deepEqual(parseAccountIdList("3, 4 4,x"), [3, 4]);
  assert.deepEqual(parseAccountIdList([5, "6", -1, 0]), [5, 6]);
  assert.deepEqual(parseAccountIdList(null), []);

  assert.equal(parseOptionalAccountId(undefined), null);
  assert.equal(parseOptionalAccountId("12"), 12);
  assert.ok(Number.isNaN(parseOptionalAccountId("abc")));
});

test("canFailoverToAnotherAccount: pre-submit page failures move to another account", () => {
  const noModel = "未能选择请求的视频模型 Seedance 2.0 Mini；当前模型=无模型控件；未发送提示词";
  assert.equal(canFailoverToAnotherAccount({ message: noModel, submitted: false, refundableFailure: false }), true);
  assert.equal(canFailoverToAnotherAccount({ message: "未能切换到视频模式", submitted: false, refundableFailure: false }), true);
  assert.equal(canFailoverToAnotherAccount({ message: "页面加载失败 ERR_TIMED_OUT", submitted: false, refundableFailure: false }), true);
});

test("canFailoverToAnotherAccount: never re-bill or retry hopeless requests", () => {
  assert.equal(canFailoverToAnotherAccount({ message: "未能选择请求的视频模型", submitted: true, refundableFailure: false }), false, "submitted: platform may have billed");
  assert.equal(canFailoverToAnotherAccount({ message: "aspect_ratio 参数无效", submitted: false, refundableFailure: false }), false);
  assert.equal(canFailoverToAnotherAccount({ message: "未配置去水印 Token", submitted: false, refundableFailure: false }), false);
  assert.equal(canFailoverToAnotherAccount({ message: "内容违规，无法为你生成", submitted: false, refundableFailure: false }), false);
  assert.equal(canFailoverToAnotherAccount({ message: "任何", submitted: true, refundableFailure: true }), true, "explicit refundable page failure keeps old behaviour");
});
