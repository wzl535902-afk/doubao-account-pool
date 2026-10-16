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
export type ApiRequestStatus = "accepted" | "running" | "success" | "failed" | "stopped";
export type OperationLogStatus = "info" | "success" | "failed";

export interface Account {
  id: number;
  name: string;
  partition: string;
  remark: string;
  loginStatus: LoginStatus;
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
  imageUrls: string[] | null;
  outputImagePaths: string[] | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
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
}

export interface ApiRequestUpdateInput {
  requestId: string;
  status?: ApiRequestStatus;
  message?: string;
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
}
