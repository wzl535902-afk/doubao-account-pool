import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, clipboard } from "electron";
import type { AppDatabase } from "./database.js";
import { AccountTaskScheduler } from "./account-scheduler.js";
import {
  extractDoubaoConversationUrl,
  extractDoubaoFailureMessage,
  extractDoubaoShareUrl,
  getNewDoubaoVideoUrls,
  hasNewGenerationCompletion,
  hasNewPromptOccurrence,
  hasNewTextOccurrence,
  isDoubaoDesktopDownloadPrompt,
  isDoubaoGenerationComplete,
  isDoubaoPromptRewritePage,
  isGenerationReadyForShare,
  isQuotaNotChargedFailure,
  normalizeComparableText
} from "./doubao-page-state.js";
import {
  extractFallbackApis,
  formatNomarkMeta,
  resolveUnwatermarkedVideo,
  type NomarkVideoInfo
} from "./doubao-nomark.js";
import { toPoolJobView } from "./public-api.js";
import { RunAbortedError, RunRegistry, type AbortReason, type RunContext } from "./run-watchdog.js";
import {
  ABORT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  MIN_PROMPT_LENGTH_FOR_FUZZY_RECOVERY,
  canFailoverToAnotherAccount,
  classifyFailure,
  errorInfo,
  hardDeadlineMs,
  phaseForProgress,
  resolveOrphan,
  stallLimitMs,
  type ErrorCode
} from "./request-lifecycle.js";
import { loadUrl, withPageDeadline } from "./page-runtime.js";
import { inspectMediaPageKind, mediaEntryClickScript, mediaControlOpenScript, mediaMenuOptionClickScript, requestedVideoModelSelected, WORK_MEDIA_UNSUPPORTED } from "./media-compatibility.js";
import { applyVideoDuration, videoDurationProbeScript, videoDurationChooseScript, applyVideoAspectRatio } from "./video-duration.js";
import type { Account, ApiRequest, ApiRequestStatus, AppSettings, DoubaoImageModel, DoubaoModel } from "./types.js";
import { IMAGE_PAGE_MODEL_NAMES, isImageModel } from "./types.js";
import { resolveCleanVideoUrl, verifyDoubaoShareVideoResource } from "./watermark.js";
import {
  findResultCollision,
  isExcludedConversation,
  planHistoryFallback,
  ResultCollisionError,
  resultCollisionMessage,
  type HistoryFallbackPlan
} from "./result-guard.js";

type DataChangedCallback = () => void;
type QueueItem = {
  key: string;
  requestId: string;
  accountId: number;
  mode: "generate" | "recover";
};

type ShareRecoveryResult = {
  shareUrl: string | null;
  directVideoUrl: string | null;
  cleanVideoUrl: string | null;
  nomarkInfo: NomarkVideoInfo | null;
  candidateCount: number;
  promptMatchCount: number;
  generatedMatchCount: number;
  shareFailureReason: string | null;
};

type ShareCopyResult = {
  shareUrl: string | null;
  reason: string | null;
};

class DoubaoPageFailureError extends Error {
  constructor(message: string, readonly refundQuota: boolean) {
    super(message);
    this.name = "DoubaoPageFailureError";
  }
}

class AsyncMutex {
  private tail = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// Electron's clipboard is process-wide. Serializing share-copy operations prevents
// parallel account windows from overwriting each other's sentinel or copied URL.
const clipboardMutex = new AsyncMutex();
const SHARE_PANEL_WAIT_MS = 3500;
const CLIPBOARD_WAIT_MS = 2800;
const CALLBACK_TIMEOUT_MS = 5000;
const VIDEO_CARD_WAIT_MS = 25000;
const callbackQueues = new Map<string, Promise<void>>();

export interface ExecutorHooks {
  /** 每次执行（含被看门狗终止）结束、执行槽位释放后调用；用于派发排队请求。 */
  onRunSettled?: () => void;
}

export type AbandonOutcome = "aborting" | "dequeued" | "submitted" | "not_active";

export class DoubaoExecutor {
  private readonly scheduler: AccountTaskScheduler<QueueItem>;
  /** 执行看门狗：心跳、卡死检测、强制终止（D9）。 */
  readonly runs: RunRegistry;

  constructor(
    private readonly database: AppDatabase,
    private readonly onDataChanged: DataChangedCallback,
    private readonly hooks: ExecutorHooks = {}
  ) {
    this.runs = new RunRegistry({
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      abortGraceMs: ABORT_GRACE_MS,
      stallLimitMs: (ctx) => stallLimitMs({ submitted: ctx.submitted, mode: ctx.mode }),
      hardDeadlineMs: (ctx) => hardDeadlineMs({
        mode: ctx.mode,
        generationTimeoutSeconds: this.database.getSettings().generationTimeoutSeconds
      }),
      onHeartbeat: (ctx) => this.database.touchApiRequestHeartbeat(ctx.requestId),
      onAbort: (ctx, reason) => this.finalizeAbortedRun(ctx, reason)
    });
    this.scheduler = new AccountTaskScheduler(
      () => this.database.getSettings().maxConcurrentAccounts,
      async (item) => {
        try {
          await this.runs.run(item.requestId, item.mode, () =>
            item.mode === "recover" ? this.recoverResult(item.requestId) : this.execute(item.requestId)
          );
        } finally {
          // 在调度器释放该账号槽位之后再通知，便于立刻派发排队请求。
          setImmediate(() => this.hooks.onRunSettled?.());
        }
      },
      (error) => console.error("豆包并行执行器异常", error)
    );
  }

  /** 请求是否在执行器内存中（排队、执行或等待重试）。 */
  isTracked(requestId: string) {
    return this.scheduler.has(requestId) || this.runs.isActive(requestId);
  }

  isRunning(requestId: string) {
    return this.runs.isActive(requestId);
  }

  /**
   * 放弃一个请求：未开始的从队列移除（调用方负责收尾退款），执行中且未提交的强制终止
   * （看门狗统一收尾并退款），已提交的拒绝（铁律 3：已提交只能等待或找回）。
   */
  abandon(requestId: string): AbandonOutcome {
    const ctx = this.runs.get(requestId);
    if (ctx) {
      const request = this.database.getApiRequest(requestId);
      if (ctx.submitted || request?.submittedAt) return "submitted";
      this.runs.abort(requestId, "abandoned");
      return "aborting";
    }
    if (this.scheduler.remove(requestId)) return "dequeued";
    return "not_active";
  }

  /** 看门狗终止后的唯一收尾入口：只在请求仍处于 accepted/running 时写入，避免覆盖已完成结果。 */
  private finalizeAbortedRun(ctx: RunContext, reason: AbortReason) {
    const request = this.database.getApiRequest(ctx.requestId);
    if (!request) return;
    const submitted = ctx.mode === "recover" || ctx.submitted || Boolean(request.submittedAt);
    const resolution = resolveOrphan({
      reason,
      submitted,
      doubaoThreadUrl: request.doubaoThreadUrl,
      isImage: isImageModel(request.model)
    });
    const message = ctx.mode === "recover" ? `恢复结果失败：${resolution.message}` : resolution.message;
    const finalized = this.database.finalizeApiRequest({
      requestId: ctx.requestId,
      expectStatuses: ["accepted", "running"],
      message,
      errorCode: ctx.mode === "recover" && reason !== "abandoned" ? "RECOVER_NOT_FOUND" : resolution.code,
      workflowPhase: resolution.phase,
      refund: ctx.mode !== "recover" && resolution.refund,
      releaseAccount: true
    });
    if (!finalized) return;
    this.database.appendOperationLog({
      requestId: ctx.requestId,
      accountId: finalized.accountId,
      action: reason === "abandoned" ? "放弃任务" : "看门狗终止",
      status: "failed",
      message: finalized.message
    });
    this.onDataChanged();
    postCallback(finalized);
  }

  /** 记录“已提交到豆包”。之后失败不自动退款/重生（铁律 3）。必须在点击发送之前调用。 */
  private markSubmitted(requestId: string) {
    this.runs.assertLive();
    this.runs.markSubmitted();
    this.database.markApiRequestSubmitted(requestId);
  }

  enqueue(requestId: string) {
    this.enqueueItem(requestId, "generate");
  }

  enqueueRecovery(requestId: string) {
    this.enqueueItem(requestId, "recover");
  }

  private enqueueItem(requestId: string, mode: QueueItem["mode"]) {
    const request = this.database.getApiRequest(requestId);
    if (!request?.accountId) return false;
    return this.scheduler.enqueue({
      key: requestId,
      requestId,
      accountId: request.accountId,
      mode
    });
  }

  private async recoverResult(requestId: string) {
    const request = this.database.getApiRequest(requestId);
    if (!request?.accountId) return;
    if (isImageModel(request.model)) {
      console.warn("图片请求不支持找回结果", requestId);
      return;
    }
    if (request.status === "queued" || request.status === "accepted" || request.status === "running") {
      console.warn("请求仍在进行中，跳过找回", requestId, request.status);
      return;
    }
    // 找回只针对已提交的请求（API 已拒绝明确未提交的请求）。v2 之前的历史记录没有 submitted_at，
    // 在此补记，保证找回失败后仍可再次找回、且不会被当作“未提交”退款。
    if (!request.submittedAt) this.database.markApiRequestSubmitted(requestId);

    const account = this.database.getAccount(request.accountId);
    if (!account) return;

    const settings = this.database.getSettings();
    let win: BrowserWindow | null = null;

    try {
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在定位豆包已生成视频并重试复制分享链接"
      });
      this.database.updateAccount({ id: account.id, currentStatus: "busy" });

      win = this.createExecutionWindow(account, settings);
      await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
      await waitForDoubaoPageSettled(win);
      await dismissDoubaoDesktopDownloadPrompt(win);

      if (await looksLoggedOut(win)) {
        throw new Error("豆包账号未登录，无法恢复视频结果");
      }

