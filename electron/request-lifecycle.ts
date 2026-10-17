/**
 * 请求生命周期纯函数（执行器协议 v2）。
 *
 * 这里不依赖 Electron / SQLite，便于单测：
 * - 错误分类：把执行器里五花八门的中文失败文案归一成稳定错误码（A–F 类）。
 * - 阶段推断：把进度文案映射成细粒度 workflow_phase，供画布/账号管理统一展示。
 * - 孤儿处置：执行器重启、心跳丢失、卡死时，如何安全地收尾一个请求。
 *
 * 三条铁律（见 docs/执行器协议v2.md）：
 * 1. 幂等：同一 clientRequestId 只生成一次。
 * 2. 心跳：执行中每 15 秒写 heartbeat_at；超过 3 分钟无心跳视为孤儿。
 * 3. 已提交不自动重生：submitted_at 非空后，任何自动流程都不得重新生成，只能“找回结果”。
 */

export type WorkflowPhase =
  | "queued"
  | "opening"
  | "configuring"
  | "uploading"
  | "prompting"
  | "submitting"
  | "generating"
  | "extracting"
  | "downloading"
  | "recovering"
  | "done"
  | "failed"
  | "interrupted";

export const WORKFLOW_PHASES: readonly WorkflowPhase[] = [
  "queued",
  "opening",
  "configuring",
  "uploading",
  "prompting",
  "submitting",
  "generating",
  "extracting",
  "downloading",
  "recovering",
  "done",
  "failed",
  "interrupted"
];

/**
 * A 账号  B 页面/UI  C 结果获取  D 中断/卡死  E 参数/协议  F 平台/内容  X 用户放弃  U 未知
 */
export type ErrorCategory = "A" | "B" | "C" | "D" | "E" | "F" | "X" | "U";

export interface ErrorCodeInfo {
  category: ErrorCategory;
  label: string;
}

export const ERROR_CODES = {
  ACCOUNT_LOGGED_OUT: { category: "A", label: "账号未登录或登录已失效" },
  ACCOUNT_CAPTCHA: { category: "A", label: "账号触发验证码/风控" },
  ACCOUNT_WORK_PAGE: { category: "A", label: "账号是豆包工作版，不支持该模型" },
  ACCOUNT_UNAVAILABLE: { category: "A", label: "指定账号当前不可用" },
  ACCOUNT_NO_SUBSCRIPTION: { category: "A", label: "账号未开通会员，不支持该档位" },
  NO_ACCOUNT: { category: "A", label: "没有可用账号" },
  NO_ACCOUNT_QUOTA: { category: "A", label: "所有账号额度不足" },
  NO_ACCOUNT_LOGIN: { category: "A", label: "没有已登录的账号" },
  QUEUE_TIMEOUT: { category: "A", label: "排队超时，始终没有空闲账号" },

  UI_MODE_SWITCH: { category: "B", label: "未能切换到生成模式" },
  UI_PARAM_UNCONFIRMED: { category: "B", label: "生成参数未能确认选中" },
  UI_PROMPT_REJECTED: { category: "B", label: "输入框未接收提示词" },
  UI_SUBMIT_UNCONFIRMED: { category: "B", label: "未确认提交成功" },
  REF_UPLOAD_FAILED: { category: "B", label: "参考图上传失败" },
  PAGE_LOAD: { category: "B", label: "豆包页面加载失败" },
  PAGE_SCRIPT_TIMEOUT: { category: "B", label: "页面脚本超时（窗口无响应）" },

  SUBMIT_UNCERTAIN: { category: "U", label: "提交状态不确定，可能已提交" },
  RESULT_TIMEOUT: { category: "C", label: "等待生成结果超时" },
  RESULT_CHECK_FAILED: { category: "C", label: "已提交，检查结果时页面异常" },
  RESULT_MISSING: { category: "C", label: "已完成但未拿到结果地址" },
  NOMARK_PARSE: { category: "C", label: "未能解析无水印原片" },
  SHARE_PANEL: { category: "C", label: "未能复制分享链接" },
  DOWNLOAD_FAILED: { category: "C", label: "结果下载失败" },
  RECOVER_NOT_FOUND: { category: "C", label: "找回失败，未定位到已生成结果" },

  INTERRUPTED_BEFORE_SUBMIT: { category: "D", label: "执行器中断（未提交，已退额度）" },
  INTERRUPTED_AFTER_SUBMIT: { category: "D", label: "执行器中断（已提交，可找回）" },
  STALLED_BEFORE_SUBMIT: { category: "D", label: "执行卡死（未提交，已退额度）" },
  STALLED_AFTER_SUBMIT: { category: "D", label: "执行卡死（已提交，可找回）" },

  PARAM_INVALID: { category: "E", label: "请求参数无效" },
  EXECUTOR_MISCONFIGURED: { category: "E", label: "执行器配置缺失（如去水印 Token）" },

  CONTENT_REJECTED: { category: "F", label: "内容未通过审核" },
  PLATFORM_DAILY_LIMIT: { category: "F", label: "账号今日生成次数已达上限" },
  PLATFORM_FAILED: { category: "F", label: "豆包返回生成失败" },

  ABANDONED: { category: "X", label: "已放弃" },

  UNKNOWN_BEFORE_SUBMIT: { category: "U", label: "未知错误（未提交）" },
  UNKNOWN_AFTER_SUBMIT: { category: "U", label: "未知错误（已提交）" }
} as const satisfies Record<string, ErrorCodeInfo>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

