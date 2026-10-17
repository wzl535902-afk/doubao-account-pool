import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const buildDir = process.env.POOL_TEST_BUILD_DIR
  ? pathToFileURL(path.resolve(process.env.POOL_TEST_BUILD_DIR)).href
  : new URL("../dist-electron", import.meta.url).href;
const {
  extractDoubaoVideoObjectKey,
  normalizeConversationUrl,
  planHistoryFallback,
  isExcludedConversation,
  findResultCollision,
  findEarlierResultCollision,
  resultCollisionMessage,
  ResultCollisionError
} = await import(`${buildDir}/result-guard.js`);
const { classifyFailure, failureFlags } = await import(`${buildDir}/request-lifecycle.js`);

// 2026-10-17 实测事故的真实形态：两条不同签名/清晰度的地址指向同一个对象键。
const LIGHTHOUSE_A =
  "https://v9-artist.vlabvod.com/abc123/68f1e2a0/video/tos/cn/tos-cn-v-9ecd54/228108cf53f94b4eb5d0115a5c2687d7/?a=4066&br=2380&cd=0%7C0%7C0";
const LIGHTHOUSE_B =
  "https://v26-artist.vlabvod.com/zzz999/68f1f000/video/tos/cn/tos-cn-v-9ecd54/228108cf53f94b4eb5d0115a5c2687d7/?a=4066&br=5120&lr=nomark";
const OTHER_VIDEO =
  "https://v9-artist.vlabvod.com/abc123/68f1e2a0/video/tos/cn/tos-cn-v-9ecd54/d4664d471f5949e5bb0335b381a37df2/?a=4066";
const OWN_THREAD = "https://www.doubao.com/chat/38447591813399810";
const LIGHTHOUSE_THREAD = "https://www.doubao.com/chat/38447627828606210";

test("视频对象键：同一视频的不同地址得到同一键；非豆包 CDN 地址返回 null", () => {
  assert.equal(extractDoubaoVideoObjectKey(LIGHTHOUSE_A), "228108cf53f94b4eb5d0115a5c2687d7");
  assert.equal(extractDoubaoVideoObjectKey(LIGHTHOUSE_B), "228108cf53f94b4eb5d0115a5c2687d7");
  assert.equal(extractDoubaoVideoObjectKey(OTHER_VIDEO), "d4664d471f5949e5bb0335b381a37df2");
  for (const value of [null, undefined, "", "https://example.com/a.mp4", "http://127.0.0.1:31423/v1/files/652e9d.mp4"]) {
    assert.equal(extractDoubaoVideoObjectKey(value), null, String(value));
  }
  // 末尾无斜杠、大写也能识别
  assert.equal(
    extractDoubaoVideoObjectKey("https://x.com/video/tos/cn/b/228108CF53F94B4EB5D0115A5C2687D7"),
    "228108cf53f94b4eb5d0115a5c2687d7"
  );
});

test("会话地址归一", () => {
  assert.equal(normalizeConversationUrl(`${OWN_THREAD}?from=share#x`), OWN_THREAD);
  assert.equal(normalizeConversationUrl("https://doubao.com/chat/38447591813399810/"), OWN_THREAD);
  assert.equal(normalizeConversationUrl("https://www.doubao.com/chat"), null);
  assert.equal(normalizeConversationUrl("https://www.doubao.com/thread/abc"), null);
  assert.equal(normalizeConversationUrl(null), null);
});

const planCases = [
  {
    name: "已记录本次会话 → 只查本会话（事故场景：短提示词 + 已有会话地址）",
    input: { ownThreadUrl: OWN_THREAD, currentUrl: LIGHTHOUSE_THREAD, prompt: "短发美女", claimedThreadUrls: [LIGHTHOUSE_THREAD] },
    want: { mode: "strict", conversationUrl: OWN_THREAD }
  },
  {
    name: "已记录本次会话 + 长提示词 → 仍只查本会话",
    input: { ownThreadUrl: `${OWN_THREAD}?x=1`, currentUrl: null, prompt: "黄昏时分的海边灯塔，海浪拍打礁石，镜头缓慢推进", claimedThreadUrls: [] },
    want: { mode: "strict", conversationUrl: OWN_THREAD }
  },
  {
    name: "无会话地址 + 短提示词 → 不扫描",
    input: { ownThreadUrl: null, currentUrl: "https://www.doubao.com/chat", prompt: "短发美女", claimedThreadUrls: [] },
    wantMode: "skip"
  },
  {
    name: "无会话地址 + 长提示词 → 扫描并排除他人会话；当前页属于他人时不作首选",
    input: {
      ownThreadUrl: null,
      currentUrl: LIGHTHOUSE_THREAD,
      prompt: "一只戴着红色围巾的小企鹅在雪地里慢慢走路，镜头跟随",
      claimedThreadUrls: [LIGHTHOUSE_THREAD, `${LIGHTHOUSE_THREAD}?a=1`, null, "", "https://www.doubao.com/chat/111"]
    },
    want: { mode: "scan", preferredUrl: null, excludeConversationUrls: [LIGHTHOUSE_THREAD, "https://www.doubao.com/chat/111"] }
  },
  {
    name: "无会话地址 + 长提示词 → 当前页未被认领时作首选",
    input: {
      ownThreadUrl: null,
      currentUrl: OWN_THREAD,
      prompt: "一只戴着红色围巾的小企鹅在雪地里慢慢走路，镜头跟随",
      claimedThreadUrls: [LIGHTHOUSE_THREAD]
    },
    want: { mode: "scan", preferredUrl: OWN_THREAD, excludeConversationUrls: [LIGHTHOUSE_THREAD] }
  }
];