      // D10：有会话地址时只在该会话里找回，绝不按提示词去别的对话里“认领”视频；
      // 没有会话地址时才按提示词匹配，且提示词过短时拒绝（极易误认其他任务的视频）。
      const threadUrl = extractDoubaoConversationUrl(request.doubaoThreadUrl);
      if (!threadUrl && normalizeComparableText(request.prompt).length < MIN_PROMPT_LENGTH_FOR_FUZZY_RECOVERY) {
        throw new Error(
          `未找到可恢复的豆包视频：没有记录本次豆包会话地址，且提示词过短（少于 ${MIN_PROMPT_LENGTH_FOR_FUZZY_RECOVERY} 字），无法安全定位，已停止以免误认其他任务的视频`
        );
      }
      await this.updateProgress({
        requestId,
        status: "running",
        message: threadUrl ? "正在打开本次豆包会话找回结果" : "未记录会话地址，正在按提示词定位豆包已生成视频"
      });
      const recovery = await findGeneratedConversationAndCopyShare(
        win,
        request.prompt,
        threadUrl,
        { strict: Boolean(threadUrl) }
      );
      const recoveredThreadUrl = recovery.conversationUrl || threadUrl || request.doubaoThreadUrl;
      if (recovery.cleanVideoUrl) {
        // 页面数据直接解析到无水印原片（与正常生成同一路径），无需分享链接。
        this.assertResultUnique(requestId, recovery.cleanVideoUrl);
        this.recordOperation(
          requestId,
          "解析无水印原片",
          "success",
          `找回：已从豆包获取无水印原画（${formatNomarkMeta(recovery.nomarkInfo)}）`,
          recovery.cleanVideoUrl
        );
        const recoveredPath = await downloadCleanVideoIfNeeded(settings, requestId, recovery.cleanVideoUrl);
        await this.updateProgress({
          requestId,
          status: "success",
          message: recoveredPath
            ? `已恢复结果，无水印原画已保存到本地（${formatNomarkMeta(recovery.nomarkInfo)}）`
            : `已恢复结果，无水印原片地址已获取（${formatNomarkMeta(recovery.nomarkInfo)}）`,
          doubaoThreadUrl: recoveredThreadUrl,
          rawVideoUrl: null,
          cleanVideoUrl: recovery.cleanVideoUrl,
          outputVideoPath: recoveredPath,
          errorCode: null
        });
        this.database.updateAccount({ id: account.id, currentStatus: "idle" });
        this.database.clearAccountCooldown(account.id);
        return;
      }
      if (!recovery.shareUrl) {
        throw new Error(
          `未找到可恢复的豆包视频：${threadUrl ? "已打开本次会话" : `历史链接 ${recovery.candidateCount} 条`}，提示词匹配 ${recovery.promptMatchCount} 条，确认已生成 ${recovery.generatedMatchCount} 条，仍未拿到无水印原片或分享链接${recovery.shareFailureReason ? `（${recovery.shareFailureReason}）` : ""}`
        );
      }
      this.recordOperation(
        requestId,
        "复制分享地址",
        "success",
        "已复制并确认豆包分享页包含视频资源",
        recovery.shareUrl
      );
      const resolvedVideo = await this.resolveCleanVideoForVerifiedShare(
        requestId,
        settings,
        recovery.shareUrl
      );
      const shareUrl = resolvedVideo.shareUrl;
      const cleanVideo = resolvedVideo.cleanVideo;
      const cleanVideoUrl = cleanVideo.url;
      this.assertResultUnique(requestId, cleanVideoUrl);
      const outputVideoPath = await downloadCleanVideoIfNeeded(settings, requestId, cleanVideoUrl);
      await this.updateProgress({
        requestId,
        status: "success",
        message: outputVideoPath
          ? `已恢复结果，去水印 MP4 已验证并保存到本地（${formatWatermarkResolution(cleanVideo)}）`
          : `已恢复结果，去水印 MP4 地址已验证（${formatWatermarkResolution(cleanVideo)}）`,
        // 保留会话地址（找回/排障依赖它）；分享地址记录在操作日志里。
        doubaoThreadUrl: recoveredThreadUrl || shareUrl,
        rawVideoUrl: null,
        cleanVideoUrl,
        outputVideoPath,
        errorCode: null
      });
      this.database.updateAccount({ id: account.id, currentStatus: "idle" });
      this.database.clearAccountCooldown(account.id);
    } catch (error) {
      if (error instanceof RunAbortedError || this.runs.current()?.aborted) return;
      const message = errorMessage(error);
      // 账号类原因（未登录/验证码）保留原错误码，便于上层提示“先处理账号”；其余统一为找回失败。
      const innerCode = classifyFailure(message, true);
      await this.failRequest(
        request,
        `恢复结果失败：${message}`,
        false,
        errorInfo(innerCode).category === "A" || innerCode === "RESULT_COLLISION" ? innerCode : "RECOVER_NOT_FOUND"
      );
      this.database.updateAccount({
        id: account.id,
        currentStatus: /未登录|登录/.test(message) ? "login_required" : "idle"
      });
      this.onDataChanged();
    } finally {
      if (win && !win.isDestroyed()) win.close();
    }
  }

  private async execute(requestId: string) {
    const request = this.database.getApiRequest(requestId);
    if (!request) return;
    // 只执行 accepted 的请求：防止重复入队、放弃后残留或重启清扫后的请求被再次生成。
    if (request.status !== "accepted") {
      console.warn("跳过非 accepted 状态的请求", requestId, request.status);
      return;
    }

    if (!request.accountId) {
      await this.failRequest(request, "请求没有分配账号", false);
      return;
    }

    const account = this.database.getAccount(request.accountId);
    if (!account) {
      await this.failRequest(request, "分配账号不存在", false);
      return;
    }

    const settings = this.database.getSettings();
    let win: BrowserWindow | null = null;
    let submittedToDoubao = false;
    let accountBlocked = false; // 账号被阻断（未登录/验证码）：不亮窗、不保活，处置统一走「账号管理」

    try {
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在打开豆包执行窗口"
      });
      this.database.updateAccount({ id: account.id, currentStatus: "busy" });

      win = this.createExecutionWindow(account, settings);
      await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
      await waitForDoubaoPageSettled(win);
      await dismissDoubaoDesktopDownloadPrompt(win);

      if (await looksLoggedOut(win)) {
        this.database.updateAccount({
          id: account.id,
          loginStatus: "logged_out",
          currentStatus: "login_required"
        });
        accountBlocked = true;
        throw new Error("豆包账号未登录，请到「账号管理」重新登录该账号后再试");
      }

      const mediaPageKind = await inspectMediaPageKind(win.webContents);
      if (mediaPageKind !== "unknown") this.database.updateAccount({ id: account.id, mediaPageKind });
      if (mediaPageKind === "work") {
        // Stop before references, draft text or send. A known-incompatible
        // profile is excluded by future media selections, not logged out.
        throw new DoubaoPageFailureError(WORK_MEDIA_UNSUPPORTED, true);
      }
      if (isImageModel(request.model)) {
        await this.runImagePipeline(request, account, settings, win, () => {
          this.markSubmitted(requestId);
          submittedToDoubao = true;
        });
        this.database.updateAccount({ id: account.id, currentStatus: "idle" });
        this.database.clearAccountCooldown(account.id);
        if (settings.autoCloseExecutorWindow) win.close();
        return;
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在切换豆包视频生成模式"
      });
      await activateVideoMode(win, request.model);
      type VideoPoint = { duration: number; aspectRatio: string | null; x: number; y: number };
      const readVideoParameters = () => runPageScript<VideoPoint | null>(win!, videoDurationProbeScript("control"));
      const openVideoParameters = async () => {
        const opened = await runPageScript<boolean>(win!, mediaControlOpenScript("视频参数"));
        if (opened) { await wait(400); return true; }
        const point = await readVideoParameters();
        if (!point) return false;
        await sendMouseClick(win!, point.x, point.y);
        await wait(400);
        return true;
      };
      if (request.durationSeconds != null) {
        await this.updateProgress({ requestId, status: "running", message: `正在确认视频时长 ${request.durationSeconds} 秒` });
        await applyVideoDuration(request.durationSeconds, {
          read: async () => (await readVideoParameters())?.duration ?? null,
          open: openVideoParameters,
          choose: async duration => {
            const chosen = await runPageScript<boolean>(win!, videoDurationChooseScript(duration));
            await wait(400);
            return chosen;
          }
        });
      }
      await applyVideoAspectRatio(request.aspectRatio, {
        read: async () => (await readVideoParameters())?.aspectRatio ?? null,
        open: openVideoParameters,
        choose: async ratio => {
          const chosen = await runPageScript<boolean>(win!, mediaMenuOptionClickScript(ratio));
          await wait(400);
          return chosen;
        }
      });
      // Ratio updates must not reset the previously verified duration.
      await applyVideoDuration(request.durationSeconds, {
        read: async () => (await readVideoParameters())?.duration ?? null,
        open: async () => false,
        choose: async () => false
      });

      const referenceImagePaths = request.referenceImagePaths?.length
        ? request.referenceImagePaths
        : request.referenceImagePath
          ? [request.referenceImagePath]
          : [];
      if (referenceImagePaths.length) {
        await this.updateProgress({
          requestId,
          status: "running",
          message: `正在上传参考图（共 ${referenceImagePaths.length} 张）`
        });
        await uploadReferenceImages(win, referenceImagePaths);
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在填写提示词"
      });
      await fillPrompt(win, request.prompt);

      // 提交前最后核验：输入框必须有内容（冷窗口竞态兜底，最多再补种两次）
      for (let guard = 0; guard < 2; guard += 1) {
        const preflight = await inspectComposer(win, request.prompt);
        if (preflight.textLength > 0) break;
        await wait(1500);
        await fillPrompt(win, request.prompt);
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在提交豆包生成"
      });
      const generationBaseline = await inspectGenerationPage(win);
      // Once a send action is attempted, a lost renderer response is ambiguous.
      // Do not refund/retry automatically merely because the acknowledgement was lost.
      this.markSubmitted(requestId);
      submittedToDoubao = true;
      await submitPromptAndWait(win, request.model, request.prompt);
      await confirmVideoGenerationIfNeeded(win);
      const submittedConversationUrl = await waitForSubmittedConversationUrl(win);
      if (submittedConversationUrl) {
        await this.updateProgress({
          requestId,
          status: "running",
          message: "已记录本次豆包会话地址，等待视频完成",
          doubaoThreadUrl: submittedConversationUrl
        });
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "已提交豆包，等待视频完成并复制分享链接"
      });

      const generationResult = await waitForGenerationResult(
        win,
        settings.generationTimeoutSeconds,
        generationBaseline.pageText,
        generationBaseline.videoUrls,
        generationBaseline.playableVideoCount,
        generationBaseline.videoCardCount,
        request.prompt,
        submittedConversationUrl,
        async (message) => {
        await this.updateProgress({ requestId, status: "running", message });
        },
        () => this.database.listClaimedThreadUrls(requestId)
      );

      if (!request.removeWatermark) {
        // 未启用去水印：直接下载豆包视频直链（原始视频，含水印）
        const rawVideoUrl = generationResult.directVideoUrl || null;
        if (!rawVideoUrl) {
          throw new Error("视频已生成，但未捕获到视频直链，无法下载原始视频");
        }
        this.assertResultUnique(requestId, rawVideoUrl);
        const rawOutputVideoPath = await downloadRawVideoIfNeeded(settings, requestId, rawVideoUrl);
        await this.updateProgress({
          requestId,
          status: "success",
          message: rawOutputVideoPath
            ? "视频生成完成（原始视频，未去水印），已保存到本地"
            : "视频生成完成（原始视频，未去水印），已获取视频直链（未配置保存目录）",
          doubaoThreadUrl: generationResult.shareUrl,
          rawVideoUrl,
          cleanVideoUrl: null,
          outputVideoPath: rawOutputVideoPath
        });
        this.database.updateAccount({ id: account.id, currentStatus: "idle" });
        this.database.clearAccountCooldown(account.id);
        if (settings.autoCloseExecutorWindow) {
          win.close();
        }
        return;
      }

      if (!generationResult.cleanVideoUrl) {
        throw new Error(
          `视频已生成，但无水印原片解析失败（已整页重载重试 2 次）${generationResult.shareFailureReason ? `；分享兜底：${generationResult.shareFailureReason}` : ""}`
        );
      }

      const unwatermarkedUrl = generationResult.cleanVideoUrl;
      this.assertResultUnique(requestId, unwatermarkedUrl);
      this.recordOperation(
        requestId,
        "解析无水印原片",
        "success",
        `已从豆包获取无水印原画（${formatNomarkMeta(generationResult.nomarkInfo)}）`,
        unwatermarkedUrl
      );

      const outputVideoPath = await downloadCleanVideoIfNeeded(settings, requestId, unwatermarkedUrl);

      await this.updateProgress({
        requestId,
        status: "success",
        message: outputVideoPath
          ? `视频生成完成，无水印原画已保存到本地（${formatNomarkMeta(generationResult.nomarkInfo)}）`
          : `视频生成完成，无水印原片地址已获取（未配置保存目录）（${formatNomarkMeta(generationResult.nomarkInfo)}）`,
        doubaoThreadUrl: submittedConversationUrl,
        rawVideoUrl: null,
        cleanVideoUrl: unwatermarkedUrl,
        outputVideoPath
      });
      this.database.updateAccount({ id: account.id, currentStatus: "idle" });
      this.database.clearAccountCooldown(account.id);

      if (settings.autoCloseExecutorWindow) {
        win.close();
      }
    } catch (error) {
      // 被看门狗终止（卡死/放弃）：收尾由 finalizeAbortedRun 统一完成，这里不得再写状态或退款。
      if (error instanceof RunAbortedError || this.runs.current()?.aborted) return;
      let failure = error;
      if (win && !win.isDestroyed() && !accountBlocked && (await withTimeout(isDoubaoCaptchaVisible(win).catch(() => false), 6000, false))) {
        // 验证码处置统一走「账号管理」：不亮窗、不保活；重登该账号后会话自动同步回号池
        failure = new Error("账号触发字节风控验证码（人机验证），请到「账号管理」重新登录该豆包账号后再试");
        accountBlocked = true;
      }
      // 池宪法④：失败冷却退避 + 自动换号重试（仅可重试类失败，避免重复计费）。
      // 严格指定账号（preferredAccountId）时不换号；换号时同样遵守 excludeAccountIds。
      // 提示词发出前的账号/页面类失败（如该号页面没有视频模型控件）也换号：平台未扣额度，换号不重复计费。
      if (
        !accountBlocked &&
        canFailoverToAnotherAccount({
          message: errorMessage(failure),
          submitted: submittedToDoubao,
          refundableFailure: isRefundableExecutionError(failure)
        }) &&
        request.preferredAccountId == null &&
        settings.requestRetryLimit > 0 &&
        (request.retryCount ?? 0) < settings.requestRetryLimit
      ) {
        this.runs.assertLive();
        this.database.markAccountCooldown(account.id, settings.accountCooldownSeconds);
        const nextAccount = this.database.reserveAvailableAccount(request.model, {
          excludeAccountIds: [...(request.excludeAccountIds ?? []), account.id]
        });
        if (nextAccount && nextAccount.id !== account.id) {
          this.database.refundQuota(account.id, request.model);
          this.database.deductQuota(nextAccount.id, request.model);
          this.database.markApiRequestRetry(
            requestId,
            nextAccount.id,
            `账号「${account.name}」执行失败（${errorMessage(failure)}），已自动换号重试`
          );
          this.database.appendOperationLog({
            requestId,
            accountId: nextAccount.id,
            action: "换号重试",
            status: "info",
            message: `已从 ${account.name} 切换到 ${nextAccount.name} 重新执行`
          });
          this.database.updateAccount({ id: account.id, currentStatus: accountBlocked ? "login_required" : "idle" });
          this.onDataChanged();
          if (win && !win.isDestroyed() && settings.autoCloseExecutorWindow) {
            win.close();
          }
          // 当前 worker 仍持有该 key：enqueue 会被静默丢弃导致请求卡在 accepted，必须用 requeue。
          this.scheduler.requeue({ key: requestId, requestId, accountId: nextAccount.id, mode: "generate" });
          return;
        }
      }
      const shouldRefundQuota = !submittedToDoubao || isRefundableExecutionError(failure);
      // 退款与写失败状态之间没有 await，看门狗无法插入，避免双重退款。
      this.runs.assertLive();
      if (shouldRefundQuota) {
        this.database.refundQuota(account.id, request.model);
      }
      await this.failRequest(request, errorMessage(failure), shouldRefundQuota);
      this.database.updateAccount({
        id: account.id,
        currentStatus: accountBlocked ? "login_required" : "idle"
      });
      this.onDataChanged();
      if (win && !win.isDestroyed() && settings.autoCloseExecutorWindow) {
        win.close();
      }
    }
  }

  private async runImagePipeline(
    request: ApiRequest,
    account: Account,
    settings: AppSettings,
    win: BrowserWindow,
    onSubmitted: () => void
  ) {
    const requestId = request.requestId;
    await this.updateProgress({ requestId, status: "running", message: "正在切换豆包图像生成模式" });

    const activation = await activateImageMode(win, request.model as DoubaoImageModel);
    if (!activation.modelApplied) {
      throw new Error(`未确认选中「${activation.targetName}」，当前模型 ${activation.currentModel || "(未知)"}；已停止提交，不使用默认模型替代`);
    }

    await this.updateProgress({ requestId, status: "running", message: "正在设置出图比例" });
    const ratioApplied = await applyImageRatio(win, request.aspectRatio);
    if (!ratioApplied) {
      throw new Error(`无法确认豆包页面已选择 ${request.aspectRatio}；已停止提交，不使用默认比例替代`);
    }

    await installImageCaptureHook(win);

    const total = Math.min(4, Math.max(1, request.imageCount || 1));
    const perImageTimeoutMs = Math.min(600, Math.max(240, settings.generationTimeoutSeconds)) * 1000;
    let collected: ImageCaptureSummary = { images: [], usedModel: "", promptRaw: "", captureCount: 0, sawFailure: false };
    let threadUrl: string | null = null;

    for (let index = 0; index < total; index += 1) {
      const before = collected.images.length;
      await this.updateProgress({
        requestId,
        status: "running",
        message: total > 1 ? `正在提交豆包绘制（第 ${index + 1}/${total} 张）` : "正在提交豆包绘制"
      });

      await fillPrompt(win, request.prompt);
      for (let guard = 0; guard < 2; guard += 1) {
        const preflight = await inspectComposer(win, request.prompt);
        if (preflight.textLength > 0) break;
        await wait(1500);
        await fillPrompt(win, request.prompt);
      }

      // Mark before clicking: an unacknowledged click may already consume upstream quota.
      onSubmitted();
      const clicked = await clickImageSendButton(win);
      if (!clicked) {
        await sendKeyboard(win, "Enter", undefined, 150);
        await wait(800);
      }
      const started = await waitForImageSubmissionStarted(win, 25000);
      if (!started) {
        throw new Error("图片提交失败：发送后输入框未清空且未出现生成中状态");
      }
      if (!threadUrl) {
        threadUrl = await waitForSubmittedConversationUrl(win);
        if (threadUrl) {
          await this.updateProgress({
            requestId,
            status: "running",
            message: "已记录本次豆包会话地址，等待出图",
            doubaoThreadUrl: threadUrl
          });
        }
      }

      collected = await waitForGeneratedImages(win, before + 1, perImageTimeoutMs, async (message) => {
        await this.updateProgress({ requestId, status: "running", message });
      });

      if (collected.images.length <= before) {
        if (collected.sawFailure) {
          throw new Error("豆包返回生成失败提示，未产出图片");
        }
        if (index === 0) {
          throw new Error("等待豆包出图超时，未获取到图片结果");
        }
        break;
      }
      if (index < total - 1) {
        await wait(2000);
      }
    }

    if (!collected.images.length) {
      throw new Error("未获取到图片结果");
    }

    await this.updateProgress({ requestId, status: "running", message: "正在下载无水印原图" });
    const outputPaths = await downloadGeneratedImages(
      settings,
      requestId,
      collected.images.map((item) => item.url)
    );
    for (const image of collected.images) {
      this.recordOperation(requestId, "解析无水印原图", "success", "已获取 image_ori_raw 无印变体", image.url);
    }

    const modelNote = collected.usedModel ? `，豆包实际模型：${collected.usedModel}` : "";
    const partialNote = collected.images.length < total ? `（请求 ${total} 张，实际 ${collected.images.length} 张）` : "";

    const promptNote = collected.promptRaw ? `，落款=${collected.promptRaw.slice(0, 140)}` : "";
    await this.updateProgress({
      requestId,
      status: "success",
      message: `图片生成完成，无水印原图 ${collected.images.length} 张${outputPaths.length ? "，已保存到本地" : ""}${modelNote}${partialNote}${promptNote}`,
      doubaoThreadUrl: threadUrl,
      imageUrls: collected.images.map((item) => item.url),
      outputImagePaths: outputPaths.length ? outputPaths : null
    });
  }

  private async updateProgress(input: Parameters<AppDatabase["updateApiRequest"]>[0]) {
    // 被看门狗终止后，原流程的任何进度写入都会在这里抛 RunAbortedError。
    this.runs.touch();
    const existing = this.database.getApiRequest(input.requestId);
    const status = input.status ?? existing?.status ?? "running";
    const workflowPhase = input.workflowPhase === undefined
      ? phaseForProgress(input.message, status, existing?.workflowPhase)
      : input.workflowPhase;
    const updated = this.database.updateApiRequest({ ...input, workflowPhase });
    this.database.appendOperationLog({
      requestId: updated.requestId,
      accountId: updated.accountId,
      action: operationAction(input.message || "", input.status),
      status: input.status === "failed" ? "failed" : input.status === "success" ? "success" : "info",
      message: input.message || "",
      targetUrl: input.doubaoThreadUrl || input.rawVideoUrl || input.cleanVideoUrl || input.imageUrls?.[0] || null
    });
    this.onDataChanged();
    postCallback(updated);
    return updated;
  }

  /** 结果防误认：交付前确认该视频没有交付给过其他请求，撞了就拒收（已提交，不退额度，可找回）。 */
  private assertResultUnique(requestId: string, url: string | null | undefined) {
    const collision = findResultCollision(url, this.database.listDeliveredVideoResults(requestId));
    if (!collision) return;
    this.recordOperation(requestId, "结果校验", "failed", resultCollisionMessage(collision), url ?? undefined);
    throw new ResultCollisionError(collision);
  }

  private recordOperation(
    requestId: string,
    action: string,
    status: "info" | "success" | "failed",
    message: string,
    targetUrl?: string | null
  ) {
    const request = this.database.getApiRequest(requestId);
    this.database.appendOperationLog({
      requestId,
      accountId: request?.accountId ?? null,
      action,
      status,
      message,
      targetUrl
    });
    this.onDataChanged();
  }

  private resolveCleanVideoWithProgress(
    requestId: string,
    settings: AppSettings,
    shareUrl: string,
    maxAttempts?: number
  ) {
    return (async () => {
      const startedAt = Date.now();
      let retryCount = 0;
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在请求去水印服务并验证真实 MP4 地址"
      });

      try {
        const url = await resolveCleanVideoUrl(settings, shareUrl, async (retry) => {
          retryCount = retry.nextAttempt - 1;
          const delaySeconds = Math.ceil(retry.delayMs / 1000);
          const elapsedSeconds = Math.max(1, Math.ceil(retry.elapsedMs / 1000));
          await this.updateProgress({
            requestId,
            status: "running",
            message: `去水印第 ${retry.failedAttempt} 次未拿到可播放 MP4，已耗时 ${elapsedSeconds} 秒；${delaySeconds} 秒后进行第 ${retry.nextAttempt}/${retry.maxAttempts} 次解析：${retry.error}`
          });
        }, { maxAttempts });
        return { url, elapsedMs: Date.now() - startedAt, retryCount };
      } catch (error) {
        const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
        throw new Error(`${errorMessage(error)}（去水印已耗时 ${elapsedSeconds} 秒，已重试 ${retryCount} 次）`);
      }
    })();
  }

  private async resolveCleanVideoForVerifiedShare(
    requestId: string,
    settings: AppSettings,
    shareUrl: string
  ) {
    await this.updateProgress({
      requestId,
      status: "running",
      message: "分享链接已确认包含视频资源，正在请求去水印服务"
    });

    try {
      const cleanVideo = await this.resolveCleanVideoWithProgress(
        requestId,
        settings,
        shareUrl
      );
      return { shareUrl, cleanVideo };
    } catch (error) {
      throw new Error(`分享链接已确认包含视频资源，但去水印服务未识别：${errorMessage(error)}`);
    }
  }

  private async failRequest(request: ApiRequest, message: string, refunded: boolean, code?: ErrorCode) {
    const suffix = refunded ? "，已退回预扣额度" : "";
    const current = this.database.getApiRequest(request.requestId);
    const errorCode = code ?? classifyFailure(message, Boolean(current?.submittedAt));
    return this.updateProgress({
      requestId: request.requestId,
      status: "failed",
      message: `${message}${suffix}`,
      errorCode,
      quotaRefunded: refunded || Boolean(current?.quotaRefunded)
    });
  }

  private createExecutionWindow(account: Account, settings: AppSettings) {
    const titleName = account.remark || account.name;
    const visible = settings.showExecutorWindow;
    // 豆包页面在 hidden 窗口下会降级（编辑器挂起、上传失败、视频卡片不渲染）：
    // 默认用"幽灵窗口"——上屏正常渲染（保证视频卡片/媒体懒加载生效），
    // 但对用户完全不可见且鼠标事件穿透（不挡任何点击）。
    // 创建时 show:false + 初始 opacity:0，再 showInactive 上屏——避免
    // "先可见一帧再 setOpacity(0)"的闪窗（2026-10-18 修）。
    const win = new BrowserWindow({
      width: 1320,
      height: 860,
      x: visible ? undefined : 0,
      y: visible ? undefined : 0,
      show: false,
      opacity: visible ? 1 : 0,
      focusable: visible,
      skipTaskbar: !visible,
      title: `豆包执行器 - ${titleName}`,
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    if (!visible) {
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      win.showInactive(); // 零透明度上屏：首帧即不可见，同时保证豆包页面不降级
    } else {
      win.show();
    }
    // 交给看门狗：判定卡死/放弃时销毁该窗口，让挂起的页面调用尽快失败。
    this.runs.registerWindow(win);
    return win;
  }
}

/** 等待豆包 SPA 水合完成：页面文本+编辑器数量连续稳定后才算就绪（冷窗口兜底）。 */
async function waitForDoubaoPageSettled(win: BrowserWindow, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const signature = await runPageScript<string>(win, `
      (() => {
        const text = (document.body && document.body.innerText) || "";
        const editors = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').length;
        return JSON.stringify({ length: text.length, editors, state: document.readyState });
      })()
    `).catch(() => "");
    if (signature && signature === lastSignature) {
      stableCount += 1;
      if (stableCount >= 2) {
        try {
          const parsed = JSON.parse(signature) as { length: number; editors: number; state: string };
          if (parsed.length > 200 && parsed.editors >= 1 && parsed.state === "complete") return true;
        } catch {
          /* 继续等 */
        }
      }
    } else {
      stableCount = 0;
    }
    lastSignature = signature;
    await wait(1000);
  }
  return false;
}