export function errorInfo(code: string | null | undefined): ErrorCodeInfo {
  if (isErrorCode(code)) return ERROR_CODES[code];
  return { category: "U", label: "未知错误" };
}

/** 文案里出现即判定为工作版账号（与 media-compatibility.ts 的 WORK_MEDIA_UNSUPPORTED 保持一致）。 */
const WORK_PAGE_PATTERN = /豆包工作|飞书个人版/;

interface Rule {
  pattern: RegExp;
  code: ErrorCode | ((submitted: boolean) => ErrorCode);
}

/** 顺序即优先级：越具体越靠前。 */
const RULES: Rule[] = [
  { pattern: /^放弃|已放弃/, code: "ABANDONED" },
  { pattern: /^恢复结果失败|未找到可恢复/, code: "RECOVER_NOT_FOUND" },
  { pattern: /执行卡死|无进展/, code: (s) => (s ? "STALLED_AFTER_SUBMIT" : "STALLED_BEFORE_SUBMIT") },
  {
    pattern: /执行器重启|执行器中断|进程重启|心跳丢失|任务中断|执行窗口已关闭/,
    code: (s) => (s ? "INTERRUPTED_AFTER_SUBMIT" : "INTERRUPTED_BEFORE_SUBMIT")
  },
  { pattern: /验证码|人机验证|安全验证|风控|访问过于频繁|操作频繁/, code: "ACCOUNT_CAPTCHA" },
  { pattern: WORK_PAGE_PATTERN, code: "ACCOUNT_WORK_PAGE" },
  { pattern: /未开通会员|订阅对话框|需要订阅/, code: "ACCOUNT_NO_SUBSCRIPTION" },
  { pattern: /未登录|登录已失效|登录失效|重新登录|需要登录/, code: "ACCOUNT_LOGGED_OUT" },
  { pattern: /请求没有分配账号|分配账号不存在|指定账号/, code: "ACCOUNT_UNAVAILABLE" },
  { pattern: /排队超时/, code: "QUEUE_TIMEOUT" },
  { pattern: /额度不足|没有剩余额度/, code: "NO_ACCOUNT_QUOTA" },
  { pattern: /没有可用(?:的)?账号|无可用账号/, code: "NO_ACCOUNT" },
  { pattern: /次数已(?:经)?达(?:到)?上限|今日.*(?:上限|用完)|额度已用完/, code: "PLATFORM_DAILY_LIMIT" },
  { pattern: /违规|审核|不符合.*规范|敏感|无法为你生成|不能生成该/, code: "CONTENT_REJECTED" },
  { pattern: /返回(?:了)?生成失败|生成失败提示/, code: "PLATFORM_FAILED" },
  { pattern: /未配置去水印 ?Token|未配置.*Token/i, code: "EXECUTOR_MISCONFIGURED" },
  { pattern: /aspect_ratio|NOT NULL|参数(?:无效|错误)|不支持的模型|prompt is required|时长必须/i, code: "PARAM_INVALID" },
  { pattern: /输入框没有(?:真正)?接收|提示词未写入/, code: "UI_PROMPT_REJECTED" },
  { pattern: /没看到提交确认|未确认提交|提交失败|提交后未|发送按钮/, code: "UI_SUBMIT_UNCONFIRMED" },
  { pattern: /未能切换|切换到.*模式失败|切换.*失败|未进入.*模式/, code: "UI_MODE_SWITCH" },
  { pattern: /未确认选中|无法确认|未能选择|未能选中|不是允许的/, code: "UI_PARAM_UNCONFIRMED" },
  { pattern: /参考图|上传控件|上传失败/, code: "REF_UPLOAD_FAILED" },
  { pattern: /页面脚本超时/, code: "PAGE_SCRIPT_TIMEOUT" },
  { pattern: /出图超时|等待.*超时|生成超时/, code: (s) => (s ? "RESULT_TIMEOUT" : "UNKNOWN_BEFORE_SUBMIT") },
  { pattern: /未捕获到|未获取到|未返回.*(?:地址|图片|视频)|未拿到.*(?:地址|结果)/, code: "RESULT_MISSING" },
  { pattern: /下载/, code: "DOWNLOAD_FAILED" },
  { pattern: /去水印|无水印|nomark/i, code: "NOMARK_PARSE" },
  { pattern: /分享/, code: "SHARE_PANEL" },
  { pattern: /页面加载(?:失败|超时)|加载豆包页面|loadURL|ERR_[A-Z_]+|长时间无响应/, code: "PAGE_LOAD" },
  { pattern: /超时/, code: (s) => (s ? "RESULT_TIMEOUT" : "UNKNOWN_BEFORE_SUBMIT") }
];

