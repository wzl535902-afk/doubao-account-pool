import type { ApiRequest, OperationLog } from "./types.js";
import { isImageModel } from "./types.js";
import { errorInfo, failureFlags } from "./request-lifecycle.js";

/** 旧版公开视图（保持字段不变，兼容现有调用方）。 */
export function toPublicApiRequest(request: ApiRequest) {
  return {
    requestId: request.requestId,
    status: request.status,
    message: request.message,
    model: request.model,
    cleanVideoUrl: request.cleanVideoUrl,
    outputVideoPath: request.outputVideoPath,
    imageUrls: request.imageUrls,
    outputImagePaths: request.outputImagePaths,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds ?? null,
    resolution: request.resolution,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    finishedAt: request.finishedAt
  };
}

export type QuotaState = "none" | "reserved" | "consumed" | "refunded";

export interface PoolJobViewOptions {
  logs?: OperationLog[];
  /** 执行器内存中是否仍在跟踪（排队/执行/等待重试）。 */
  tracked?: boolean;
  idempotentReplay?: boolean;
}

/**
 * 执行器协议 v2 的请求视图：toPublicApiRequest 的超集（旧字段一个不少），
 * 额外提供阶段、提交标记、心跳、错误分类与可执行动作，供 31423/Go 映射为 JobView。
 */
export function toPoolJobView(request: ApiRequest, options: PoolJobViewOptions = {}) {
  const isImage = isImageModel(request.model);
  const submitted = Boolean(request.submittedAt);
  const active = request.status === "queued" || request.status === "accepted" || request.status === "running";
  const quotaState: QuotaState = request.accountId == null || request.status === "queued"
    ? "none"
    : request.quotaRefunded
      ? "refunded"
      : active && !submitted
        ? "reserved"
        : "consumed";
  const error = request.status === "failed" || request.status === "stopped"
    ? (() => {
        const info = errorInfo(request.errorCode);
        return {
          code: request.errorCode ?? (submitted ? "UNKNOWN_AFTER_SUBMIT" : "UNKNOWN_BEFORE_SUBMIT"),
          category: info.category,
          label: info.label,
          message: request.message,
          ...failureFlags({
            code: request.errorCode,
            submitted,
            quotaRefunded: request.quotaRefunded ?? false,
            isImage,
            hasThreadUrl: Boolean(request.doubaoThreadUrl)
          })
        };
      })()
    : null;
  return {
    ...toPublicApiRequest(request),
    protocol: "pool-v2" as const,
    kind: isImage ? "image" as const : "video" as const,
    source: request.source,
    clientRequestId: request.clientRequestId ?? null,
    parentRequestId: request.parentRequestId ?? null,
    accountId: request.accountId,
    accountName: request.accountName,
    retryCount: request.retryCount ?? 0,
    phase: request.workflowPhase && request.workflowPhase !== "prepared" ? request.workflowPhase : null,
    submitted,
    submittedAt: request.submittedAt ?? null,
    heartbeatAt: request.heartbeatAt ?? null,
    queueDeadlineAt: request.queueDeadlineAt ?? null,
    doubaoThreadUrl: request.doubaoThreadUrl,
    rawVideoUrl: request.rawVideoUrl,
    prompt: request.prompt,
    referenceImageCount: request.referenceImagePaths?.length ?? (request.referenceImagePath ? 1 : 0),
    imageCount: request.imageCount,
    quotaState,
    errorCode: request.errorCode ?? null,
    error,
    actions: {
      canAbandon: request.status === "queued" || (active && !submitted),
      canRecover: Boolean(error?.recoverable) && request.accountId != null && !options.tracked,
      canRetry: Boolean(error?.retryable)
    },
    tracked: options.tracked ?? undefined,
    idempotentReplay: options.idempotentReplay ?? undefined,
    logs: options.logs?.map((log) => ({
      at: log.createdAt,
      action: log.action,
      status: log.status,
      message: log.message,
      targetUrl: log.targetUrl,
      accountId: log.accountId
    }))
  };
}

export type PoolJobView = ReturnType<typeof toPoolJobView>;