/** 字节风控验证码（语义九宫格/滑块）是否正拦在页面上。 */
async function isDoubaoCaptchaVisible(win: BrowserWindow): Promise<boolean> {
  return runPageScript<boolean>(win, `
    (() => {
      if (document.querySelector('iframe[src*="verifycenter/captcha"], iframe[src*="rmc.bytedance.com"], .vc-captcha-page-container, [class*="captcha-container"], [id*="captcha_container"], [class*="captcha_verify"], [class*="vc-captcha"]')) return true;
      const text = (document.body && document.body.innerText) || "";
      return /请完成下列验证后继续|安全验证|完成验证后继续|拖动到下方|拖动图片|请依次点击|滑块验证|完成拼图|请完成验证/.test(text);
    })()
  `).catch(() => false);
}

async function looksLoggedOut(win: BrowserWindow) {
  return runPageScript<boolean>(win, `
    (() => {
      const text = document.body?.innerText || "";
      const loginWords = ["扫码登录", "手机号登录", "验证码登录", "登录/注册"];
      return loginWords.some((word) => text.includes(word));
    })()
  `);
}

async function uploadReferenceImages(win: BrowserWindow, imagePaths: string[]) {
  const resolvedPaths: string[] = [];
  for (const imagePath of imagePaths.slice(0, 9)) {
    const resolvedPath = path.resolve(imagePath);
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`参考图不存在：${resolvedPath}`);
    }
    resolvedPaths.push(resolvedPath);
  }
  if (!resolvedPaths.length) return;

  const settleMs = 2500 + resolvedPaths.length * 700;

  if (await setFileInputFiles(win, resolvedPaths)) {
    await wait(settleMs);
    return;
  }

  await clickByKeywords(win, ["上传", "参考图", "图片", "添加图片", "附件", "image", "upload"]);
  await wait(1200);

  if (await setFileInputFiles(win, resolvedPaths)) {
    await wait(settleMs);
    return;
  }

  throw new Error("没有找到豆包页面的图片上传控件");
}

async function uploadReferenceImage(win: BrowserWindow, imagePath: string) {
  await uploadReferenceImages(win, [imagePath]);
}

async function setFileInputFiles(win: BrowserWindow, filePaths: string[]) {
  const debug = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debug.isAttached()) {
      debug.attach("1.3");
      attachedHere = true;
    }
    const documentResult = await debug.sendCommand("DOM.getDocument", { depth: -1, pierce: true }) as {
      root: { nodeId: number };
    };
    const inputs = await debug.sendCommand("DOM.querySelectorAll", {
      nodeId: documentResult.root.nodeId,
      selector: 'input[type="file"]'
    }) as { nodeIds: number[] };

    if (!inputs.nodeIds.length) return false;
    await debug.sendCommand("DOM.setFileInputFiles", {
      nodeId: inputs.nodeIds[0],
      files: filePaths
    });
    return true;
  } finally {
    if (attachedHere && debug.isAttached()) {
      debug.detach();
    }
  }
}

async function fillPrompt(win: BrowserWindow, prompt: string) {
  const minAcceptableLength = Math.min(8, Math.max(2, prompt.replace(/\s+/g, "").length));
  for (let round = 0; round < 3; round += 1) {
    // 豆包弹窗残留会锁死 pointer-events：每轮先清障。
    await unlockBlockingOverlays(win).catch(() => null);
    const target = await findComposerTarget(win);
    if (!target) {
      await wait(1200);
      continue;
    }

    const attempts: Array<{ label: string; run: () => Promise<void> }> = [
      {
        label: "insertText",
        run: async () => {
          await sendMouseClick(win, target.x, target.y);
          await sendKeyboard(win, "A", [process.platform === "darwin" ? "meta" : "control"], 100);
          await sendKeyboard(win, "Backspace", undefined, 100);
          await win.webContents.insertText(prompt);
          await wait(900);
        }
      },
      {
        label: "clipboardPaste",
        run: async () => {
          const before = clipboard.readText();
          clipboard.writeText(prompt);
          await sendMouseClick(win, target.x, target.y);
          const selectAllModifiers: Array<"control" | "meta"> = [process.platform === "darwin" ? "meta" : "control"];
          await sendKeyboard(win, "A", selectAllModifiers, 100);
          await sendKeyboard(win, "Backspace", undefined, 100);
          await sendKeyboard(win, "V", selectAllModifiers, 900);
          if (clipboard.readText() === prompt) {
            clipboard.writeText(before);
          }
        }
      },
      {
        label: "domInput",
        run: async () => {
          await setComposerTextDirectly(win, prompt);
          await wait(900);
        }
      }
    ];

    const tried: string[] = [];
    for (const attempt of attempts) {
      tried.push(attempt.label);
      try {
        await attempt.run();
      } catch {
        /* 换下一招 */
      }
      await wait(400);
      const diagnostics = await inspectComposer(win, prompt);
      if (diagnostics.promptPresent && diagnostics.textLength >= minAcceptableLength) return;
    }
    await wait(1000);
  }

  const diagnostics = await inspectComposer(win, prompt);
  throw new Error(`豆包输入框没有真正接收本次提示词（已重试 3 轮；${formatComposerDiagnostics(diagnostics)}）`);
}

async function findComposerTarget(win: BrowserWindow) {
  // 冷窗口兜底：编辑器可能渲染较晚，最多等 ~14 秒
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const target = await runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = [
            el.getAttribute("placeholder"),
            el.getAttribute("aria-label"),
            el.getAttribute("data-placeholder")
          ].filter(Boolean).join(" ");
          const composerScore = /发送消息|发消息|输入消息|prompt|message/i.test(label) ? 100000 : 0;
          const searchPenalty = /搜索|search/i.test(label) ? 100000 : 0;
          return { el, rect, label, score: composerScore - searchPenalty + rect.bottom };
        })
        .sort((a, b) => b.score - a.score);

      const candidate = candidates[0];
      if (!candidate) return null;

      const el = candidate.el;
      el.focus();
      return {
        x: Math.round(candidate.rect.left + Math.min(120, candidate.rect.width * 0.25)),
        y: Math.round(candidate.rect.top + candidate.rect.height / 2),
        debug: candidate.label || el.tagName.toLowerCase()
      };
    })()
  `);
    if (target) return target;
    await wait(700);
  }
  return null;
}

async function setComposerTextDirectly(win: BrowserWindow, prompt: string) {
  return runPageScript<boolean>(win, `
    (() => {
      const prompt = ${JSON.stringify(prompt)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = editables[0];
      if (!editor) return false;

      editor.focus();
      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
        setter?.call(editor, prompt);
      } else {
        editor.textContent = prompt;
      }

      editor.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: prompt
      }));
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: prompt
      }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
}

async function activateVideoMode(win: BrowserWindow, model: DoubaoModel) {
  const isStandard = model === "seedance_2_0";
  const target = isStandard ? "Seedance 2.0" : model === "seedance_2_0_mini" ? "Mini" : "Fast";
  const isVideoModeActive = async () =>
    requestedVideoModelSelected(await readVideoModelChip(win), model as import("./types.js").DoubaoVideoModel);
  const diag = (msg: string) =>
    runPageScript<boolean>(win, `(() => { try { window.__vidDiag = window.__vidDiag || []; window.__vidDiag.push(${JSON.stringify(msg)}); } catch (e) {} return true; })()`);
  const clickByTextRealmouse = async (text: string, minX: number) => {
    if (["更多技能", "视频生成"].includes(text) && await runPageScript<boolean>(win, mediaEntryClickScript(text))) return true;
    const point = await exactTextPoint(win, text, minX);
    if (!point) return false;
    await sendMouseClick(win, point.x, point.y);
    return true;
  };

  // 冷窗口兜底：先等输入框出现（页面就绪信号），最多等 ~14 秒
  await findComposerTarget(win);
  await unlockBlockingOverlays(win).catch(() => null);
  await diag("start:" + String(win.webContents.getURL() || "").slice(0, 90));
  for (let round = 0; round < 3; round += 1) {
    if (await isVideoModeActive()) {
      await diag(`r${round}:already-active`);
      return;
    }

    // 2026-10 豆包改版：首页「视频生成」入口收进「更多技能」面板；
    // JS el.click() 对新版控件（div 面板项）实测无效，必须真实鼠标坐标事件。
    const m1 = await clickByTextRealmouse("更多技能", 0);
    await diag(`r${round}:更多技能=${m1}`);
    await wait(1000);
    const panel = await runPageScript<boolean>(win, `(() => /视频生成/.test(document.body ? document.body.innerText : ""))()`);
    await diag(`r${round}:panelHasEntry=${panel}`);
    const m2 = await clickByTextRealmouse("视频生成", 280);
    await diag(`r${round}:视频生成=${m2}`);
    await wait(1200);
    const m3 = await runPageScript<boolean>(win, `
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find((item) => {
          const text = String(item.textContent || "").trim();
          return text.indexOf("模型") === 0 || /^Seedance/.test(text);
        });
        if (!btn) return false;
        const rect = btn.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return false;
        window.__vidChip = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        return true;
      })()
    `);
    await diag(`r${round}:模型chip找到=${m3}`);
    const openedModel = await runPageScript<boolean>(win, mediaControlOpenScript("模型"));
    await wait(800);
    const modelLabel = isStandard ? "Seedance 2.0" : `Seedance 2.0 ${target}`;
    const selectedModel = openedModel && await runPageScript<boolean>(win, mediaMenuOptionClickScript(modelLabel));
    await diag(`r${round}:目标模型菜单选择=${selectedModel}`);
    if (isStandard) {
      // 订阅门槛检测：免费账号点标准档会弹「会员订阅」对话框（锁死页面），必须识别并明确报错。
      const chip = await readVideoModelChip(win);
      if (!/Seedance 2\.0/.test(chip) || /Mini|Fast/.test(chip)) {
        const gate = await unlockBlockingOverlays(win).catch(() => ({ subscriptionBlocked: false }));
        if (gate.subscriptionBlocked) {
          throw new Error("豆包账号未开通会员订阅，无法使用「Seedance 2.0」标准档（网页弹出了订阅对话框）");
        }
        await runPageScript<boolean>(win, mediaControlOpenScript("模型"));
        await wait(800);
        await runPageScript<boolean>(win, mediaMenuOptionClickScript("Seedance 2.0"));
        await wait(1000);
        const chip2 = await readVideoModelChip(win);
        if (!/Seedance 2\.0/.test(chip2) || /Mini|Fast/.test(chip2)) {
          throw new Error("未能切换到「Seedance 2.0」标准档（档位菜单未生效）");
        }
      }
      await diag(`r${round}:standard-verified`);
    }
    await wait(1000);
    if (await isVideoModeActive()) {
      await diag(`r${round}:active`);
      return;
    }
    await wait(1500);
  }
  await diag("failed-all-rounds");
  // 页面诊断轨迹只存在于执行窗口里，窗口一关就丢；失败时打到日志，便于定位个别账号的页面差异。
  const trail = await runPageScript<string>(win, `(() => { try { return (window.__vidDiag || []).join(" | "); } catch (e) { return ""; } })()`).catch(() => "");
  console.warn(`[video-mode] 选择视频模型失败：${String(trail).slice(0, 1500)}`);
  throw new Error(`未能选择请求的视频模型 ${isStandard ? "Seedance 2.0" : `Seedance 2.0 ${target}`}；当前模型=${await readVideoModelChip(win) || "无模型控件"}；未发送提示词`);
}

