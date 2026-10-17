/**
 * 执行看门狗（执行器协议 v2，D9）。
 *
 * 背景：CDP sendCommand / webContents.insertText 等调用没有超时保护，渲染进程卡死时
 * 会让一次执行永远挂起，账号一直 busy、额度一直被占用（2026-10-16 事故 doubao-3dc60c85）。
 *
 * 做法：每次执行都在 RunRegistry.run() 里进行，并通过 AsyncLocalStorage 携带 RunContext：
 * - 每 15 秒心跳（写 heartbeat_at），同时检查“无进展”与“硬上限”；
 * - 判定卡死后 abort：销毁执行窗口（让挂起的页面调用尽快报错），并最多再等 grace 毫秒，
 *   之后无论原流程是否返回都释放执行槽位；
 * - abort 后原流程的任何进度写入都会抛 RunAbortedError，收尾只由 onAbort 统一执行一次，
 *   避免双重退款或状态被覆盖。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RunMode = "generate" | "recover";
export type AbortReason = "stalled" | "deadline" | "abandoned";

export interface DestroyableWindow {
  isDestroyed(): boolean;
  destroy(): void;
}

export interface RunContext {
  readonly requestId: string;
  readonly mode: RunMode;
  readonly startedAt: number;
  lastProgressAt: number;
  submitted: boolean;
  aborted: boolean;
  abortReason: AbortReason | null;
  windows: Set<DestroyableWindow>;
}

export class RunAbortedError extends Error {
  constructor(readonly requestId: string, readonly reason: AbortReason | null) {
    super(`执行已被看门狗终止（${reason ?? "unknown"}）`);
    this.name = "RunAbortedError";
  }
}

export interface RunRegistryOptions {
  now?: () => number;
  heartbeatIntervalMs: number;
  abortGraceMs: number;
  stallLimitMs: (ctx: RunContext) => number;
  hardDeadlineMs: (ctx: RunContext) => number;
  onHeartbeat?: (ctx: RunContext) => void;
  /** abort 后统一收尾（只调用一次）。抛错会被吞掉并打印。 */
  onAbort: (ctx: RunContext, reason: AbortReason) => void | Promise<void>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

interface RunEntry {
  ctx: RunContext;
  abort: (reason: AbortReason) => void;
}

export class RunRegistry {
  private readonly storage = new AsyncLocalStorage<RunContext>();
  private readonly runs = new Map<string, RunEntry>();
  private readonly now: () => number;

  constructor(private readonly options: RunRegistryOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  current(): RunContext | undefined {
    return this.storage.getStore();
  }

  isActive(requestId: string) {
    return this.runs.has(requestId);
  }

  activeRequestIds() {
    return Array.from(this.runs.keys());
  }

  get(requestId: string): RunContext | undefined {
    return this.runs.get(requestId)?.ctx;
  }

  /** 记录一次进度（重置“无进展”计时）。若本次执行已被终止则抛 RunAbortedError。 */
  touch() {
    const ctx = this.current();
    if (!ctx) return;
    if (ctx.aborted) throw new RunAbortedError(ctx.requestId, ctx.abortReason);
    ctx.lastProgressAt = this.now();
  }

  /** 若当前执行已被终止则抛 RunAbortedError。 */
  assertLive() {
    const ctx = this.current();
    if (ctx?.aborted) throw new RunAbortedError(ctx.requestId, ctx.abortReason);
  }

  markSubmitted() {
    const ctx = this.current();
    if (ctx) ctx.submitted = true;
  }

  registerWindow(win: DestroyableWindow) {
    const ctx = this.current();
    if (!ctx) return;
    ctx.windows.add(win);
    if (ctx.aborted) destroyQuietly(win);
  }

  abort(requestId: string, reason: AbortReason) {
    const entry = this.runs.get(requestId);
    if (!entry) return false;
    entry.abort(reason);
    return true;
  }

  async run(requestId: string, mode: RunMode, work: () => Promise<void>): Promise<void> {
    if (this.runs.has(requestId)) {
      throw new Error(`请求 ${requestId} 已在执行中`);
    }
    const setIntervalFn = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const clearIntervalFn = this.options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    const setTimeoutFn = this.options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const startedAt = this.now();
    const ctx: RunContext = {
      requestId,
      mode,
      startedAt,
      lastProgressAt: startedAt,
      submitted: false,
      aborted: false,
      abortReason: null,
      windows: new Set()
    };

    let releaseAfterGrace: () => void = () => undefined;
    const graceElapsed = new Promise<"aborted">((resolve) => {
      releaseAfterGrace = () => resolve("aborted");
    });
    const abort = (reason: AbortReason) => {
      if (ctx.aborted) return;
      ctx.aborted = true;
      ctx.abortReason = reason;
      for (const win of ctx.windows) destroyQuietly(win);
      setTimeoutFn(releaseAfterGrace, this.options.abortGraceMs);
    };
    this.runs.set(requestId, { ctx, abort });

    const timer = setIntervalFn(() => {
      if (ctx.aborted) return;
      try {
        this.options.onHeartbeat?.(ctx);
      } catch (error) {
        console.warn("写入执行心跳失败", requestId, error);
      }
      const now = this.now();
      if (now - ctx.lastProgressAt > this.options.stallLimitMs(ctx)) abort("stalled");
      else if (now - ctx.startedAt > this.options.hardDeadlineMs(ctx)) abort("deadline");
    }, this.options.heartbeatIntervalMs);

    try {
      const workDone = this.storage.run(ctx, work).then(
        () => "done" as const,
        (error) => {
          if (ctx.aborted || error instanceof RunAbortedError) return "done" as const;
          throw error;
        }
      );
      await Promise.race([workDone, graceElapsed]);
    } finally {
      clearIntervalFn(timer);
      if (this.runs.get(requestId)?.ctx === ctx) this.runs.delete(requestId);
      if (ctx.aborted) {
        try {
          await this.options.onAbort(ctx, ctx.abortReason ?? "stalled");
        } catch (error) {
          console.error("看门狗收尾失败", requestId, error);
        }
      }
    }
  }
}

function destroyQuietly(win: DestroyableWindow) {
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* 窗口可能已被销毁 */
  }
}