/** 已提交后，这些“页面类”错误实际意味着“检查结果失败”，任务本身可能已在豆包生成。 */
const POST_SUBMIT_REMAP: Partial<Record<ErrorCode, ErrorCode>> = {
  UI_MODE_SWITCH: "RESULT_CHECK_FAILED",
  UI_PARAM_UNCONFIRMED: "RESULT_CHECK_FAILED",
  UI_PROMPT_REJECTED: "SUBMIT_UNCERTAIN",
  UI_SUBMIT_UNCONFIRMED: "SUBMIT_UNCERTAIN",
  REF_UPLOAD_FAILED: "RESULT_CHECK_FAILED",
  PAGE_LOAD: "RESULT_CHECK_FAILED",
  PAGE_SCRIPT_TIMEOUT: "RESULT_CHECK_FAILED",
  UNKNOWN_BEFORE_SUBMIT: "UNKNOWN_AFTER_SUBMIT"
};

/** 未提交时，这些“结果类”错误不可能成立，降级为未知（未提交）。 */
const PRE_SUBMIT_REMAP: Partial<Record<ErrorCode, ErrorCode>> = {
  RESULT_TIMEOUT: "UNKNOWN_BEFORE_SUBMIT",
  RESULT_CHECK_FAILED: "UNKNOWN_BEFORE_SUBMIT",
  RESULT_MISSING: "UNKNOWN_BEFORE_SUBMIT",
  NOMARK_PARSE: "UNKNOWN_BEFORE_SUBMIT",
  SHARE_PANEL: "UNKNOWN_BEFORE_SUBMIT",
  DOWNLOAD_FAILED: "UNKNOWN_BEFORE_SUBMIT",
  SUBMIT_UNCERTAIN: "UNKNOWN_BEFORE_SUBMIT",
  UNKNOWN_AFTER_SUBMIT: "UNKNOWN_BEFORE_SUBMIT"
};