/** 找「文本完全等于」的可见元素中心坐标（可限制最小 x，排除左侧边栏）。 */
async function exactTextPoint(win: BrowserWindow, text: string, minX = 0) {
  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const wanted = ${JSON.stringify(text)};
      const minX = ${JSON.stringify(minX)};
      const nodes = Array.from(document.querySelectorAll("body *"));
      const passes = [ (el) => !el.closest("button"), () => true ];
      for (const accept of passes) {
        for (const el of nodes) {
          const content = String(el.textContent || "").trim();
          if (content !== wanted) continue;
          if (el.childElementCount > 4) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          if (rect.x < minX) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          if (!accept(el)) continue;
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
      }
      return null;
    })()
  `);
}

type ImageCaptureSummary = {
  images: Array<{ url: string }>;
  usedModel: string;
  promptRaw: string;
  captureCount: number;
  sawFailure: boolean;
};

/** Open only known non-generating media controls, including pointer-driven Radix menus. */
async function clickControlByLabel(win: BrowserWindow, label: string) {
  return runPageScript<boolean>(win, mediaControlOpenScript(label));
}

/** 读取图像控制条按钮当前文案（如「模型 Seedream 5.0 Flash」「比例 16:9」）。 */
async function readControlText(win: BrowserWindow, label: string) {
  return runPageScript<string>(win, `
    (() => {
      const label = ${JSON.stringify(label)};
      const btn = Array.from(document.querySelectorAll("button")).find((item) => String(item.textContent || "").trim().indexOf(label) === 0);
      return btn ? String(btn.textContent || "").trim() : "";
    })()
  `);
}

/** 读取已展开菜单里的可见短文案（枚举 Seedream 模型 / 比例选项用）。 */
async function collectControlOptions(win: BrowserWindow): Promise<string[]> {
  return runPageScript<string[]>(win, `
    (() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('[role="menu"][data-state="open"] button,[role="menu"][data-state="open"] [role="menuitem"],[role="menu"][data-state="open"] [role="option"]')) {
        const content = String(el.textContent || "").trim();
        if (!content || content.length > 60 || seen.has(content)) continue;
        const numericRatio = /^[0-9]{1,2}:[0-9]{1,2}/.test(content);
        if (content.indexOf("Seedream") !== 0 && content.indexOf("即梦") !== 0 && !numericRatio) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 12 || rect.height > 140) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        seen.add(content);
        out.push(content);
      }
      return out.slice(0, 24);
    })()
  `);
}

/** Select only an option in the currently open media menu. */
async function clickMenuItemByText(win: BrowserWindow, text: string) {
  return runPageScript<boolean>(win, mediaMenuOptionClickScript(text));
}

/** 切到豆包图像生成模式，并尽量选中目标 Seedream 模型。 */
async function activateImageMode(win: BrowserWindow, model: DoubaoImageModel) {
  const targetName = IMAGE_PAGE_MODEL_NAMES[model];
  const readState = async () =>
    runPageScript<{ active: boolean; entry: boolean; moreSkills: boolean }>(win, `
      (() => {
        const usable = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 8 && r.height > 8 && s.visibility !== "hidden" && s.display !== "none";
        };
        const nodes = Array.from(document.querySelectorAll("button, [role=button], div, span"));
        const active = nodes.some((el) => {
          const t = String(el.textContent || "").trim();
          return t.length <= 44 && t.indexOf("模型") === 0 && t.indexOf("Seedream") >= 0 && usable(el);
        });
        const entry = nodes.some((el) => {
          const t = String(el.textContent || "").trim();
          return t === "图像生成" && usable(el);
        });
        const moreSkills = nodes.some((el) => {
          const t = String(el.textContent || "").trim();
          return t === "更多技能" && usable(el);
        });
        return { active, entry, moreSkills };
      })()
    `);

  const clickEntry = async (label: string) => {
    if (await runPageScript<boolean>(win, mediaEntryClickScript(label))) return true;
    const point = await runPageScript<{ x: number; y: number } | null>(win, `
      (() => {
        const label = ${JSON.stringify(label)};
        const leaf = Array.from(document.querySelectorAll("button, [role=button], div, span")).find((el) => {
          const t = String(el.textContent || "").trim();
          if (t !== label) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 8 && r.height > 8 && s.visibility !== "hidden" && s.display !== "none";
        });
        if (!leaf) return null;
        const btn = leaf.closest("button, [role=button]") || leaf;
        const r = btn.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return null;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()
    `);
    if (point) {
      await sendMouseClick(win, point.x, point.y);
      return true;
    }
    return clickByKeywords(win, [label]);
  };

  await findComposerTarget(win);
  let state = await readState();
  for (let round = 0; round < 4 && !state.active; round += 1) {
    if (state.entry) {
      await clickEntry("图像生成");
    } else if (state.moreSkills) {
      await clickEntry("更多技能");
      await wait(1200);
      await clickEntry("图像生成");
    }
    await wait(2200);
    state = await readState();
  }
  if (!state.active) {
    const diag = await runPageScript<string>(win, `
      (() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none";
        };
        const texts = [];
        for (const b of document.querySelectorAll("button, [role=button]")) {
          if (!visible(b)) continue;
          const t = String(b.textContent || "").replace(/\\s+/g, " ").trim();
          if (t && t.length <= 26) texts.push(t);
        }
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"]')).filter(visible).length;
        return JSON.stringify({
          url: String(location.href).slice(0, 90),
          buttons: Array.from(new Set(texts)).slice(0, 30),
          dialogs
        });
      })()
    `);
    try {
      const shot = await win.webContents.capturePage();
      await fs.writeFile("D:/doubao-ref/imgmode-debug.png", shot.toPNG());
    } catch (error) {
      /* 截图失败不阻塞报错 */
    }
    throw new Error(`未能切换到豆包图像生成模式；现场=${diag || "无诊断"}`);
  }

  const currentModel = await readControlText(win, "模型");
  if (currentModel.replace(/^模型\s*/, "").replace(/\s+/g, "") === targetName.replace(/\s+/g, "")) {
    return { modelApplied: true, targetName, currentModel, options: [] as string[] };
  }

  let options: string[] = [];
  let modelApplied = false;
  const opened = await clickControlByLabel(win, "模型");
  if (opened) {
    await wait(1200);
    options = await collectControlOptions(win);
    console.log("[图像] Seedream 模型选项：", options.join(" / ") || "(未枚举到)");
    const clicked = await clickMenuItemByText(win, targetName);
    await wait(800);
    if (clicked) {
      const after = await readControlText(win, "模型");
      modelApplied = after.replace(/^模型\s*/, "").replace(/\s+/g, "") === targetName.replace(/\s+/g, "");
    }
    if (!modelApplied) {
      await sendKeyboard(win, "Escape", undefined, 120);
      await wait(400);
    }
  }
  const finalModel = await readControlText(win, "模型");
  return { modelApplied, targetName, currentModel: finalModel || currentModel, options };
}

/** Confirm the explicit image ratio. A false result stops submission. */
async function applyImageRatio(win: BrowserWindow, aspectRatio: string | null) {
  const raw = String(aspectRatio || "").trim().replace("：", ":");
  if (!raw || /^(auto|自动|默认)$/i.test(raw)) return true;
  const candidates = ["21:9", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1"];
  const wanted = candidates.find((item) => raw === item);
  if (!wanted) return false;
  const current = await readControlText(win, "比例");
  if (current.replace(/^比例\s*/, "").replace(/\s+/g, "") === wanted) return true;
  const opened = await clickControlByLabel(win, "比例");
  if (!opened) return false;
  await wait(1200);
  const ratioOptions = await collectControlOptions(win);
  console.log("[图像] 比例菜单选项：", ratioOptions.join(" / ") || "(未枚举到)");
  const clicked = await clickMenuItemByText(win, wanted);
  await wait(800);
  if (!clicked) {
    await sendKeyboard(win, "Escape", undefined, 120);
    return false;
  }
  const after = await readControlText(win, "比例");
  return after.replace(/^比例\s*/, "").replace(/\s+/g, "") === wanted;
}

/** 安装 /chat/completion 抓包钩子（fetch + XHR），结果存入 window.__poolImgCap。 */
async function installImageCaptureHook(win: BrowserWindow) {
  await runPageScript<string>(win, `
    (() => {
      if (window.__poolImgCapInstalled) return "already";
      window.__poolImgCapInstalled = true;
      window.__poolImgCap = [];
      const record = (url, text) => {
        try {
          window.__poolImgCap.push({ url: String(url).slice(0, 200), len: text.length, text });
          if (window.__poolImgCap.length > 24) window.__poolImgCap.shift();
        } catch (error) {}
      };
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        const pending = origFetch.apply(this, args);
        try {
          const reqUrl = (args[0] && (args[0].url || args[0])) || "";
          if (String(reqUrl).indexOf("/chat/completion") >= 0) {
            pending.then((resp) => {
              try {
                const clone = resp.clone();
                clone.text().then((t) => record(reqUrl, t)).catch(() => {});
              } catch (error) {}
            }).catch(() => {});
          }
        } catch (error) {}
        return pending;
      };
      const OX = window.XMLHttpRequest;
      const origOpen = OX.prototype.open;
      const origSend = OX.prototype.send;
      OX.prototype.open = function (method, url, ...rest) {
        this.__capUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      OX.prototype.send = function (...args) {
        try {
          if (String(this.__capUrl || "").indexOf("/chat/completion") >= 0) {
            this.addEventListener("load", () => {
              try { record(this.__capUrl, String(this.responseText || "")); } catch (error) {}
            });
          }
        } catch (error) {}
        return origSend.apply(this, args);
      };
      return "installed";
    })()
  `);
}

/** 从窗口抓包缓存提取 image_ori_raw（无印）URL 列表。 */
async function collectImageCaptures(win: BrowserWindow): Promise<ImageCaptureSummary> {
  const raw = await runPageScript<{ urls: string[]; modelRaw: string; promptRaw: string; captureCount: number; sawFailure: boolean }>(win, `
    (() => {
      const caps = window.__poolImgCap || [];
      const urls = [];
      const seen = new Set();
      let modelRaw = "";
      let promptRaw = "";
      let sawFailure = false;
      const FAIL_HINTS = ["生成失败", "无法生成", "未通过审核", "换个描述"];
      for (const cap of caps) {
        const text = String(cap.text || "");
        if (!modelRaw) {
          const mi = text.indexOf("Seedream");
          if (mi >= 0) modelRaw = text.slice(mi, mi + 40);
        }
        if (!promptRaw) {
          const pi = text.indexOf("user_input_content");
          if (pi >= 0) promptRaw = text.slice(pi, pi + 260);
        }
        if (!sawFailure && FAIL_HINTS.some((hint) => text.indexOf(hint) >= 0)) sawFailure = true;
        let cursor = -1;
        while ((cursor = text.indexOf("image_ori_raw", cursor + 1)) >= 0) {
          const hi = text.indexOf("https:", cursor);
          if (hi < 0 || hi - cursor > 400) continue;
          let j = hi;
          while (j < text.length) {
            const code = text.charCodeAt(j);
            if (code === 92 && text.charCodeAt(j + 1) === 34) break;
            if (code === 34 || code === 39 || code === 10 || code === 13) break;
            j += 1;
          }
          const candidate = text.slice(hi, j);
          if (candidate.length < 30) continue;
          const key = candidate.slice(-70);
          if (seen.has(key)) continue;
          seen.add(key);
          urls.push(candidate);
        }
      }
      return { urls, modelRaw, promptRaw, captureCount: caps.length, sawFailure };
    })()
  `);
  const summary: ImageCaptureSummary = {
    images: [],
    usedModel: "",
    promptRaw: "",
    captureCount: raw?.captureCount || 0,
    sawFailure: Boolean(raw?.sawFailure)
  };
  const backslash = String.fromCharCode(92);
  const decode = (value: string) =>
    value.split(backslash + "u002F").join("/").split(backslash + "/").join("/").replace(/&amp;/g, "&");
  summary.images = (raw?.urls || []).map((item) => ({ url: decode(item) }));
  const cleaned = String(raw?.modelRaw || "").replace(/[^0-9A-Za-z. ]+/g, " ").split(" ").filter(Boolean).slice(0, 3).join(" ");
  if (cleaned.indexOf("Seedream") === 0) {
    summary.usedModel = cleaned.slice(0, 34);
  }
  summary.promptRaw = String(raw?.promptRaw || "");
  return summary;
}

/** 给 promise 加超时护栏（页面被风控冻住时不至于整条链挂死）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

/** 轮询等待新图片完成（以 image_ori_raw 入库为准）。 */
async function waitForGeneratedImages(
  win: BrowserWindow,
  minCount: number,
  timeoutMs: number,
  onProgress: (message: string) => Promise<void>
): Promise<ImageCaptureSummary> {
  const deadline = Date.now() + timeoutMs;
  const emptySummary = (): ImageCaptureSummary => ({
    images: [],
    usedModel: "",
    promptRaw: "",
    captureCount: 0,
    sawFailure: false
  });
  let summary = (await withTimeout(collectImageCaptures(win), 30000, null)) ?? emptySummary();
  let lastReport = 0;
  while (Date.now() < deadline && summary.images.length < minCount) {
    if (await withTimeout(isDoubaoCaptchaVisible(win).catch(() => false), 6000, false)) {
      throw new Error("账号触发字节风控验证码（人机验证），请到「账号管理」重新登录该豆包账号后再试");
    }
    if (Date.now() - lastReport > 15000) {
      lastReport = Date.now();
      await onProgress(`豆包绘制中：已捕获 ${summary.images.length} 张无水印原图`);
    }
    await wait(3000);
    const next = await withTimeout(collectImageCaptures(win), 30000, null);
    if (next === null) {
      throw new Error("豆包页面长时间无响应（疑似被风控验证拦截），请到「账号管理」重新登录该豆包账号后再试");
    }
    summary = next;
  }
  return summary;
}

/** 点击图像模式的发送按钮（data-testid=chat_input_send_button）。 */
async function clickImageSendButton(win: BrowserWindow) {
  const point = await runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const btn = document.querySelector('[data-testid="chat_input_send_button"]');
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) return null;
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()
  `);
  if (!point) return false;
  await sendMouseClick(win, point.x, point.y);
  return true;
}

/** 核验图片请求已提交（输入框清空或出现生成中状态）。 */
async function waitForImageSubmissionStarted(win: BrowserWindow, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await runPageScript<{ editorEmpty: boolean; generating: boolean }>(win, `
      (() => {
        const editor = document.querySelector('.tiptap.ProseMirror, [contenteditable="true"]');
        const editorText = editor ? String(editor.textContent || "").trim() : "";
        const bodyText = document.body ? String(document.body.innerText || document.body.textContent || "") : "";
        const generating = bodyText.indexOf("正在生成") >= 0 || bodyText.indexOf("生成中") >= 0 || bodyText.indexOf("正在绘制") >= 0;
        return { editorEmpty: editorText.length === 0, generating };
      })()
    `);
    if (state && (state.editorEmpty || state.generating)) return true;
    await wait(1200);
  }
  return false;
}

