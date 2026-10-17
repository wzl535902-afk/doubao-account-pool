export type MediaPageKind = "unknown" | "consumer" | "work";
export type LoginStatus = "unknown" | "logged_in" | "logged_out";
export type AccountRuntimeStatus = "idle" | "busy" | "error" | "login_required";
export type DoubaoVideoModel = "seedance_2_0_mini" | "seedance_2_0_fast" | "seedance_2_0";
export type DoubaoImageModel = "seedream_5_0_flash" | "seedream_5_0_pro" | "seedream_5_0_lite" | "seedream_4_5" | "seedream_4_0";
export type DoubaoModel = DoubaoVideoModel | DoubaoImageModel;

/** 图像模型 id → 豆包页面「模型」控件显示名（以运行时枚举核对为准） */
export const IMAGE_PAGE_MODEL_NAMES: Record<DoubaoImageModel, string> = {
  seedream_5_0_flash: "Seedream 5.0 Flash",
  seedream_5_0_pro: "Seedream 5.0 Pro",
  seedream_5_0_lite: "Seedream 5.0 Lite",
  seedream_4_5: "Seedream 4.5",
  seedream_4_0: "Seedream 4.0"
};

export function isImageModel(model: string): model is DoubaoImageModel {
  return model in IMAGE_PAGE_MODEL_NAMES;
}

export function modelCost(
  settings: { miniCost: number; fastCost: number; standardCost: number; imageCost: number },
  model: DoubaoModel
): number {
  if (isImageModel(model)) return Math.max(1, settings.imageCost);
  if (model === "seedance_2_0_mini") return settings.miniCost;
  if (model === "seedance_2_0") return settings.standardCost;
  return settings.fastCost;
}
/**
 * queued: 已受理但暂无空闲账号，未选号、未扣额度，等待调度器派发（执行器协议 v2）。
 * accepted: 已选号并预扣额度，等待执行槽位。
 */
export type ApiRequestStatus = "queued" | "accepted" | "running" | "success" | "failed" | "stopped";
export type OperationLogStatus = "info" | "success" | "failed";

