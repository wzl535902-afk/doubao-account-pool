// 结果防误认（纯函数，无 electron 依赖，便于单测）。
//
// 背景（2026-10-17 实测事故）：生成窗口迟迟未检测到完成时，执行器会“检查该账号最近对话”兜底。
// 旧逻辑在知道本次会话地址的情况下仍会扫描其他会话，并以“页面全文包含提示词”判定归属；
// 豆包侧边栏会列出最近会话标题，短提示词（如“短发美女”）在任何会话页面都能“匹配”，
// 于是把上一个任务（灯塔）的视频当成了本次结果交付。
//
// 两道防线：
// 1. planHistoryFallback：知道本次会话地址时只在本会话里找（与 D10 找回规则一致）；
//    不知道时才扫描，且排除已被其他请求认领的会话；提示词过短则不扫描。
// 2. findResultCollision：交付前校验视频对象键没有交付给过其他请求，撞了就拒收（可找回）。

import { extractDoubaoConversationUrl, normalizeComparableText } from "./doubao-page-state.js";
import { MIN_PROMPT_LENGTH_FOR_FUZZY_RECOVERY } from "./request-lifecycle.js";

const VIDEO_OBJECT_KEY_RE = /\/video\/tos\/[^/?#]+\/[^/?#]+\/([0-9a-f]{32})(?:[/?#]|$)/i;
const CONVERSATION_ID_RE = /^https?:\/\/(?:www\.)?doubao\.com\/chat\/([A-Za-z0-9._~-]+)/i;

/** 豆包视频 CDN 地址里的对象键（同一段视频在不同签名/清晰度地址里不变）。 */
export function extractDoubaoVideoObjectKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const matched = String(url).match(VIDEO_OBJECT_KEY_RE);
  return matched ? matched[1].toLowerCase() : null;
}

/** 会话地址归一为 https://www.doubao.com/chat/<id>（去掉查询串、尾部路径），无法识别返回 null。 */
export function normalizeConversationUrl(value: string | null | undefined): string | null {
  const url = extractDoubaoConversationUrl(value);
  if (!url) return null;
  const matched = url.match(CONVERSATION_ID_RE);
  if (!matched || matched[1] === "chat") return null;
  return `https://www.doubao.com/chat/${matched[1]}`;
}

export type HistoryFallbackPlan =
  | { mode: "strict"; conversationUrl: string }
  | { mode: "scan"; preferredUrl: string | null; excludeConversationUrls: string[] }
  | { mode: "skip"; reason: string };

/**
 * 决定“检查最近对话”兜底怎么做。
 * - ownThreadUrl：提交后记录到的本次会话地址（最可信）。
 * - currentUrl：执行窗口当前地址（可能已被导航走，只作扫描的首选项）。
 * - claimedThreadUrls：其他请求已经认领的会话地址。
 */
export function planHistoryFallback(input: {
  ownThreadUrl: string | null | undefined;
  currentUrl: string | null | undefined;
  prompt: string;
  claimedThreadUrls: Array<string | null | undefined>;
}): HistoryFallbackPlan {
  const own = normalizeConversationUrl(input.ownThreadUrl);
  if (own) return { mode: "strict", conversationUrl: own };
  if (normalizeComparableText(input.prompt || "").length < MIN_PROMPT_LENGTH_FOR_FUZZY_RECOVERY) {
    return {
      mode: "skip",
      reason: `未记录本次豆包会话地址，且提示词过短（少于 ${MIN_PROMPT_LENGTH_FOR_FUZZY_RECOVERY} 字），不扫描其他对话以免误认其他任务的视频`
    };
  }
  const exclude = uniqueConversationUrls(input.claimedThreadUrls);
  const current = normalizeConversationUrl(input.currentUrl);
  return {
    mode: "scan",
    preferredUrl: current && !exclude.includes(current) ? current : null,
    excludeConversationUrls: exclude
  };
}

export function uniqueConversationUrls(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeConversationUrl(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** 扫描候选时用：该会话是否已被其他请求认领。 */
export function isExcludedConversation(url: string | null | undefined, exclude: readonly string[]): boolean {
  const normalized = normalizeConversationUrl(url);
  return Boolean(normalized && exclude.includes(normalized));
}

export interface DeliveredResult {
  requestId: string;
  urls: Array<string | null | undefined>;
}

export interface ResultCollision {
  requestId: string;
  objectKey: string;
}

/** 候选结果的视频对象键是否已交付给其他请求；无法提取对象键时不判定（返回 null）。 */
export function findResultCollision(
  candidateUrl: string | null | undefined,
  others: readonly DeliveredResult[]
): ResultCollision | null {
  const key = extractDoubaoVideoObjectKey(candidateUrl);
  if (!key) return null;
  for (const other of others) {
    if (other.urls.some((url) => extractDoubaoVideoObjectKey(url) === key)) {
      return { requestId: other.requestId, objectKey: key };
    }
  }
  return null;
}

export const RESULT_COLLISION_MESSAGE_PREFIX = "结果校验失败：拿到的视频与其他任务的结果重复";

export function resultCollisionMessage(collision: ResultCollision) {
  return `${RESULT_COLLISION_MESSAGE_PREFIX}（与请求 ${collision.requestId} 相同，视频 ${collision.objectKey.slice(0, 8)}…），疑似误认其他任务的视频，已拒收；可在本次会话中找回结果，不会重新生成`;
}

export class ResultCollisionError extends Error {
  readonly collision: ResultCollision;
  constructor(collision: ResultCollision) {
    super(resultCollisionMessage(collision));
    this.name = "ResultCollisionError";
    this.collision = collision;
  }
}

/**
 * 已成功的请求是否属于“误认”：它的视频与一个更早创建的请求相同（更早者才是原主）。
 * 用于放行对这类请求的“找回”（回到本次会话重新读取，不重新生成、不扣额度）。
 */
export function findEarlierResultCollision(
  request: { createdAt: string; cleanVideoUrl?: string | null; rawVideoUrl?: string | null },
  others: ReadonlyArray<DeliveredResult & { createdAt: string }>
): ResultCollision | null {
  const earlier = others.filter((other) => other.createdAt < request.createdAt);
  return (
    findResultCollision(request.cleanVideoUrl ?? null, earlier) ??
    findResultCollision(request.rawVideoUrl ?? null, earlier)
  );
}