/** 下载无印原图到本地输出目录。 */
async function downloadGeneratedImages(settings: AppSettings, requestId: string, urls: string[]) {
  if (!settings.outputDir.trim() || !urls.length) return [] as string[];
  await fs.mkdir(settings.outputDir, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const response = await fetch(urls[index]);
    if (!response.ok) {
      throw new Error(`下载无水印图片失败：HTTP ${response.status}`);
    }
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const ext = contentType.indexOf("jpeg") >= 0 ? "jpg" : contentType.indexOf("webp") >= 0 ? "webp" : contentType.indexOf("heic") >= 0 ? "heic" : "png";
    const name = urls.length > 1 ? `${requestId}-${index + 1}.${ext}` : `${requestId}.${ext}`;
    const outputPath = path.join(settings.outputDir, name);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) {
      throw new Error("下载到的图片文件为空");
    }
    await fs.writeFile(outputPath, bytes);
    paths.push(outputPath);
  }
  return paths;
}

async function submitPromptAndWait(win: BrowserWindow, model: DoubaoModel, prompt: string) {
  if (await isDoubaoCaptchaVisible(win)) {
    throw new Error("账号触发字节风控验证码（人机验证），请到「账号管理」重新登录该账号后再试");
  }
  const baselineText = await getPageText(win);
  const attempts: Array<{ label: string; run: () => Promise<boolean> }> = [
    {
      label: "Enter",
      run: async () => {
        await sendKeyboard(win, "Enter");
        return true;
      }
    },
    {
      label: "Command+Enter",
      run: async () => {
        await sendKeyboard(win, "Enter", ["meta"]);
        return true;
      }
    },
    {
      label: "Control+Enter",
      run: async () => {
        await sendKeyboard(win, "Enter", ["control"]);
        return true;
      }
    },
    {
      label: "右下角发送图标",
      run: async () => {
        const sendPoint = await findComposerSendButtonPoint(win);
        if (!sendPoint) return false;
        await sendMouseClick(win, sendPoint.x, sendPoint.y);
        return true;
      }
    },
    {
      label: "发送文字按钮",
      run: () => clickByKeywords(win, ["发送", "提交"])
    }
  ];

  const tried: string[] = [];
  for (const attempt of attempts) {
    const didRun = await attempt.run();
    if (!didRun) continue;
    tried.push(attempt.label);
    const result = await waitForSubmissionStarted(win, model, baselineText, prompt, 8000);
    if (result.failureMessage) {
      throw new DoubaoPageFailureError(
        `豆包提交后返回失败：${result.failureMessage}`,
        isQuotaNotChargedFailure(result.failureMessage)
      );
    }
    if (result.confirmed || result.sentEvidence) return;
  }

  const modelLabel = model === "seedance_2_0_mini" ? "Seedance 2.0 Mini" : model === "seedance_2_0" ? "Seedance 2.0" : "Seedance 2.0 Fast";
  const diagnostics = await inspectComposer(win);
  throw new Error(
    `没有看到豆包提交确认文案：本次使用 ${modelLabel} 生成；已尝试 ${tried.join("、") || "无可用发送动作"}；${formatComposerDiagnostics(diagnostics)}`
  );
}

async function confirmVideoGenerationIfNeeded(win: BrowserWindow, timeoutMs = 45000) {
  // 新版豆包在提交后先回复“请先确认参数……确认后我再开始生成视频”，
  // 需要再发一条确认消息后才会真正开始生成。
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pageText = await getPageText(win);
    if (/视频生成中|正在生成视频|正在生成/.test(pageText)) {
      return true;
    }
    const needsConfirm = /请先确认参数|确认后我再开始生成视频|确认后.{0,8}开始生成/.test(pageText);
    if (needsConfirm) {
      await unlockBlockingOverlays(win).catch(() => null);
      // 实测坑：发送按钮为无 aria-label 的图标钮，单纯点一次可能命中不可交互状态；
      // 必须以「输入框清空」作为已发送凭据，失败换法重试（点击 → 键盘回车）。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await fillPrompt(win, "确认，开始生成");
        const sendPoint = await findComposerSendButtonPoint(win);
        if (sendPoint) {
          await sendMouseClick(win, sendPoint.x, sendPoint.y);
        }
        await wait(2200);
        let composerText = "";
        try {
          composerText = await runPageScript<string>(win, `
            (() => {
              const ta = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
              return ta ? String(ta.textContent || ta.value || "") : "";
            })()
          `);
        } catch (error) {
          composerText = "";
        }
        if (!composerText.includes("确认")) {
          return true;
        }
        // 仍是未发出状态：键盘回车兜底，再校验一轮。
        await sendKeyboard(win, "Enter", undefined, 0);
        await wait(1800);
        try {
          composerText = await runPageScript<string>(win, `
            (() => {
              const ta = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
              return ta ? String(ta.textContent || ta.value || "") : "";
            })()
          `);
        } catch (error) {
          composerText = "";
        }
        if (!composerText.includes("确认")) {
          return true;
        }
      }
      return true;
    }
    await wait(1000);
  }
  return false;
}

async function sendKeyboard(
  win: BrowserWindow,
  keyCode: string,
  modifiers?: Array<"control" | "meta">,
  settleMs = 700
) {
  // 隐藏窗口下 sendInputEvent 的键盘事件不会被页面处理；改用 CDP 注入
  const debug = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debug.isAttached()) {
      debug.attach("1.3");
      attachedHere = true;
    }
    const windowsVirtualKeyCode =
      keyCode === "Enter"
        ? 13
        : keyCode === "ESC" || keyCode === "Escape"
          ? 27
          : keyCode === "Backspace"
            ? 8
            : keyCode === "Delete"
              ? 46
              : keyCode.length === 1
                ? keyCode.toUpperCase().charCodeAt(0)
                : 0;
    const cdpModifiers =
      (modifiers?.includes("control") ? 2 : 0) | (modifiers?.includes("meta") ? 4 : 0);
    const key = keyCode === "Enter" ? "Enter" : keyCode === "ESC" ? "Escape" : keyCode === "Backspace" ? "Backspace" : keyCode;
    await debug.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      key,
      modifiers: cdpModifiers
    });
    await wait(80);
    await debug.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      key,
      modifiers: cdpModifiers
    });
    await wait(settleMs);
  } finally {
    if (attachedHere && debug.isAttached()) {
      try { debug.detach(); } catch { /* ignore */ }
    }
  }
}

async function inspectComposer(win: BrowserWindow, expectedPrompt = "") {
  return runPageScript<{
    promptPresent: boolean;
    textLength: number;
    activeElement: string;
    sendCandidates: number;
    enabledSendCandidates: number;
  }>(win, `
    (() => {
      const expectedPrompt = ${JSON.stringify(expectedPrompt)};
      const normalizeComparableText = (value) => value.replace(/[^\\p{L}\\p{N}]+/gu, "").trim();
      const expectedSignature = (() => {
        const normalized = normalizeComparableText(expectedPrompt);
        return normalized.slice(0, Math.min(42, Math.max(12, normalized.length)));
      })();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const active = document.activeElement;
      const activeEditable = active?.closest?.(editableSelector);
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = activeEditable && visible(activeEditable) ? activeEditable : editables[0];
      const editorText = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
        ? editor.value
        : (editor?.innerText || editor?.textContent || "");
      const sendNodes = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title]'))
        .filter((el) => visible(el))
        .filter((el) => /发送|提交|send/i.test([
          el.innerText,
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title")
        ].filter(Boolean).join(" ")));
      const enabled = sendNodes.filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
      const normalizedText = editorText.replace(/\\s+/g, "").trim();
      const comparableText = normalizeComparableText(editorText);
      return {
        promptPresent: expectedSignature
          ? comparableText.includes(expectedSignature)
          : normalizedText.length > 0,
        textLength: normalizedText.length,
        activeElement: active
          ? active.tagName.toLowerCase() + (active.getAttribute("role") ? "[role=" + active.getAttribute("role") + "]" : "")
          : "none",
        sendCandidates: sendNodes.length,
        enabledSendCandidates: enabled.length
      };
    })()
  `);
}

function formatComposerDiagnostics(input: Awaited<ReturnType<typeof inspectComposer>>) {
  return `输入框实际字数 ${input.textLength}，焦点 ${input.activeElement}，可用发送按钮 ${input.enabledSendCandidates}/${input.sendCandidates}`;
}