export interface Account {
  id: number;
  name: string;
  partition: string;
  remark: string;
  loginStatus: LoginStatus;
  /** UI capability only; does not change authentication or quota. */
  mediaPageKind?: MediaPageKind;
  currentStatus: AccountRuntimeStatus;
  dailyQuotaLimit: number;
  quotaRemaining: number;
  quotaUsedToday: number;
  lastUsedAt: string | null;
  /** 冷却退避截止时间（池宪法④；null=未冷却）。 */
  cooldownUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCreateInput {
  remark?: string;
}

export interface AccountUpdateInput {
  id: number;
  remark?: string;
  loginStatus?: LoginStatus;
  mediaPageKind?: MediaPageKind;
  currentStatus?: AccountRuntimeStatus;
  dailyQuotaLimit?: number;
  quotaRemaining?: number;
  quotaUsedToday?: number;
}

export interface AppSettings {
  apiServiceEnabled: boolean;
  apiPort: number;
  apiKey: string;
  executorEnabled: boolean;
  showExecutorWindow: boolean;
  autoCloseExecutorWindow: boolean;
  doubaoChatUrl: string;
  defaultModel: DoubaoModel;
  dailyQuotaLimit: number;
  miniCost: number;
  fastCost: number;
  standardCost: number;
  imageCost: number;
  dailyResetTime: string;
  generationTimeoutSeconds: number;
  maxConcurrentAccounts: number;
  retryCount: number;
  /** 选号模式：sticky=粘性优先（成功账号连续复用）；lru=均衡轮换（最久未用优先）。 */
  accountSelectionMode: "sticky" | "lru";
  /** 失败账号冷却退避秒数（0=关闭）。 */
  accountCooldownSeconds: number;
  /** 单次请求失败后自动换号重试上限（0=不换号）。 */
  requestRetryLimit: number;
  autoRemoveWatermark: boolean;
  watermarkApiUrl: string;
  watermarkApiToken: string;
  outputDir: string;
}

export type AppSettingsUpdateInput = Partial<AppSettings>;

export interface ApiRequest {
  id: number;
  requestId: string;
  source: string;
  model: DoubaoModel;
  accountId: number | null;
  accountName: string | null;
  accountPartition: string | null;
  /** 已换号重试次数（池宪法④）。 */
  retryCount?: number;
  status: ApiRequestStatus;
  message: string;
  prompt: string;
  referenceImagePath: string | null;
  referenceImagePaths: string[] | null;
  removeWatermark: boolean;
  callbackUrl: string | null;
  doubaoThreadUrl: string | null;
  rawVideoUrl: string | null;
  cleanVideoUrl: string | null;
  outputVideoPath: string | null;
  aspectRatio: string | null;
  resolution: string | null;
  imageCount: number;
  durationSeconds?: number | null;
  imageUrls: string[] | null;
  outputImagePaths: string[] | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** 执行器协议 v2：调用方幂等键（如 `<goTaskId>#<attemptNo>`），全局唯一。 */
  clientRequestId?: string | null;
  /** 执行器协议 v2：由哪个请求重提而来（审计链）。 */
  parentRequestId?: string | null;
  /** 细粒度阶段，见 request-lifecycle.ts WorkflowPhase。 */
  workflowPhase?: string | null;
  /** 已把提示词提交给豆包的时间；非空即“已提交”，之后绝不自动重新生成。 */
  submittedAt?: string | null;
  /** 执行中的心跳时间（每 15 秒），用于识别僵尸任务。 */
  heartbeatAt?: string | null;
  /** 稳定错误码，见 request-lifecycle.ts ERROR_CODES。 */
  errorCode?: string | null;
  /** 预扣额度是否已退回。 */
  quotaRefunded?: boolean;
  /** queued 状态的排队截止时间。 */
  queueDeadlineAt?: string | null;
  /** queued 状态派发时只能使用的账号（严格指定）。 */
  preferredAccountId?: number | null;
  /** queued 状态派发时需要排除的账号。 */
  excludeAccountIds?: number[] | null;
}

export interface ApiRequestCreateInput {
  requestId: string;
  source?: string;
  model: DoubaoModel;
  accountId?: number | null;
  status: ApiRequestStatus;
  message?: string;
  prompt: string;
  referenceImagePath?: string | null;
  referenceImagePaths?: string[] | null;
  removeWatermark?: boolean;
  callbackUrl?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  imageCount?: number;
  durationSeconds?: number | null;
  clientRequestId?: string | null;
  parentRequestId?: string | null;
  workflowPhase?: string | null;
  errorCode?: string | null;
  quotaRefunded?: boolean;
  queueDeadlineAt?: string | null;
  preferredAccountId?: number | null;
  excludeAccountIds?: number[] | null;
}

export interface ApiRequestUpdateInput {
  requestId: string;
  status?: ApiRequestStatus;
  message?: string;
  workflowPhase?: string | null;
  errorCode?: string | null;
  quotaRefunded?: boolean;
  doubaoThreadUrl?: string | null;
  rawVideoUrl?: string | null;
  cleanVideoUrl?: string | null;
  outputVideoPath?: string | null;
  imageUrls?: string[] | null;
  outputImagePaths?: string[] | null;
}

export interface OperationLog {
  id: number;
  requestId: string | null;
  accountId: number | null;
  accountName: string | null;
  accountPartition: string | null;
  action: string;
  status: OperationLogStatus;
  message: string;
  targetUrl: string | null;
  createdAt: string;
}

export interface OperationLogCreateInput {
  requestId?: string | null;
  accountId?: number | null;
  action: string;
  status?: OperationLogStatus;
  message: string;
  targetUrl?: string | null;
}

export interface ApiServerStatus {
  version: string;
  enabled: boolean;
  running: boolean;
  port: number;
  url: string | null;
  message: string;
}

export interface GenerateRequestBody {
  durationSeconds?: number | string | null;
  duration?: number | string | null;
  model?: DoubaoModel;
  prompt: string;
  referenceImagePath?: string | null;
  referenceImagePaths?: string[] | null;
  referenceImageUrl?: string | null;
  removeWatermark?: boolean;
  callbackUrl?: string | null;
  source?: string;
    aspectRatio?: string | null;
  resolution?: string | null;
  count?: number;
  n?: number;
  /** 执行器协议 v2：幂等键。相同键重复提交只返回已有请求，不会二次生成或扣额度。 */
  clientRequestId?: string | null;
  /** 执行器协议 v2：重提来源请求 ID。 */
  parentRequestId?: string | null;
  /** 执行器协议 v2：严格指定账号；不可用时排队或直接失败，不会换号。 */
  accountId?: number | string | null;
  /** 执行器协议 v2：本次不使用的账号。 */
  excludeAccountIds?: Array<number | string> | string | null;
  /** 执行器协议 v2：无空闲账号时是否排队（带 clientRequestId 时默认 true）。 */
  queue?: boolean | string | null;
  /** 执行器协议 v2：排队最长秒数，默认 600，最大 3600。 */
  queueTimeoutSeconds?: number | string | null;
}