export function classifyFailure(message: string | null | undefined, submitted: boolean): ErrorCode {
  const text = String(message ?? "").trim();
  let code: ErrorCode = submitted ? "UNKNOWN_AFTER_SUBMIT" : "UNKNOWN_BEFORE_SUBMIT";
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      code = typeof rule.code === "function" ? rule.code(submitted) : rule.code;
      break;
    }
  }
  if (submitted) return POST_SUBMIT_REMAP[code] ?? code;
  return PRE_SUBMIT_REMAP[code] ?? code;
}

export interface FailureFlags {
  /** 可在原豆包会话里“找回结果”（不重新生成、不再扣额度）。 */
  recoverable: boolean;
  /** 重新提交（新 attempt）是合理动作。 */
  retryable: boolean;
  /** 重新提交会额外消耗额度（已提交且未退额度）。 */
  retryCostsQuota: boolean;
  /** 建议换号重提。 */
  suggestOtherAccount: boolean;
}

export function failureFlags(input: {
  code: string | null | undefined;
  submitted: boolean;
  quotaRefunded: boolean;
  isImage: boolean;
  hasThreadUrl: boolean;
}): FailureFlags {
  const info = errorInfo(input.code);
  const code = input.code ?? "";
  const recoverable =
    input.submitted &&
    !input.isImage &&
    (info.category === "C" || info.category === "D" || info.category === "U") &&
    (input.hasThreadUrl || code !== "SUBMIT_UNCERTAIN");
  const retryable =
    info.category !== "E" &&
    info.category !== "X" &&
    code !== "CONTENT_REJECTED" &&
    code !== "EXECUTOR_MISCONFIGURED";
  const suggestOtherAccount =
    (info.category === "A" && code !== "QUEUE_TIMEOUT") ||
    code === "PLATFORM_DAILY_LIMIT" ||
    code === "PAGE_SCRIPT_TIMEOUT" ||
    code === "ACCOUNT_NO_SUBSCRIPTION";
  return {
    recoverable,
    retryable,
    retryCostsQuota: retryable && input.submitted && !input.quotaRefunded,
    suggestOtherAccount
  };
}

/** 顺序即优先级。注意“正在下载无水印原图”应归为 downloading 而不是 extracting。 */
const PHASE_RULES: Array<[RegExp, WorkflowPhase]> = [
  [/恢复|找回|定位豆包已生成/, "recovering"],
  [/排队/, "queued"],
  [/打开豆包执行窗口|打开执行窗口|正在打开/, "opening"],
  [/填写提示词|写入提示词/, "prompting"],
  [/上传参考图/, "uploading"],
  [/正在提交/, "submitting"],
  [/已记录本次豆包会话|已提交豆包|等待|生成中|绘制中|出图中|最近对话/, "generating"],
  [/正在下载|保存到本地|已保存/, "downloading"],
  [/去水印|无水印|分享|解析|视频地址/, "extracting"],
  [/切换|比例|时长|选中|模型|参数/, "configuring"]
];

export function phaseForProgress(
  message: string | null | undefined,
  status: string,
  previous: string | null | undefined
): WorkflowPhase {
  if (status === "success") return "done";
  if (status === "failed" || status === "stopped") return "failed";
  if (status === "queued") return "queued";
  const text = String(message ?? "");
  for (const [pattern, phase] of PHASE_RULES) {
    if (pattern.test(text)) return phase;
  }
  if (previous && (WORKFLOW_PHASES as readonly string[]).includes(previous) && previous !== "done" && previous !== "failed" && previous !== "interrupted") {
    return previous as WorkflowPhase;
  }
  return status === "accepted" ? "queued" : "opening";
}

export type OrphanReason = "restart" | "heartbeat_lost" | "stalled" | "deadline" | "abandoned";

export interface OrphanResolution {
  code: ErrorCode;
  refund: boolean;
  phase: WorkflowPhase;
  message: string;
}