async function findComposerSendButtonPoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const activeEditable = document.activeElement?.closest?.(editableSelector);
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = activeEditable && visible(activeEditable) ? activeEditable : editables[0];
      if (!editor) return null;

      const editorRect = editor.getBoundingClientRect();
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").trim();
      const isEditorAncestor = (el) => el === editor || editor.contains(el);
      const clickables = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex], [aria-label]'))
        .filter((el) => visible(el) && !el.disabled && !isEditorAncestor(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const nearEditor = cy >= editorRect.top - 40
            && cy <= editorRect.bottom + 90
            && cx >= editorRect.left + editorRect.width * 0.62
            && cx <= Math.max(editorRect.right + 140, window.innerWidth);
          const lowerRight = cy >= window.innerHeight * 0.55 && cx >= window.innerWidth * 0.55;
          const compact = rect.width <= 96 && rect.height <= 96;
          const badText = /视频生成|图像生成|音乐生成|更多|快速|帮我写作|录音转写|翻译|图片|\\+|添加|上传/.test(text);
          const sendText = /发送|提交/.test(text) ? 1000 : 0;
          return { el, rect, text, cx, cy, nearEditor, lowerRight, compact, badText, score: sendText + cx + cy / 10 };
        })
        .filter((item) => (item.nearEditor || item.lowerRight) && item.compact && !item.badText)
        .sort((a, b) => b.score - a.score);

      const target = clickables[0];
      if (!target) return null;
      return {
        x: Math.round(target.cx),
        y: Math.round(target.cy),
        debug: target.text || target.el.tagName
      };
    })()
  `);
}

async function sendMouseClick(win: BrowserWindow, x: number, y: number) {
  // 隐藏窗口下 sendInputEvent 的鼠标事件不会被页面处理；改用 CDP 注入
  const debug = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debug.isAttached()) {
      debug.attach("1.3");
      attachedHere = true;
    }
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await wait(60);
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await wait(60);
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } finally {
    if (attachedHere && debug.isAttached()) {
      try { debug.detach(); } catch { /* ignore */ }
    }
  }
}

async function waitForSubmissionStarted(
  win: BrowserWindow,
  model: DoubaoModel,
  baselineText: string,
  prompt: string,
  timeoutMs = 15000
) {
  const modelLabel = model === "seedance_2_0_mini" ? "Seedance 2.0 Mini" : model === "seedance_2_0" ? "Seedance 2.0" : "Seedance 2.0 Fast";
  const startedAt = Date.now();
  const baselineUrl = win.webContents.getURL();
  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = win.webContents.getURL();
    const realConversationUrl = /doubao\.com\/chat\/(?!local_)[A-Za-z0-9._~-]{6,}/i.test(currentUrl)
      && currentUrl !== baselineUrl;
    const state = await runPageScript<{
      confirmed: boolean;
      sentEvidence: boolean;
      failureMessage: string | null;
      pageTextExcerpt: string;
    }>(win, `
      (() => {
        const modelLabel = ${JSON.stringify(modelLabel)};
        const baselineText = ${JSON.stringify(baselineText)};
        const prompt = ${JSON.stringify(prompt)};
        const extractDoubaoFailureMessage = ${extractDoubaoFailureMessage.toString()};
        const hasNewPromptOccurrence = ${hasNewPromptOccurrence.toString()};
        const hasNewTextOccurrence = ${hasNewTextOccurrence.toString()};
        const pageText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
        const expected = "本次使用 " + modelLabel + " 生成";
        const failureMessage = extractDoubaoFailureMessage(pageText);
        const newFailureMessage = failureMessage && hasNewTextOccurrence(pageText, baselineText, failureMessage)
          ? failureMessage
          : null;
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
        };
        const editables = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
          .filter((el) => visible(el) && !el.disabled && !el.readOnly)
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
        const editor = editables[0];
        const editorText = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
          ? editor.value
          : (editor?.innerText || editor?.textContent || "");
        const normalize = (value) => value.replace(/[^\\p{L}\\p{N}]+/gu, "").trim();
        const normalizedPrompt = normalize(prompt);
        const promptSignature = normalizedPrompt.slice(0, Math.min(42, Math.max(12, normalizedPrompt.length)));
        const normalizedEditorText = normalize(editorText);
        const promptStillInComposer = Boolean(promptSignature && normalizedEditorText.includes(promptSignature));
        const composerCleared = !editor || normalizedEditorText.length === 0 || !promptStillInComposer;
        const pageChanged = pageText !== baselineText;
        const sentEvidence = !newFailureMessage
          && pageChanged
          && composerCleared
          && hasNewPromptOccurrence(pageText, baselineText, prompt);
        return {
          confirmed: hasNewTextOccurrence(pageText, baselineText, expected)
            && pageText.includes("视频生成好后")
            && pageText.includes("本次生成将消耗每日免费额度"),
          sentEvidence,
          failureMessage: newFailureMessage,
          pageTextExcerpt: pageText.slice(-500)
        };
      })()
    `);

    if (state.failureMessage) {
      return { confirmed: false, sentEvidence: false, failureMessage: state.failureMessage };
    }
    if (state.confirmed || realConversationUrl) {
      return { confirmed: true, sentEvidence: true, failureMessage: null };
    }
    if (state.sentEvidence) {
      return { confirmed: false, sentEvidence: true, failureMessage: null };
    }
    await wait(1000);
  }

  return { confirmed: false, sentEvidence: false, failureMessage: null };
}

interface GenerationPageState {
  generated: boolean;
  failed: boolean;
  failureMessage: string | null;
  pageText: string;
  directVideoUrl: string | null;
  videoUrls: string[];
  visibleVideoCount: number;
  playableVideoCount: number;
  videoCardCount: number;
}

interface GenerationResult {
  shareUrl: string | null;
  directVideoUrl: string | null;
  cleanVideoUrl?: string | null;
  nomarkInfo?: NomarkVideoInfo | null;
  shareFailureReason?: string | null;
}

async function waitForGenerationResult(
  win: BrowserWindow,
  timeoutSeconds: number,
  baselineText: string,
  baselineVideoUrls: string[],
  baselinePlayableVideoCount: number,
  baselineVideoCardCount: number,
  prompt: string,
  preferredConversationUrl: string | null,
  onProgress: (message: string) => Promise<void> | void,
  claimedThreadUrls: () => string[] = () => []
): Promise<GenerationResult> {
  const timeoutMs = Math.max(60, timeoutSeconds || 900) * 1000;
  const historyFallbackMs = Math.max(30000, Math.min(360000, Math.floor(timeoutMs * 0.6)));
  const startedAt = Date.now();
  let generatedAt = 0;
  let nomarkReloaded = false;
  let completionTextSeenAt = 0;
  let lastProgressAt = 0;
  let directVideoUrl: string | null = null;
  let shareFailureReason: string | null = null;
  let historyFallbackAttempted = false;

  while (Date.now() - startedAt < timeoutMs) {
    const pageState = await inspectGenerationPage(win);
    directVideoUrl ||= pageState.directVideoUrl;
    const newFailureMessage = pageState.failureMessage
      && hasNewTextOccurrence(pageState.pageText, baselineText, pageState.failureMessage)
      ? pageState.failureMessage
      : null;
    if (newFailureMessage) {
      throw new DoubaoPageFailureError(
        `豆包已返回视频生成失败：${newFailureMessage}`,
        isQuotaNotChargedFailure(newFailureMessage)
      );
    }

    const newVideoUrls = getNewDoubaoVideoUrls(pageState.videoUrls, baselineVideoUrls);
    const hasNewVideoSource = newVideoUrls.length > 0;
    const newVideoCount = newVideoUrls.length;
    const newPlayableVideoCount = Math.max(
      0,
      pageState.playableVideoCount - baselinePlayableVideoCount
    );
    const newVideoCardCount = Math.max(0, pageState.videoCardCount - baselineVideoCardCount);
    const completionTextPresent = hasNewGenerationCompletion(pageState.pageText, baselineText);
    if (completionTextPresent && !completionTextSeenAt) {
      completionTextSeenAt = Date.now();
    }
    // Doubao renders the completion text before the finished card. Do not share
    // until a new video card is present; a text-only result is not shareable.
    const generated = isGenerationReadyForShare({
      completionTextPresent,
      hasNewVideoSource,
      newVideoCount,
      newPlayableVideoCount,
      newVideoCardCount,
      completionTextSeenAt,
      now: Date.now()
    });

    if (generated) {
      if (!generatedAt) {
        generatedAt = Date.now();
        await onProgress("视频已生成，正在进入分享模式并复制链接");
      }
      directVideoUrl ||= pageState.directVideoUrl;

      // 关键（2026-10-14 实测）：SPA 流式渲染的消息里没有 fallback_api，整页重载后才有。
      if (!nomarkReloaded) {
        nomarkReloaded = true;
        try {
          const currentUrl = win.webContents.getURL();
          if (/\/chat\/\d{6,}/.test(currentUrl)) {
            await loadUrl(win, currentUrl);
            await waitForDoubaoPageSettled(win);
            await wait(1500);
          }
        } catch {
          /* 重载失败则用现页面兜底 */
        }
      }

      // 自研去水印：优先直接从页面数据解析无水印原片（无需分享面板/第三方服务）
      const nomarkInfo = await resolveNomarkCleanVideo(win).catch(() => null);
      if (nomarkInfo?.url) {
        return { shareUrl: null, directVideoUrl, cleanVideoUrl: nomarkInfo.url, nomarkInfo };
      }

      const copied = await tryCopyShareLink(win);
      shareFailureReason = copied.reason;
      if (copied.shareUrl) {
        return { shareUrl: copied.shareUrl, directVideoUrl };
      }

      if (Date.now() - generatedAt > 120000) {
        return { shareUrl: null, directVideoUrl, shareFailureReason };
      }
    }

    if (!generatedAt && !historyFallbackAttempted && Date.now() - startedAt >= historyFallbackMs) {
      historyFallbackAttempted = true;
      await onProgress("当前执行窗口未同步完成状态，正在检查该账号最近对话");
      const originalUrl = win.webContents.getURL();
      const recovery = await runHistoryFallback(
        win,
        prompt,
        planHistoryFallback({
          ownThreadUrl: preferredConversationUrl,
          currentUrl: originalUrl,
          prompt,
          claimedThreadUrls: claimedThreadUrls()
        }),
        onProgress
      );
      // recovery 为 null：兜底被跳过（无会话地址且提示词过短），继续在当前窗口等待。
      if (recovery?.cleanVideoUrl) {
        return {
          shareUrl: recovery.shareUrl,
          directVideoUrl: directVideoUrl || recovery.directVideoUrl || null,
          cleanVideoUrl: recovery.cleanVideoUrl,
          nomarkInfo: recovery.nomarkInfo
        };
      }
      if (recovery?.shareUrl) {
        return { shareUrl: recovery.shareUrl, directVideoUrl: directVideoUrl || recovery.directVideoUrl || null };
      }
      if (recovery && recovery.generatedMatchCount > 0) {
        return { shareUrl: null, directVideoUrl: directVideoUrl || recovery.directVideoUrl || null, shareFailureReason: recovery.shareFailureReason };
      }
      if (recovery && originalUrl) {
        await loadUrl(win, originalUrl);
        await wait(1500);
        await dismissDoubaoDesktopDownloadPrompt(win);
      }
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (Date.now() - lastProgressAt > 30000) {
      lastProgressAt = Date.now();
      await onProgress(generatedAt
        ? `视频已生成，正在重试复制分享链接 ${Math.floor((Date.now() - generatedAt) / 1000)}s`
        : `已提交豆包，等待生成完成 ${elapsedSeconds}s`);
    }
    await wait(5000);
  }

  if (generatedAt) {
    return { shareUrl: null, directVideoUrl, shareFailureReason };
  }
  await onProgress("当前执行窗口等待超时，正在最后检查该账号最近对话");
  const finalPlan = planHistoryFallback({
    ownThreadUrl: preferredConversationUrl,
    currentUrl: win.webContents.getURL(),
    prompt,
    claimedThreadUrls: claimedThreadUrls()
  });
  const recovery = await runHistoryFallback(win, prompt, finalPlan, onProgress);
  if (!recovery) {
    throw new Error(`等待豆包视频生成超时；${finalPlan.mode === "skip" ? finalPlan.reason : "未找到已生成视频"}`);
  }
  if (recovery.cleanVideoUrl) {
    return {
      shareUrl: recovery.shareUrl,
      directVideoUrl: directVideoUrl || recovery.directVideoUrl || null,
      cleanVideoUrl: recovery.cleanVideoUrl,
      nomarkInfo: recovery.nomarkInfo
    };
  }
  if (recovery.shareUrl) {
    return { shareUrl: recovery.shareUrl, directVideoUrl: directVideoUrl || recovery.directVideoUrl || null };
  }
  if (recovery.generatedMatchCount > 0) {
    return { shareUrl: null, directVideoUrl: directVideoUrl || recovery.directVideoUrl || null, shareFailureReason: recovery.shareFailureReason };
  }
  throw new Error(
    `等待豆包视频生成超时；历史链接 ${recovery.candidateCount} 条，提示词匹配 ${recovery.promptMatchCount} 条，未找到已生成视频`
  );
}

/** 按规划执行“检查最近对话”兜底；skip 时只记录原因并返回 null。 */
async function runHistoryFallback(
  win: BrowserWindow,
  prompt: string,
  plan: HistoryFallbackPlan,
  onProgress: (message: string) => Promise<void> | void
) {
  if (plan.mode === "skip") {
    await onProgress(plan.reason);
    return null;
  }
  if (plan.mode === "strict") {
    return findGeneratedConversationAndCopyShare(win, prompt, plan.conversationUrl, { strict: true });
  }
  return findGeneratedConversationAndCopyShare(win, prompt, plan.preferredUrl, {
    excludeConversationUrls: plan.excludeConversationUrls
  });
}

async function inspectGenerationPage(win: BrowserWindow, scrollToLatest = true) {
  return runPageScript<GenerationPageState>(win, `
    (() => {
      if (${scrollToLatest}) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      }
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const pageText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      const extractDoubaoFailureMessage = ${extractDoubaoFailureMessage.toString()};
      const isDoubaoGenerationComplete = ${isDoubaoGenerationComplete.toString()};
      const isDoubaoPromptRewritePage = ${isDoubaoPromptRewritePage.toString()};
      const videos = Array.from(document.querySelectorAll("video")).filter(visible);
      const videoCardImages = Array.from(document.querySelectorAll("img")).filter((image) => {
        if (!visible(image)) return false;
        const source = [
          image.currentSrc,
          image.src,
          image.getAttribute("src"),
          image.getAttribute("data-src")
        ].filter(Boolean).join(" ");
        return /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video|aka\.doubaocdn/i.test(source);
      });
      const posterCount = Array.from(document.querySelectorAll("xg-poster")).filter(visible).length;
      const videoSourceLists = videos.map((video) => [
        video.currentSrc,
        video.src,
        video.getAttribute("data-src"),
        video.getAttribute("data-url"),
        video.getAttribute("data-video-url"),
        video.getAttribute("data-download-url"),
        ...Array.from(video.querySelectorAll("source[src]")).map((source) => source.src)
      ].filter(Boolean));
      const videoSources = videoSourceLists.flat();
      const videoUrls = videoSources.filter((value) => /^https?:\\/\\//i.test(value || ""));
      const completedByText = isDoubaoGenerationComplete(pageText);
      const promptRewrite = isDoubaoPromptRewritePage(pageText);
      const playableVideoCount = videos.filter((video, index) => (
        video.readyState >= 1 || videoSourceLists[index].length > 0
      )).length;
      const playableVideo = playableVideoCount > 0;
      const failureMessage = extractDoubaoFailureMessage(pageText);
      return {
        generated: completedByText || (!promptRewrite && playableVideo),
        failed: Boolean(failureMessage),
        failureMessage,
        pageText,
        directVideoUrl: videoUrls[videoUrls.length - 1] || null,
        videoUrls,
        visibleVideoCount: videos.length,
        playableVideoCount,
        videoCardCount: videos.length + videoCardImages.length + posterCount
      };
    })()
  `);
}

async function findGeneratedConversationAndCopyShare(
  win: BrowserWindow,
  prompt: string,
  preferredConversationUrl: string | null = null,
  options: { strict?: boolean; excludeConversationUrls?: readonly string[] } = {}
) {
  const normalizedPrompt = normalizeComparableText(prompt);
  const candidates = await runPageScript<string[]>(win, `
    (() => {
      const prompt = ${JSON.stringify(normalizedPrompt)};
      const normalize = (value) => value.replace(/[^\\p{L}\\p{N}]+/gu, "").trim();
      const scoreLabel = (label) => {
        const normalizedLabel = normalize(label);
        if (!normalizedLabel) return 0;
        if (prompt.includes(normalizedLabel)) return 10000 + normalizedLabel.length;
        let bigramMatches = 0;
        for (let index = 0; index < normalizedLabel.length - 1; index += 1) {
          if (prompt.includes(normalizedLabel.slice(index, index + 2))) bigramMatches += 1;
        }
        return bigramMatches * 100 + Math.min(normalizedLabel.length, 20);
      };
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((link, index) => ({
          href: link.href,
          label: [link.innerText, link.textContent, link.getAttribute("aria-label"), link.getAttribute("title")]
            .filter(Boolean).join(" "),
          index
        }))
        .filter(({ href }) => {
          try {
            const url = new URL(href);
            return /^(?:www\\.)?doubao\\.com$/i.test(url.hostname)
              && /^\\/chat\\/[A-Za-z0-9._~-]+/i.test(url.pathname);
          } catch {
            return false;
          }
        })
        .map((item) => ({ ...item, score: scoreLabel(item.label) }));
      const unique = Array.from(new Map(links.map((item) => [item.href, item])).values());
      return unique
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((item) => item.href)
        .slice(0, 30);
    })()
  `);
  const preferredUrl = extractDoubaoConversationUrl(preferredConversationUrl);
  // strict：只检查已记录的本次会话，不扫描其他历史对话（D10）。
  // 非 strict 扫描时排除已被其他请求认领的会话（结果防误认，见 result-guard.ts）。
  const excluded = options.excludeConversationUrls ?? [];
  const orderedCandidates = options.strict && preferredUrl
    ? [preferredUrl]
    : Array.from(new Set([
      preferredUrl,
      ...candidates
    ].filter((value): value is string => Boolean(value))))
      .filter((value) => !isExcludedConversation(value, excluded));
  const signatureLength = Math.min(42, normalizedPrompt.length);
  const signatureSpan = Math.max(0, normalizedPrompt.length - signatureLength);
  const signatures = Array.from(new Set([0, 0.25, 0.5, 0.75, 1]
    .map((position) => normalizedPrompt.slice(
      Math.floor(signatureSpan * position),
      Math.floor(signatureSpan * position) + signatureLength
    ))
    .filter((value) => value.length >= 12)));
  const requiredSignatureMatches = Math.max(1, Math.ceil(signatures.length * 0.8));
  let promptMatchCount = 0;
  let generatedMatchCount = 0;
  let recoveryDirectVideoUrl: string | null = null;
  let shareFailureReason: string | null = null;

  for (const candidate of orderedCandidates) {
    try {
      // A stale conversation link must not block recovery indefinitely. The
      // newest conversation is normally near the front of this list.
      await loadUrl(win, candidate, 8000);
    } catch (error) {
      console.warn("跳过无法加载的豆包历史对话", candidate, error);
      continue;
    }
    // 豆包会话是虚拟滚动 SPA：只等 600ms 就读 innerText，长会话消息还没挂到 DOM，
    // 会把「视频明明在」判成「提示词匹配 0 条」（找回失败的主因之一）。
    await waitForDoubaoPageSettled(win).catch(() => {});
    await wait(1200);
    await dismissDoubaoDesktopDownloadPrompt(win);

    let pageText = "";
    let matchedPrompt = false;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      pageText = await runPageScript<string>(win, `document.body?.innerText || ""`);
      const normalizedPageText = normalizeComparableText(pageText);
      const signatureMatches = signatures.filter((signature) => normalizedPageText.includes(signature)).length;
      matchedPrompt = normalizedPageText.includes(normalizedPrompt)
        || signatureMatches >= requiredSignatureMatches;
      if (matchedPrompt) break;
      // 前几轮纯等待（流式渲染）；之后每轮滚到底触发懒加载再读。
      if (attempt >= 3) {
        await runPageScript(win, `(() => {
          const sc = document.scrollingElement || document.body;
          sc.scrollTop = sc.scrollHeight;
          const panes = Array.from(document.querySelectorAll('[class*="scroll"], [data-testid*="chat"]'));
          for (const pane of panes) { try { pane.scrollTop = pane.scrollHeight; } catch {} }
          window.dispatchEvent(new Event("scroll"));
        })()`).catch(() => {});
      }
      await wait(700);
    }
    if (!matchedPrompt) continue;
    promptMatchCount += 1;

    const pageState = await waitForGeneratedVideoCard(win, VIDEO_CARD_WAIT_MS);
    if (!pageState.generated || pageState.failed) continue;
    if (pageState.videoCardCount <= 0) {
      shareFailureReason = "匹配对话已完成，但视频卡片仍未渲染";
      continue;
    }
    generatedMatchCount += 1;
    recoveryDirectVideoUrl ||= pageState.directVideoUrl || null;

    // 自研去水印（无水印原片直解）：SPA 流式消息第一次经常还没把 fallback_api
    // 写进页面，单次失败就整单判死太亏。整页重载重试最多 2 轮（第二轮等更久）。
    let recoveryNomark = null;
    for (let nomarkAttempt = 1; nomarkAttempt <= 2; nomarkAttempt += 1) {
      try {
        const recoveryUrl = win.webContents.getURL();
        if (/\/chat\/\d{6,}/.test(recoveryUrl)) {
          await loadUrl(win, recoveryUrl);
          await waitForDoubaoPageSettled(win);
          await wait(nomarkAttempt === 1 ? 1200 : 2600);
        }
      } catch {
        /* 忽略，用现页面兜底 */
      }
      recoveryNomark = await resolveNomarkCleanVideo(win).catch(() => null);
      if (recoveryNomark?.url) break;
    }
    if (recoveryNomark?.url) {
      return {
        conversationUrl: candidate,
        shareUrl: null,
        directVideoUrl: recoveryDirectVideoUrl,
        cleanVideoUrl: recoveryNomark.url,
        nomarkInfo: recoveryNomark,
        candidateCount: orderedCandidates.length,
        promptMatchCount,
        generatedMatchCount,
        shareFailureReason: null
      };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const copied = await tryCopyShareLink(win);
      shareFailureReason = copied.reason;
      if (copied.shareUrl) {
        return {
          conversationUrl: candidate,
          shareUrl: copied.shareUrl,
          directVideoUrl: recoveryDirectVideoUrl,
          cleanVideoUrl: null,
          nomarkInfo: null,
          candidateCount: orderedCandidates.length,
          promptMatchCount,
          generatedMatchCount,
          shareFailureReason: null
        };
      }
      await wait(1000);
    }
  }

  return {
    conversationUrl: null as string | null,
    shareUrl: null,
    directVideoUrl: recoveryDirectVideoUrl,
    cleanVideoUrl: null,
    nomarkInfo: null,
    candidateCount: orderedCandidates.length,
    promptMatchCount,
    generatedMatchCount,
    shareFailureReason
  };
}

async function waitForGeneratedVideoCard(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let state = await inspectGenerationPage(win);
  while (Date.now() - startedAt < timeoutMs) {
    if (state.failureMessage || (state.generated && state.videoCardCount > 0)) return state;
    await wait(500);
    state = await inspectGenerationPage(win);
  }
  return state;
}

async function tryCopyShareLink(win: BrowserWindow) {
  return clipboardMutex.runExclusive(async () => {
    if (win.isDestroyed()) return { shareUrl: null, reason: "执行窗口已关闭" } satisfies ShareCopyResult;

    const before = clipboard.readText();
    const clipboardSentinel = `__doubao_share_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    clipboard.writeText(clipboardSentinel);
    let result: ShareCopyResult = { shareUrl: null, reason: "未找到分享面板" };

    try {
      await dismissDoubaoDesktopDownloadPrompt(win);

      const generationState = await inspectGenerationPage(win, false);
      if (generationState.failureMessage) {
        result = {
          shareUrl: null,
          reason: `当前任务未产生视频：${generationState.failureMessage}`
        };
        return result;
      }
      if (!generationState.generated) {
        result = { shareUrl: null, reason: "当前对话尚未确认视频生成完成" };
        return result;
      }

      await primeGeneratedVideoCard(win);

      const acceptCopiedShareUrl = async (shareUrl: string) => {
        try {
          await verifyDoubaoShareVideoResource(shareUrl);
          result = { shareUrl, reason: null };
          return true;
        } catch (error) {
          result = { shareUrl: null, reason: errorMessage(error) };
          return false;
        }
      };

      let shareState = await inspectShareSelection(win);

      if (!shareState.active) {
        await openShareSelection(win);
        const directlyCopiedUrl = extractDoubaoShareUrl(clipboard.readText());
        if (directlyCopiedUrl) {
          if (await acceptCopiedShareUrl(directlyCopiedUrl)) return result;
        }
        shareState = await waitForShareSelection(win, SHARE_PANEL_WAIT_MS);
      }

      if (!shareState.active) {
        if (!result.reason || result.reason === "未找到分享面板") {
          result = { shareUrl: null, reason: "未打开分享面板" };
        }
        return result;
      }

      if (!shareState.allSelected) {
        const selectAllPoint = await waitForTextControlPoint(win, ["全选"], [], 1800);
        if (selectAllPoint) {
          await sendMouseClick(win, selectAllPoint.x, selectAllPoint.y);
          shareState = await waitForShareSelection(win, 1200);
        }
      }

      // The copy button starts disabled while the share panel settles or until
      // the target content is selected. Poll for it instead of failing on the
      // first inspection so a slow panel is not treated as a failed copy.
      if (!shareState.copyEnabled) {
        shareState = await waitForShareCopyEnabled(win, SHARE_PANEL_WAIT_MS);
      }

      const copyPoint = await waitForTextControlPoint(win, ["复制链接"], [], 1800);
      if (!copyPoint) {
        result = { shareUrl: null, reason: "未找到复制链接控件" };
        return result;
      }
      if (!shareState.copyEnabled && shareState.checkboxCount > 0) {
        result = { shareUrl: null, reason: "复制链接按钮未启用" };
        return result;
      }

      // A native input event is the reliable path for Doubao's clipboard handler.
      await sendMouseClick(win, copyPoint.x, copyPoint.y);
      const nativeCopiedUrl = await waitForClipboardShareUrl(CLIPBOARD_WAIT_MS);
      if (nativeCopiedUrl) {
        if (await acceptCopiedShareUrl(nativeCopiedUrl)) return result;
      }

      // Keep a DOM click as a bounded fallback for versions that render the
      // clickable label separately from the visible button surface.
      await clickByKeywords(win, ["复制链接"]);
      const domCopiedUrl = await waitForClipboardShareUrl(CLIPBOARD_WAIT_MS);
      if (domCopiedUrl) {
        await acceptCopiedShareUrl(domCopiedUrl);
      } else if (!result.reason) {
        result = { shareUrl: null, reason: "点击复制链接后剪贴板未出现豆包分享地址" };
      }
      return result;
    } catch (error) {
      // Share panels are animated and can be replaced while the generation card
      // updates. Treat a transient inspection error as a retryable miss.
      console.warn("豆包复制分享链接暂时失败", error);
      result = { shareUrl: null, reason: `复制控件检查异常：${errorMessage(error)}` };
      return result;
    } finally {
      if (!result.shareUrl) restoreClipboardAfterFailedShare(before, clipboardSentinel);
    }
  });
}