for (const tc of planCases) {
  test(`兜底规划：${tc.name}`, () => {
    const plan = planHistoryFallback(tc.input);
    if (tc.wantMode) {
      assert.equal(plan.mode, tc.wantMode);
      assert.match(plan.reason, /提示词过短/);
    } else {
      assert.deepEqual(plan, tc.want);
    }
  });
}

test("扫描排除：归一后比较", () => {
  assert.equal(isExcludedConversation(`${LIGHTHOUSE_THREAD}?from=x`, [LIGHTHOUSE_THREAD]), true);
  assert.equal(isExcludedConversation(OWN_THREAD, [LIGHTHOUSE_THREAD]), false);
  assert.equal(isExcludedConversation("not a url", [LIGHTHOUSE_THREAD]), false);
});

test("交付前唯一性：撞上他人已交付的对象键即判定误认", () => {
  const others = [
    { requestId: "doubao-a", urls: [OTHER_VIDEO] },
    { requestId: "doubao-56e7310b77704d9f", urls: [null, LIGHTHOUSE_A] }
  ];
  assert.deepEqual(findResultCollision(LIGHTHOUSE_B, others), {
    requestId: "doubao-56e7310b77704d9f",
    objectKey: "228108cf53f94b4eb5d0115a5c2687d7"
  });
  assert.equal(findResultCollision("https://x.com/video/tos/cn/b/0123456789abcdef0123456789abcdef/", others), null);
  assert.equal(findResultCollision("https://example.com/no-key.mp4", others), null, "提取不到对象键时不误杀");
  assert.equal(findResultCollision(LIGHTHOUSE_B, []), null);
});

test("误认判定只认更早的原主：后来者可找回，原主不受影响", () => {
  const lighthouse = { requestId: "doubao-56e7310b77704d9f", createdAt: "2026-10-17T02:40:10.000Z", urls: [LIGHTHOUSE_A] };
  const portrait = { requestId: "doubao-6dd50e6c2298490b", createdAt: "2026-10-17T02:54:28.000Z", urls: [LIGHTHOUSE_B] };
  const late = findEarlierResultCollision({ createdAt: portrait.createdAt, cleanVideoUrl: LIGHTHOUSE_B }, [lighthouse]);
  assert.equal(late?.requestId, lighthouse.requestId);
  const owner = findEarlierResultCollision({ createdAt: lighthouse.createdAt, cleanVideoUrl: LIGHTHOUSE_A }, [portrait]);
  assert.equal(owner, null);
  // 只有 raw 地址（未去水印）也能判定
  const raw = findEarlierResultCollision({ createdAt: portrait.createdAt, cleanVideoUrl: null, rawVideoUrl: LIGHTHOUSE_B }, [lighthouse]);
  assert.equal(raw?.objectKey, "228108cf53f94b4eb5d0115a5c2687d7");
});

test("误认错误：分类为 RESULT_COLLISION（C 类），已提交 → 可找回、重提要额度", () => {
  const error = new ResultCollisionError({ requestId: "doubao-56e7310b77704d9f", objectKey: "228108cf53f94b4eb5d0115a5c2687d7" });
  assert.equal(error.message, resultCollisionMessage(error.collision));
  assert.equal(classifyFailure(error.message, true), "RESULT_COLLISION");
  // 文案里含“找回/生成”等词，不得被其他规则抢先
  assert.equal(classifyFailure(`恢复结果失败：${error.message}`, true), "RECOVER_NOT_FOUND");
  const flags = failureFlags({ code: "RESULT_COLLISION", submitted: true, quotaRefunded: false, isImage: false, hasThreadUrl: true });
  assert.equal(flags.recoverable, true);
  assert.equal(flags.retryCostsQuota, true);
});