const ORPHAN_REASON_TEXT: Record<OrphanReason, string> = {
  restart: "执行器重启，任务中断",
  heartbeat_lost: "执行器心跳丢失，任务中断",
  stalled: "执行卡死（长时间无进展），已强制结束",
  deadline: "执行卡死（超过最长执行时间），已强制结束",
  abandoned: "已放弃"
};

/**
 * 孤儿/卡死/放弃时的收尾策略。
 * 未提交：退额度，可安全重提。已提交：不退额度（豆包已扣次数），不自动重生，只能找回。
 */
export function resolveOrphan(input: {
  reason: OrphanReason;
  submitted: boolean;
  doubaoThreadUrl?: string | null;
  isImage?: boolean;
}): OrphanResolution {
  const head = ORPHAN_REASON_TEXT[input.reason];
  if (input.reason === "abandoned") {
    return {
      code: "ABANDONED",
      refund: !input.submitted,
      phase: "failed",
      message: input.submitted ? "已放弃（任务已提交到豆包，额度不退回）" : "已放弃，未提交到豆包，已退回预扣额度"
    };
  }
  const stalled = input.reason === "stalled" || input.reason === "deadline";
  if (!input.submitted) {
    return {
      code: stalled ? "STALLED_BEFORE_SUBMIT" : "INTERRUPTED_BEFORE_SUBMIT",
      refund: true,
      phase: "interrupted",
      message: `${head}；尚未提交到豆包，已退回预扣额度，可安全重新提交`
    };
  }
  const thread = input.doubaoThreadUrl ? `（会话 ${input.doubaoThreadUrl}）` : "";
  const next = input.isImage ? "可重新提交（会再次消耗额度）" : "未自动重新生成，可「找回结果」";
  return {
    code: stalled ? "STALLED_AFTER_SUBMIT" : "INTERRUPTED_AFTER_SUBMIT",
    refund: false,
    phase: "interrupted",
    message: `${head}；任务已提交到豆包${thread}，${next}`
  };
}

/** 卡死判定窗口：未提交 5 分钟无进展（含多张参考图上传）；已提交 10 分钟无进展（去水印重试与下载可能较慢）。 */
export function stallLimitMs(input: { submitted: boolean; mode: "generate" | "recover" }) {
  if (input.mode === "recover") return 5 * 60_000;
  return input.submitted ? 10 * 60_000 : 5 * 60_000;
}

/** 单次执行硬上限：生成超时 + 20 分钟余量；找回 20 分钟。 */
export function hardDeadlineMs(input: { mode: "generate" | "recover"; generationTimeoutSeconds: number }) {
  if (input.mode === "recover") return 20 * 60_000;
  return Math.max(60, input.generationTimeoutSeconds) * 1000 + 20 * 60_000;
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const ORPHAN_HEARTBEAT_STALE_MS = 3 * 60_000;
export const ABORT_GRACE_MS = 20_000;
export const DEFAULT_QUEUE_TIMEOUT_SECONDS = 600;
export const MAX_QUEUE_TIMEOUT_SECONDS = 3600;

/** 找回时按提示词模糊匹配历史对话的最短长度；更短的提示词极易误认别人的视频。 */
export const MIN_PROMPT_LENGTH_FOR_FUZZY_RECOVERY = 12;

export function normalizeQueueTimeoutSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUEUE_TIMEOUT_SECONDS;
  return Math.min(MAX_QUEUE_TIMEOUT_SECONDS, Math.max(30, Math.round(parsed)));
}

export function parseAccountIdList(value: unknown): number[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : value == null
        ? []
        : [value];
  const ids = items
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  return Array.from(new Set(ids));
}

export function parseOptionalAccountId(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
}

/** clientRequestId：1–128 个可见 ASCII 字符。 */
export function normalizeClientRequestId(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 128 || !/^[\x21-\x7e]+$/.test(text)) {
    throw new Error("clientRequestId 必须是 1–128 个可见 ASCII 字符");
  }
  return text;
}