async function dismissDoubaoDesktopDownloadPrompt(win: BrowserWindow) {
  if (win.isDestroyed()) return false;

  const prompt = await runPageScript<{
    detected: boolean;
    action: "remind_later" | "close" | null;
  }>(win, `
    (() => {
      const isDoubaoDesktopDownloadPrompt = ${isDoubaoDesktopDownloadPrompt.toString()};
      const pageText = document.body?.innerText || "";
      if (!isDoubaoDesktopDownloadPrompt(pageText)) {
        return { detected: false, action: null };
      }

      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4
          && rect.height > 4
          && style.visibility !== "hidden"
          && style.display !== "none"
          && style.pointerEvents !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'))
        .filter(visible);
      const clickTarget = (el) => el.closest('button, [role="button"], a, [tabindex]') || el;
      const remindLater = controls.find((el) => textOf(el).replace(/\\s+/g, "") === "下次提醒我");
      if (remindLater) {
        clickTarget(remindLater).click();
        return { detected: true, action: "remind_later" };
      }

      const closeButton = controls.find((el) => {
        const label = [el.getAttribute("aria-label"), el.getAttribute("title")]
          .filter(Boolean).join(" ");
        const text = textOf(el).replace(/\\s+/g, "");
        return /关闭|close|dismiss/i.test(label) || text === "×" || text === "✕";
      });
      if (closeButton) {
        clickTarget(closeButton).click();
        return { detected: true, action: "close" };
      }

      return { detected: true, action: null };
    })()
  `);

  if (!prompt.detected) return false;
  if (!prompt.action) {
    await sendKeyboard(win, "ESC", undefined, 250);
  } else {
    await wait(450);
  }

  // Some Doubao builds accept the click but leave the modal mounted for a
  // short period. Verify the marker is gone before trying the share controls.
  // Esc is harmless when the modal has already closed and prevents a stale
  // overlay from swallowing the next click when it has not.
  try {
    const stillVisible = await runPageScript<boolean>(win, `
      (() => {
        const isDoubaoDesktopDownloadPrompt = ${isDoubaoDesktopDownloadPrompt.toString()};
        const pageText = document.body?.innerText || "";
        if (!isDoubaoDesktopDownloadPrompt(pageText)) return false;
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 4
            && rect.height > 4
            && style.visibility !== "hidden"
            && style.display !== "none"
            && style.pointerEvents !== "none";
        };
        const textOf = (el) => [
          el.innerText,
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title")
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
        return Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'))
          .filter(visible)
          .some((el) => textOf(el).replace(/\\s+/g, "") === "下次提醒我");
      })()
    `);
    if (stillVisible) await sendKeyboard(win, "ESC", undefined, 250);
  } catch {
    // The click can trigger a route update; the next page operation will
    // handle a newly mounted prompt if needed.
  }
  return true;
}

async function waitForClipboardShareUrl(timeoutMs = CLIPBOARD_WAIT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const shareUrl = extractDoubaoShareUrl(clipboard.readText());
    if (shareUrl) return shareUrl;
    await wait(Math.min(150, Math.max(25, timeoutMs - (Date.now() - startedAt))));
  }
  return extractDoubaoShareUrl(clipboard.readText());
}

async function primeGeneratedVideoCard(win: BrowserWindow) {
  const revealed = await runPageScript<boolean>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 80
          && rect.height > 60
          && style.visibility !== "hidden"
          && style.display !== "none";
      };
      const posters = Array.from(document.querySelectorAll("img"))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const source = [
            el.currentSrc,
            el.src,
            el.getAttribute("src"),
            el.getAttribute("data-src")
          ].filter(Boolean).join(" ");
          return { el, rect, source };
        })
        .filter((item) => /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(item.source))
        .sort((a, b) => b.rect.bottom - a.rect.bottom);
      const target = posters[0];
      if (!target) return false;
      target.el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      return true;
    })()
  `);
  if (!revealed) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    await wait(500);
    const state = await inspectGenerationPage(win, false);
    if (state.playableVideoCount > 0 || state.videoUrls.length > 0) {
      await wait(700);
      break;
    }
  }
  await sendKeyboard(win, "ESC", undefined, 350);
  await wait(800);
  return true;
}

async function waitForShareSelection(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let state = await inspectShareSelection(win);
  while (!state.active && Date.now() - startedAt < timeoutMs) {
    await wait(180);
    state = await inspectShareSelection(win);
  }
  return state;
}

async function waitForShareCopyEnabled(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let state = await inspectShareSelection(win);
  while (!state.copyEnabled && Date.now() - startedAt < timeoutMs) {
    await wait(180);
    state = await inspectShareSelection(win);
  }
  return state;
}

async function waitForTextControlPoint(
  win: BrowserWindow,
  keywords: string[],
  excluded: string[] = [],
  timeoutMs = 1800
) {
  const startedAt = Date.now();
  let point = await findTextControlPoint(win, keywords, excluded);
  while (!point && Date.now() - startedAt < timeoutMs) {
    await wait(150);
    point = await findTextControlPoint(win, keywords, excluded);
  }
  return point;
}

function restoreClipboardAfterFailedShare(before: string, sentinel: string) {
  const current = clipboard.readText();
  if (current === sentinel || !extractDoubaoShareUrl(current)) {
    clipboard.writeText(before);
  }
}

async function inspectShareSelection(win: BrowserWindow) {
  return runPageScript<{
    active: boolean;
    hasSelection: boolean;
    allSelected: boolean;
    checkboxCount: number;
    checkedCount: number;
    copyEnabled: boolean;
  }>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const controls = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title], [tabindex]'))
        .filter(visible);
      const copyControls = controls.filter((el) => textOf(el).includes("复制链接"));
      const allText = (document.body?.innerText || "").replace(/\\s+/g, " ");
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(visible);
      const checked = checkboxes.filter((el) => el.checked === true || el.getAttribute("aria-checked") === "true");
      const copyEnabled = copyControls.some((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
      return {
        active: copyControls.length > 0 && allText.includes("全选"),
        hasSelection: checked.length > 0 || (checkboxes.length === 0 && copyEnabled),
        allSelected: checkboxes.length === 0 ? copyEnabled : checked.length === checkboxes.length,
        checkboxCount: checkboxes.length,
        checkedCount: checked.length,
        copyEnabled
      };
    })()
  `);
}

/** 页面内提取器：只回传小结果（避免大字符串经 CDP 传输），.toString() 注入免转义风险。 */
function inPageExtractFallbackApis() {
  let s = document.documentElement.outerHTML || "";
  for (let round = 0; round < 4; round += 1) {
    const next = s
      .replace(/&quot;/gi, '"')
      .replace(/&#34;/g, '"')
      .replace(/&amp;/gi, '&')
      .replace(/\\u002F/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/\\\\"/g, '"')
      .replace(/\\"/g, '"');
    if (next === s) break;
    s = next;
  }
  const out: Array<{ apiUrl: string; keySeed: string }> = [];
  const seen: Record<string, boolean> = {};
  const re = /https:\/\/vas-[a-z0-9-]+\.snssdk\.com\/video\/fplay\/[^\s"'\\<>]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const apiUrl = m[0].replace(/[)\\]+,?$/, "");
    if (seen[apiUrl]) continue;
    seen[apiUrl] = true;
    let keySeed = "";
    try {
      keySeed = new URL(apiUrl).searchParams.get("key_seed") || "";
    } catch {
      continue;
    }
    out.push({ apiUrl, keySeed });
  }
  return out;
}

async function resolveNomarkCleanVideo(win: BrowserWindow): Promise<NomarkVideoInfo | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // 路径一：页面内提取（推荐）
      const apis = await runPageScript<Array<{ apiUrl: string; keySeed: string }>>(
        win,
        `(${inPageExtractFallbackApis.toString()})()`
      );
      if (Array.isArray(apis) && apis.length > 0) {
        for (const { apiUrl, keySeed } of apis) {
          try {
            const info = await resolveUnwatermarkedVideo(apiUrl, keySeed);
            if (info?.url) return info;
          } catch {
            /* try next api */
          }
        }
      }
      // 路径二（保底）：整页 HTML 传回主进程提取
      const html = await runPageScript<string>(win, "document.documentElement.outerHTML");
      if (typeof html === "string" && html.length > 500) {
        const apis2 = extractFallbackApis(html);
        for (const { apiUrl, keySeed } of apis2) {
          try {
            const info = await resolveUnwatermarkedVideo(apiUrl, keySeed);
            if (info?.url) return info;
          } catch {
            /* try next api */
          }
        }
      }
    } catch (error) {
      console.warn("[nomark] 无水印解析尝试失败：", errorMessage(error));
    }
    await wait(2000);
  }
  return null;
}

async function sendMouseMove(win: BrowserWindow, x: number, y: number, settleMs = 0) {
  const debug = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debug.isAttached()) {
      debug.attach("1.3");
      attachedHere = true;
    }
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    if (settleMs > 0) await wait(settleMs);
  } finally {
    if (attachedHere && debug.isAttached()) {
      try { debug.detach(); } catch { /* ignore */ }
    }
  }
}

