/**
 * 请求监管（执行器协议 v2）：
 * - 启动清扫：执行器重启后，内存队列已丢失，accepted/running 的请求都是孤儿；
 * - 周期清扫：心跳超过 3 分钟且不在执行器内存中的请求视为孤儿；
 * - 排队派发：queued 请求在账号释放时按 FIFO 选号、预扣、入队；超时或不可能满足时失败；
 * - 放弃：按“未开始 / 执行中未提交 / 已提交”三种情况安全收尾。
 *
 * 孤儿收尾规则（铁律 3）：未提交 → 失败并退额度，可安全重提；已提交 → 失败但不退额度、
 * 不自动重新生成，由上层决定是否“找回结果”。
 */
import type { AppDatabase } from "./database.js";
import type { AbandonOutcome } from "./executor.js";
import type { ApiRequest } from "./types.js";
import { isImageModel } from "./types.js";
import { ORPHAN_HEARTBEAT_STALE_MS, resolveOrphan, type OrphanReason } from "./request-lifecycle.js";

export interface SupervisedExecutor {
  isTracked(requestId: string): boolean;
  enqueue(requestId: string): void;
  abandon(requestId: string): AbandonOutcome;
}

export interface RequestSupervisorOptions {
  database: AppDatabase;
  executor: SupervisedExecutor;
  /** 请求状态变化（通知界面 + 回调）。 */
  onRequestChanged: (request: ApiRequest) => void;
  now?: () => number;
  dispatchIntervalMs?: number;
  sweepIntervalMs?: number;
  heartbeatStaleMs?: number;
}

export type AbandonResult =
  | { httpStatus: 200; request: ApiRequest; alreadyFinished: boolean }
  | { httpStatus: 202; request: ApiRequest }
  | { httpStatus: 404 }
  | { httpStatus: 409; request: ApiRequest; code: "ABANDON_AFTER_SUBMIT" };

export class RequestSupervisor {
  private dispatchTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: RequestSupervisorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  start() {
    this.stop();
    this.dispatchTimer = setInterval(() => this.safely("派发排队请求", () => this.dispatchQueued()), this.options.dispatchIntervalMs ?? 5000);
    this.sweepTimer = setInterval(() => this.safely("清扫孤儿请求", () => this.sweepOrphans("heartbeat_lost")), this.options.sweepIntervalMs ?? 60_000);
  }

  stop() {
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.dispatchTimer = null;
    this.sweepTimer = null;
  }

  /**
   * 清扫孤儿请求。restart：所有 accepted/running 都是孤儿；heartbeat_lost：仅处理
   * 不在执行器内存中、且心跳（或最后更新时间）超过阈值的请求。
   */
  sweepOrphans(reason: Extract<OrphanReason, "restart" | "heartbeat_lost">): ApiRequest[] {
    const { database, executor } = this.options;
    const staleMs = this.options.heartbeatStaleMs ?? ORPHAN_HEARTBEAT_STALE_MS;
    const finalized: ApiRequest[] = [];
    for (const request of database.listActiveApiRequests()) {
      if (request.status === "queued") continue;
      if (executor.isTracked(request.requestId)) continue;
      if (reason === "heartbeat_lost") {
        const last = Date.parse(request.heartbeatAt || request.updatedAt || request.createdAt);
        if (Number.isFinite(last) && this.now() - last < staleMs) continue;
      }
      const resolution = resolveOrphan({
        reason,
        submitted: Boolean(request.submittedAt),
        doubaoThreadUrl: request.doubaoThreadUrl,
        isImage: isImageModel(request.model)
      });
      const updated = database.finalizeApiRequest({
        requestId: request.requestId,
        expectStatuses: ["accepted", "running"],
        message: resolution.message,
        errorCode: resolution.code,
        workflowPhase: resolution.phase,
        refund: resolution.refund,
        releaseAccount: true
      });
      if (!updated) continue;
      database.appendOperationLog({
        requestId: updated.requestId,
        accountId: updated.accountId,
        action: reason === "restart" ? "启动清扫" : "心跳清扫",
        status: "failed",
        message: updated.message
      });
      finalized.push(updated);
      this.options.onRequestChanged(updated);
    }
    const released = database.releaseOrphanBusyAccounts();
    for (const accountId of released) {
      database.appendOperationLog({
        accountId,
        action: reason === "restart" ? "启动清扫" : "心跳清扫",
        status: "info",
        message: "账号标记为忙碌但没有进行中的请求，已恢复空闲"
      });
    }
    if (finalized.length || released.length) this.dispatchQueued();
    return finalized;
  }