async function hoverGeneratedVideoCard(win: BrowserWindow) {
  // 悬停视频卡片中部，激活消息工具栏（纯图标：复制/分享/修改/更多）
  const point = await runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const cands = [];
      document.querySelectorAll("img, video, xg-poster").forEach((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width < 100 || r.height < 80 || s.visibility === "hidden" || s.display === "none") return;
        const inMessageArea = r.left > window.innerWidth * 0.2 && r.top > 40 && r.bottom < window.innerHeight - 100;
        if (!inMessageArea) return;
        const src = String(el.currentSrc || el.src || s.backgroundImage || "");
        const isVideoish = /video_dsz|watermark|doubaocdn|xg-poster/i.test(src) || el.tagName === "VIDEO" || el.tagName === "XG-POSTER";
        cands.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), score: (isVideoish ? 1000 : 0) + Math.round(r.width) });
      });
      cands.sort((a, b) => b.score - a.score);
      return cands[0] || null;
    })()
  `);
  if (!point) return false;
  const debug = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debug.isAttached()) {
      debug.attach("1.3");
      attachedHere = true;
    }
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await wait(800);
    return true;
  } finally {
    if (attachedHere && debug.isAttached()) {
      try { debug.detach(); } catch { /* ignore */ }
    }
  }
}

async function waitForToolbarSharePoint(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let point = await findToolbarSharePoint(win);
  while (!point && Date.now() - startedAt < timeoutMs) {
    await wait(200);
    point = await findToolbarSharePoint(win);
  }
  return point;
}

async function findToolbarSharePoint(win: BrowserWindow) {
  // 消息工具栏 = 一行 3-4 个 24px 图标按钮；顺序 [复制][分享][修改][更多]，取第 2 个。
  return runPageScript<{ x: number; y: number; count: number } | null>(win, `
    (() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none";
      };
      const btns = Array.from(document.querySelectorAll("button"))
        .filter(vis)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((b) => b.w >= 18 && b.w <= 40 && b.h >= 18 && b.h <= 40 && b.x > window.innerWidth * 0.5 && b.y > 60 && b.y < 520);
      if (btns.length < 3) return null;
      const rows = [];
      for (const b of btns) {
        let row = rows.find((r) => Math.abs(r.y - b.y) <= 8);
        if (!row) {
          row = { y: b.y, items: [] };
          rows.push(row);
        }
        row.items.push(b);
      }
      const best = rows.filter((r) => r.items.length >= 3).sort((a, b) => b.items.length - a.items.length)[0];
      if (!best) return null;
      best.items.sort((a, b) => a.x - b.x);
      const share = best.items[Math.min(1, best.items.length - 1)];
      return { x: share.x, y: share.y, count: best.items.length };
    })()
  `);
}

async function openShareSelection(win: BrowserWindow) {
  // 新版豆包：悬停视频卡片 → 出现纯图标工具栏 [复制][分享][修改][更多]，
  // 点第二个（分享）打开"选择对话"分享面板。此已验证路径优先于其他启发式候选。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hovered = await hoverGeneratedVideoCard(win);
    if (hovered) {
      const toolbarSharePoint = await waitForToolbarSharePoint(win, 4000);
      if (toolbarSharePoint) {
        await sendMouseMove(win, toolbarSharePoint.x, toolbarSharePoint.y, 900);
        await sendMouseClick(win, toolbarSharePoint.x, toolbarSharePoint.y);
        if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
        await sendKeyboard(win, "ESC", undefined, 250);
      }
    }
    await wait(400);
  }

  const cardSharePoint = await waitForVideoCardSharePoint(win, 5000);
  if (cardSharePoint) {
    await sendMouseClick(win, cardSharePoint.x, cardSharePoint.y);
    if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
    await sendKeyboard(win, "ESC", undefined, 250);
  }

  // Some Doubao builds label the video-card entry as “分享图片”. It is the
  // share entry for the current media card, not a page-level share action.
  const sharePoint = await waitForTextControlPoint(win, ["分享图片", "分享"], [], 1800);
  if (sharePoint) {
    await sendMouseClick(win, sharePoint.x, sharePoint.y);
    if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
  }

  const menuPoint = await findOverflowMenuPoint(win);
  if (menuPoint) {
    await sendMouseClick(win, menuPoint.x, menuPoint.y);
    const menuSharePoint = await waitForTextControlPoint(win, ["分享"], ["分享图片"], 1800);
    if (menuSharePoint) {
      await sendMouseClick(win, menuSharePoint.x, menuSharePoint.y);
      if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
    }
    // A wrong header candidate can open an unrelated popover. Close it before
    // trying the icon-only fallback so the next click is not swallowed.
    await sendKeyboard(win, "ESC", undefined, 250);
  }

  // On some Doubao builds the message toolbar is icon-only. Its action order is
  // copy, share, edit, more; use the button immediately before edit when labels
  // are absent as a final fallback after the verified header menu path.
  const shareIconPoint = await findShareIconPoint(win);
  if (shareIconPoint) {
    await sendMouseClick(win, shareIconPoint.x, shareIconPoint.y);
    if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
  }

  return false;
}

async function waitForVideoCardSharePoint(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let point = await findVideoCardSharePoint(win);
  while (!point && Date.now() - startedAt < timeoutMs) {
    await wait(180);
    point = await findVideoCardSharePoint(win);
  }
  return point;
}

async function findVideoCardSharePoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4
          && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const media = Array.from(document.querySelectorAll("video, img"))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const source = [
            el.currentSrc,
            el.src,
            el.getAttribute("src"),
            el.getAttribute("data-src"),
            el.getAttribute("data-video-url"),
            el.getAttribute("data-download-url")
          ].filter(Boolean).join(" ");
          return { el, rect, source };
        })
        .filter((item) => /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(item.source))
        .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
      if (!media) return null;

      let ancestor = media.el.parentElement;
      for (let level = 0; ancestor && level < 9; level += 1, ancestor = ancestor.parentElement) {
        const controls = Array.from(ancestor.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return { el, rect, text: textOf(el) };
          })
          .filter((item) => item.rect.width <= 240 && item.rect.height <= 100
            && item.rect.bottom >= media.rect.top - 100
            && item.rect.top <= media.rect.bottom + 180);
        const labeled = controls
          .filter((item) => /分享/.test(item.text) && !/下载|电脑版/.test(item.text))
          .sort((a, b) => Number(/分享图片|分享/.test(b.text)) - Number(/分享图片|分享/.test(a.text)));
        if (labeled[0]) {
          const rect = labeled[0].rect;
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        }

        const iconControls = controls
          .filter((item) => !item.text && item.rect.width <= 64 && item.rect.height <= 64)
          .sort((a, b) => a.rect.left - b.rect.left);
        const unique = [];
        for (const item of iconControls) {
          if (!unique.some((existing) => Math.abs(existing.rect.left - item.rect.left) < 8)) unique.push(item);
        }
        if (unique.length >= 3) {
          const target = unique[unique.length - 3].rect;
          return { x: Math.round(target.left + target.width / 2), y: Math.round(target.top + target.height / 2) };
        }
      }
      return null;
    })()
  `);
}

async function findTextControlPoint(win: BrowserWindow, keywords: string[], excluded: string[] = []) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const keywords = ${JSON.stringify(keywords)};
      const excluded = ${JSON.stringify(excluded)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a, label, [tabindex], [aria-label], [title], div, span'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const exact = keywords.some((word) => text === word);
          const contains = keywords.some((word) => text.includes(word));
          const blocked = excluded.some((word) => text.includes(word));
          const enabled = !el.disabled && el.getAttribute("aria-disabled") !== "true";
          return { el, rect, text, exact, contains, blocked, enabled };
        })
        .filter((item) => item.contains
          && !item.blocked
          && item.rect.width <= 480
          && item.rect.height <= 140)
        .sort((a, b) => Number(b.enabled) - Number(a.enabled)
          || Number(b.exact) - Number(a.exact)
          || b.rect.bottom - a.rect.bottom);
      const target = nodes[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function findOverflowMenuPoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [el.innerText, el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")]
        .filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const allNodes = Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { rect, text: textOf(el) };
        });
      const headerNodes = allNodes.filter((item) => {
        const centerX = item.rect.left + item.rect.width / 2;
        const centerY = item.rect.top + item.rect.height / 2;
        return centerY >= 0
          && centerY <= 120
          && centerX >= window.innerWidth * 0.65
          && item.rect.width <= 180
          && item.rect.height <= 80;
      });
      const labeledNodes = headerNodes
        .filter((item) => /更多|操作|^\\.{3}$|^…$|^⋯$/.test(item.text)
          && !/下载电脑版|播报|朗读|静音/.test(item.text)
          && item.rect.width <= 80
          && item.rect.height <= 80)
        .sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top);
      const downloadNode = headerNodes
        .filter((item) => /下载电脑版/.test(item.text))
        .sort((a, b) => a.rect.width - b.rect.width)[0];
      const smallHeaderNodes = headerNodes
        .filter((item) => !/下载电脑版|播报|朗读|静音/.test(item.text)
          && item.rect.width <= 80
          && item.rect.height <= 80);
      const adjacentToDownload = downloadNode
        ? smallHeaderNodes
          .filter((item) => item.rect.right <= downloadNode.rect.left + 12
            && item.rect.right >= downloadNode.rect.left - 120
            && Math.abs((item.rect.top + item.rect.height / 2)
              - (downloadNode.rect.top + downloadNode.rect.height / 2)) <= 26)
          .sort((a, b) => {
            const distanceA = downloadNode.rect.left - a.rect.right;
            const distanceB = downloadNode.rect.left - b.rect.right;
            return distanceA - distanceB;
          })
        : [];
      const target = labeledNodes[0]
        || adjacentToDownload[0]
        || smallHeaderNodes.sort((a, b) => b.rect.right - a.rect.right)[0];
      return target ? {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2)
      } : null;
    })()
  `);
}

async function waitForSubmittedConversationUrl(win: BrowserWindow, timeoutMs = 2600) {
  let conversationUrl = extractDoubaoConversationUrl(win.webContents.getURL());
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs
    && (!conversationUrl || /\/chat\/local_/i.test(conversationUrl))) {
    await wait(200);
    const currentUrl = extractDoubaoConversationUrl(win.webContents.getURL());
    if (currentUrl) conversationUrl = currentUrl;
  }
  return conversationUrl;
}

async function findShareIconPoint(win: BrowserWindow) {
  const overflowPoint = await findOverflowMenuPoint(win);
  if (!overflowPoint) return null;

  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const anchor = ${JSON.stringify(overflowPoint)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height
          };
        })
        .filter((item) => item.width <= 64
          && item.height <= 64
          && Math.abs(item.y - anchor.y) <= 26
          && item.x <= anchor.x + 12
          && item.x >= anchor.x - 170)
        .sort((a, b) => a.x - b.x);

      const unique = [];
      for (const item of nodes) {
        if (!unique.some((existing) => Math.abs(existing.x - item.x) < 8)) unique.push(item);
      }

      const target = unique.length >= 3 ? unique[unique.length - 3] : null;
      return target ? { x: Math.round(target.x), y: Math.round(target.y) } : null;
    })()
  `);
}

async function clickByKeywords(win: BrowserWindow, keywords: string[]) {
  return runPageScript<boolean>(win, `
    (() => {
      const keywords = ${JSON.stringify(keywords.map((item) => item.toLowerCase()))};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("placeholder")
      ].filter(Boolean).join(" ").trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, label, div[tabindex], span[tabindex]'))
        .filter((el) => visible(el));
      const scored = nodes
        .map((el) => {
          const text = textOf(el).toLowerCase();
          const score = keywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
          const tagScore = el.tagName === "BUTTON" ? 3 : el.getAttribute("role") === "button" ? 2 : 1;
          return { el, text, score, tagScore };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.tagScore - a.tagScore);
      const target = scored[0]?.el;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.click();
      return true;
    })()
  `);
}

/** 读取视频模式「模型」chip 当前文案（校验档位切换是否生效）。 */
async function readVideoModelChip(win: BrowserWindow): Promise<string> {
  return runPageScript<string>(win, `
    (() => {
      const btn = Array.from(document.querySelectorAll("button")).find((item) => {
        const text = String(item.textContent || "").trim();
        return (text.indexOf("模型") === 0 || /^Seedance/.test(text)) && (item.offsetWidth || 0) > 40;
      });
      return btn ? String(btn.textContent || "").trim() : "";
    })()
  `);
}

/** 检测并解除豆包全屏遮罩/幽灵弹窗（订阅对话框常驻会锁死 pointer-events）。返回是否订阅门槛弹窗。 */
async function unlockBlockingOverlays(win: BrowserWindow): Promise<{ subscriptionBlocked: boolean }> {
  return runPageScript<{ subscriptionBlocked: boolean }>(win, `
    (() => {
      const result = { subscriptionBlocked: false };
      try {
        const dialog = document.querySelector('[role="dialog"][data-state="open"]');
        if (dialog) {
          const iframe = dialog.querySelector('iframe');
          const src = iframe ? String(iframe.getAttribute('src') || '') : '';
          if (src.indexOf('member/subscription') >= 0) result.subscriptionBlocked = true;
        }
        if (!result.subscriptionBlocked) {
          const anySub = Array.from(document.querySelectorAll('iframe')).some((f) => String(f.getAttribute('src') || '').indexOf('member/subscription') >= 0);
          if (anySub && (document.querySelector('.bg-dbx-bg-mask') || document.body.getAttribute('data-scroll-locked'))) result.subscriptionBlocked = true;
        }
        const masks = Array.from(document.querySelectorAll('.bg-dbx-bg-mask'));
        for (const mask of masks) {
          let cur = mask;
          for (let i = 0; i < 6 && cur; i += 1) {
            if (cur.getAttribute && cur.getAttribute('data-state') === 'open') {
              cur.setAttribute('data-state', 'closed');
              cur.style.display = 'none';
            }
            cur = cur.parentElement;
          }
          mask.style.display = 'none';
        }
        document.body.style.pointerEvents = '';
        document.body.removeAttribute('data-scroll-locked');
        const root = document.getElementById('root');
        if (root) root.removeAttribute('data-biz-setting-modal-open');
      } catch (error) { /* ignore */ }
      return result;
    })()
  `);
}

/** 点「更多技能」面板内的「视频生成」入口（2026-10 版豆包；排除左侧边栏的历史会话项）。 */
async function clickVideoEntry(win: BrowserWindow) {
  return runPageScript<boolean>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && style.visibility !== "hidden" && style.display !== "none";
      };
      const nodes = Array.from(document.querySelectorAll("body *"));
      const passes = [
        (el) => !el.closest("button") && el.getBoundingClientRect().x > 280,
        (el) => el.getBoundingClientRect().x > 280
      ];
      for (const accept of passes) {
        for (const el of nodes) {
          const content = String(el.textContent || "").trim();
          if (content !== "视频生成") continue;
          if (el.childElementCount > 4) continue;
          if (!visible(el)) continue;
          if (!accept(el)) continue;
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          el.click();
          return true;
        }
      }
      return false;
    })()
  `);
}

/** 在页面中以内文本「精确等于」点击一个元素（模型档位菜单用；避免子串误命中 Fast/Mini）。 */
async function clickExactByText(win: BrowserWindow, text: string) {
  return runPageScript<boolean>(win, `
    (() => {
      const wanted = ${JSON.stringify(text)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 16 && rect.height > 10 && style.visibility !== "hidden" && style.display !== "none";
      };
      const scopes = [
        Array.from(document.querySelectorAll('[role="menu"] *, [role="listbox"] *, [data-radix-popper-content-wrapper] *')),
        Array.from(document.querySelectorAll("body *"))
      ];
      const passes = [ (el) => !el.closest("button"), () => true ];
      for (const scope of scopes) {
        for (const accept of passes) {
          for (const el of scope) {
            const content = String(el.textContent || "").trim();
            if (content !== wanted) continue;
            if (el.childElementCount > 4) continue;
            if (!visible(el)) continue;
            if (!accept(el)) continue;
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            el.click();
            return true;
          }
        }
      }
      return false;
    })()
  `);
}

async function downloadCleanVideoIfNeeded(settings: AppSettings, requestId: string, cleanVideoUrl: string) {
  if (!settings.outputDir.trim()) return null;
  await fs.mkdir(settings.outputDir, { recursive: true });
  const response = await fetch(cleanVideoUrl);
  if (!response.ok) {
    throw new Error(`下载去水印视频失败：HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("video/") && !contentType.includes("application/octet-stream")) {
    throw new Error(`下载结果不是视频文件：Content-Type ${contentType || "unknown"}`);
  }

  const outputPath = path.join(settings.outputDir, `${requestId}.mp4`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new Error("下载到的去水印 MP4 文件为空");
  }
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}

async function downloadRawVideoIfNeeded(settings: AppSettings, requestId: string, rawVideoUrl: string) {
  if (!settings.outputDir.trim()) return null;
  await fs.mkdir(settings.outputDir, { recursive: true });
  const response = await fetch(rawVideoUrl);
  if (!response.ok) {
    throw new Error(`下载原始视频失败：HTTP ${response.status}`);
  }
  const outputPath = path.join(settings.outputDir, `${requestId}.mp4`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new Error("下载到的原始视频文件为空");
  }
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}

function postCallback(request: ApiRequest) {
  if (!request.callbackUrl) return;

  const previous = callbackQueues.get(request.requestId) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await fetch(request.callbackUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPoolJobView(request)),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
      }).catch(() => undefined);
    });
  callbackQueues.set(request.requestId, current);
  void current.then(() => {
    if (callbackQueues.get(request.requestId) === current) callbackQueues.delete(request.requestId);
  });
}

async function runPageScript<T>(win: BrowserWindow, script: string) {
  if (win.isDestroyed()) throw new Error("豆包执行窗口已关闭，停止本次执行");
  return withPageDeadline<T>(
    () => win.webContents.executeJavaScript(script, true) as Promise<T>,
    () => { if (!win.isDestroyed()) win.destroy(); }
  );
}

async function getPageText(win: BrowserWindow) {
  return runPageScript<string>(win, `(document.body?.innerText || "").replace(/\\s+/g, " ").trim()`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "执行器未知错误";
}

function operationAction(message: string, status?: ApiRequestStatus) {
  if (status === "success") return "任务完成";
  if (status === "failed") return "任务失败";
  if (message.includes("上传参考图")) return "上传参考图";
  if (message.includes("填写提示词")) return "填写提示词";
  if (message.includes("切换豆包视频生成模式")) return "切换视频生成模式";
  if (message.includes("提交豆包")) return "提交视频任务";
  if (message.includes("复制分享")) return "复制分享地址";
  if (message.includes("去水印")) return "去水印解析";
  if (message.includes("等待视频") || message.includes("定位豆包")) return "等待视频结果";
  return "任务进度";
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds} 秒`;
}

function formatWatermarkResolution(input: { elapsedMs: number; retryCount: number }) {
  return `耗时 ${formatElapsed(input.elapsedMs)}，第 ${input.retryCount + 1} 次解析`;
}

function isRefundableExecutionError(error: unknown) {
  return error instanceof DoubaoPageFailureError && error.refundQuota;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