  /** 按 FIFO 派发排队请求。同步执行，无重入问题。 */
  dispatchQueued(): ApiRequest[] {
    const { database, executor } = this.options;
    const settings = database.getSettings();
    const dispatched: ApiRequest[] = [];
    for (const request of database.listQueuedApiRequests()) {
      const deadline = request.queueDeadlineAt ? Date.parse(request.queueDeadlineAt) : NaN;
      if (Number.isFinite(deadline) && this.now() > deadline) {
        this.failQueued(request, "QUEUE_TIMEOUT", "排队超时：等待期间始终没有空闲账号，未扣额度，可稍后重新提交");
        continue;
      }
      if (!settings.executorEnabled) continue;
      const result = database.dispatchQueuedRequest(request.requestId);
      if (result) {
        database.appendOperationLog({
          requestId: request.requestId,
          accountId: result.account.id,
          action: "分配账号",
          status: "success",
          message: result.request.message
        });
        executor.enqueue(request.requestId);
        dispatched.push(result.request);
        this.options.onRequestChanged(result.request);
        continue;
      }
      const availability = database.describeAccountAvailability(request.model, {
        accountId: request.preferredAccountId ?? null,
        excludeAccountIds: request.excludeAccountIds ?? null
      });
      if (!availability.available && !availability.couldBecomeAvailable) {
        this.failQueued(request, availability.code, `${availability.message}，排队已取消，未扣额度`);
      }
    }
    return dispatched;
  }

  abandon(requestId: string): AbandonResult {
    const { database, executor } = this.options;
    const request = database.getApiRequest(requestId);
    if (!request) return { httpStatus: 404 };
    if (request.status === "success" || request.status === "failed" || request.status === "stopped") {
      return { httpStatus: 200, request, alreadyFinished: true };
    }
    if (request.status === "queued") {
      const updated = this.failQueued(request, "ABANDONED", "已放弃（排队中，未扣额度）");
      return updated
        ? { httpStatus: 200, request: updated, alreadyFinished: false }
        : { httpStatus: 200, request: database.getApiRequest(requestId)!, alreadyFinished: true };
    }
    if (request.submittedAt) {
      return { httpStatus: 409, request, code: "ABANDON_AFTER_SUBMIT" };
    }
    const outcome = executor.abandon(requestId);
    if (outcome === "submitted") {
      return { httpStatus: 409, request: database.getApiRequest(requestId)!, code: "ABANDON_AFTER_SUBMIT" };
    }
    if (outcome === "aborting") {
      // 看门狗会销毁执行窗口并统一收尾（退额度），调用方轮询即可。
      database.appendOperationLog({
        requestId,
        accountId: request.accountId,
        action: "放弃任务",
        status: "info",
        message: "正在终止执行（尚未提交到豆包）"
      });
      return { httpStatus: 202, request: database.getApiRequest(requestId)! };
    }
    // dequeued / not_active：尚未开始执行，直接收尾并退额度。
    const resolution = resolveOrphan({ reason: "abandoned", submitted: false });
    const updated = database.finalizeApiRequest({
      requestId,
      expectStatuses: ["accepted", "running"],
      message: resolution.message,
      errorCode: resolution.code,
      workflowPhase: resolution.phase,
      refund: resolution.refund,
      releaseAccount: true
    });
    if (updated) {
      database.appendOperationLog({
        requestId,
        accountId: updated.accountId,
        action: "放弃任务",
        status: "failed",
        message: updated.message
      });
      this.options.onRequestChanged(updated);
      this.dispatchQueued();
      return { httpStatus: 200, request: updated, alreadyFinished: false };
    }
    return { httpStatus: 200, request: database.getApiRequest(requestId)!, alreadyFinished: true };
  }

  private failQueued(request: ApiRequest, code: Parameters<AppDatabase["finalizeApiRequest"]>[0]["errorCode"], message: string) {
    const updated = this.options.database.finalizeApiRequest({
      requestId: request.requestId,
      expectStatuses: ["queued"],
      message,
      errorCode: code,
      workflowPhase: "failed",
      refund: false,
      releaseAccount: false
    });
    if (!updated) return null;
    this.options.database.appendOperationLog({
      requestId: request.requestId,
      action: code === "ABANDONED" ? "放弃任务" : "排队结束",
      status: "failed",
      message
    });
    this.options.onRequestChanged(updated);
    return updated;
  }

  private safely(label: string, fn: () => unknown) {
    try {
      fn();
    } catch (error) {
      console.error(`${label}失败`, error);
    }
  }
}
