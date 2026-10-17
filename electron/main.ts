import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, session } from "electron";
import log from "electron-log/main.js";
import { AppDatabase } from "./database.js";
import { DoubaoExecutor } from "./executor.js";
import { toPoolJobView } from "./public-api.js";
import { inspectMediaPageKind } from "./media-compatibility.js";
import { RequestSupervisor } from "./request-supervisor.js";
import {
  ERROR_CODES,
  normalizeClientRequestId,
  normalizeQueueTimeoutSeconds,
  parseAccountIdList,
  parseOptionalAccountId
} from "./request-lifecycle.js";
import { normalizeVideoDuration } from "./video-duration.js";
import type {
  AccountUpdateInput,
  ApiRequest,
  ApiRequestStatus,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoModel,
  GenerateRequestBody
} from "./types.js";
import { isImageModel, modelCost } from "./types.js";
import { resolveCleanVideoUrl } from "./watermark.js";
import { findEarlierResultCollision, resultCollisionMessage } from "./result-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 号池全部流量都是国内字节域名：强制直连，绕过系统代理，
// 避免 FlClash 等代理把 tos-lf-x.snssdk.com（图片上传存储）分流到坏节点导致上传失败。
app.commandLine.appendSwitch("no-proxy-server");
// 保持后台/被遮挡窗口不被降级（豆包页面在 hidden 状态下会挂起编辑器与上传）。
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let mainWindow: BrowserWindow | null = null;
// 内嵌模式（作为天衍子进程运行）：--embedded 或 DOUBAO_POOL_EMBEDDED=1
// 不创建管理器窗口，只保留 API 服务 + 执行器；窗口生命周期由宿主（天衍）管理。
const embeddedMode =
  process.argv.includes("--embedded") || process.env.DOUBAO_POOL_EMBEDDED === "1";
if (embeddedMode) {
  // 内嵌模式：宿主（天衍）请求退出时优雅收尾
  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
}
let db: AppDatabase;
let executor: DoubaoExecutor;
let apiServer: LocalApiServer;
let supervisor: RequestSupervisor;

/** 执行器协议 v2 能力声明（31423 据此判断能否走 /v2/jobs 映射）。 */
const POOL_PROTOCOL = {
  name: "pool-v2",
  version: 1,
  features: ["idempotency", "queue", "phases", "error-codes", "heartbeat", "watchdog", "abandon", "recover-guard", "full-view", "list"]
} as const;

const REQUEST_STATUSES: ApiRequestStatus[] = ["queued", "accepted", "running", "success", "failed", "stopped"];

function requestView(request: ApiRequest, extra: { logs?: boolean; idempotentReplay?: boolean } = {}) {
  return toPoolJobView(request, {
    tracked: executor?.isTracked(request.requestId) ?? false,
    idempotentReplay: extra.idempotentReplay,
    logs: extra.logs ? db.listOperationLogsForRequest(request.requestId) : undefined
  });
}

function paramError(response: ServerResponse, message: string) {
  sendJson(response, 400, { error: message, code: "PARAM_INVALID", category: ERROR_CODES.PARAM_INVALID.category });
}

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

class LocalApiServer {
  private server: Server | null = null;
  private status: ApiServerStatus = {
    version: app.getVersion(),
    enabled: false,
    running: false,
    port: 0,
    url: null,
    message: "未启动"
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly requestExecutor: DoubaoExecutor
  ) {}

  async applySettings(settings: AppSettings) {
    await this.stop();

    this.status = {
      version: app.getVersion(),
      enabled: settings.apiServiceEnabled,
      running: false,
      port: settings.apiPort,
      url: null,
      message: settings.apiServiceEnabled ? "启动中" : "已关闭"
    };

    if (!settings.apiServiceEnabled) return this.status;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server!.once("error", (error) => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: false,
          port: settings.apiPort,
          url: null,
          message: `启动失败：${error.message}`
        };
        resolve();
      });

      this.server!.listen(settings.apiPort, "127.0.0.1", () => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: true,
          port: settings.apiPort,
          url: `http://127.0.0.1:${settings.apiPort}`,
          message: "运行中"
        };
        resolve();
      });
    });

    return this.status;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  getStatus() {
    return this.status;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const settings = this.database.getSettings();

    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "doubao-account-pool",
          api: this.getStatus(),
          protocol: POOL_PROTOCOL
        });
        return;
      }

      if (!isAuthorized(request, settings.apiKey)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
        sendJson(response, 200, { accounts: this.database.listAccounts() });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/accounts") {
        // 创建账号（天衍账号中心内嵌使用；body 可选 {remark}）
        let remark = "";
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const text = Buffer.concat(chunks).toString("utf8").trim();
          if (text) {
            const parsed = JSON.parse(text) as { remark?: unknown };
            remark = typeof parsed.remark === "string" ? parsed.remark.trim() : "";
          }
        } catch {
          /* 忽略非法 body，按空备注创建 */
        }
        const account = this.database.createAccount({ remark: remark || undefined });
        recordOperation(null, account.id, "创建账号", "success", `已创建 ${account.partition}`);
        sendJson(response, 200, { ok: true, account });
        return;
      }

      // ── 豆包号池：从账号枢纽导入会话（hub → pool 桥，与 tokenfree 桥同构） ──
      if (request.method === "POST" && requestUrl.pathname === "/api/accounts/import") {
        let hint = "";
        let cookieHeader = "";
        let hubId = "";
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            hint?: unknown;
            cookieHeader?: unknown;
            hubId?: unknown;
          };
          hint = typeof parsed.hint === "string" ? parsed.hint.trim() : "";
          cookieHeader = typeof parsed.cookieHeader === "string" ? parsed.cookieHeader.trim() : "";
          hubId = typeof parsed.hubId === "string" ? parsed.hubId.trim() : "";
        } catch {
          /* fallthrough */
        }
        if (!hint || !cookieHeader) {
          sendJson(response, 400, { error: "hint and cookieHeader are required" });
          return;
        }
        // find-or-create：幂等键优先 hubId（藏进 name 字段做匹配），显示名用 hint（=label）
        // 兼容历史：早期 remark 直接存过 hubId/accountId
        let account = this.database
          .listAccounts()
          .find(
            (item) =>
              (hubId !== "" && item.name === hubId) ||
              item.remark === hint ||
              (hubId !== "" && item.remark === hubId),
          );
        if (!account) {
          account = this.database.createAccount({ remark: hint });
          recordOperation(null, account.id, "同步枢纽账号", "success", `已从账号枢纽接入 ${hint}`);
        }
        if (account && hint !== "" && hint !== hubId && account.remark !== hint) {
          // 显示名自愈：历史遗留（remark=ID）刷新为当前显示名（label）
          this.database.updateAccount({ id: account.id, remark: hint });
        }
        const accountSession = session.fromPartition(account.partition);
        // 先清旧 doubao cookie 再灌注（重登录场景防串味）
        const stale = await accountSession.cookies.get({});
        for (const cookie of stale) {
          if (typeof cookie.domain === "string" && /(^|\.)doubao\.com$/u.test(cookie.domain)) {
            const host = cookie.domain.replace(/^\./u, "");
            const cookiePath = cookie.path?.startsWith("/") ? cookie.path : "/";
            await accountSession.cookies
              .remove(`${cookie.secure ? "https" : "http"}://${host}${cookiePath}`, cookie.name)
              .catch(() => undefined);
          }
        }
        let imported = 0;
        for (const pair of cookieHeader.split(";")) {
          const index = pair.indexOf("=");
          if (index <= 0) continue;
          const name = pair.slice(0, index).trim();
          const value = pair.slice(index + 1).trim();
          if (!name) continue;
          try {
            await accountSession.cookies.set({
              url: "https://www.doubao.com/",
              name,
              value,
              domain: ".doubao.com",
              path: "/",
              secure: true,
              // 关键：不给期限 = 会话级 cookie，只存内存——号池进程一重启（换构建/自愈）就全丢，
              // 表现为"账号老是掉登录"。给 30 天持久期，写进磁盘 Cookie 库，重启不丢。
              expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
            });
            imported += 1;
          } catch {
            /* 单个 cookie 失败不阻塞 */
          }
        }
        const updated = await detectLoginStatus(account.id);
        sendJson(response, 200, { ok: true, imported, account: updated });
        return;
      }

      // ── 豆包号池：登录窗口流（供天衍账号中心内嵌展示二维码） ──
      const poolLoginMatch = requestUrl.pathname.match(/^\/api\/accounts\/(\d+)\/login$/u);
      if (request.method === "POST" && poolLoginMatch) {
        const accountId = Number(poolLoginMatch[1]);
        const account = this.database.getAccount(accountId);
        if (!account) {
          sendJson(response, 404, { error: "account not found" });
          return;
        }
        ensureLoginWindow(accountId);
        void detectLoginStatus(accountId).catch(() => undefined);
        sendJson(response, 200, { ok: true, account: this.database.getAccount(accountId) });
        return;
      }

      const poolQrMatch = requestUrl.pathname.match(/^\/api\/accounts\/(\d+)\/login-qr$/u);
      if (request.method === "GET" && poolQrMatch) {
        const accountId = Number(poolQrMatch[1]);
        const account = this.database.getAccount(accountId);
        if (!account) {
          sendJson(response, 404, { error: "account not found" });
          return;
        }
        const loginWindow = ensureLoginWindow(accountId);
        const updated = await detectLoginStatus(accountId).catch(() => this.database.getAccount(accountId));
        if (updated?.loginStatus === "logged_in") {
          if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.close();
          }
          sendJson(response, 200, { status: "logged_in", account: updated });
          return;
        }
        try {
          await ensureDoubaoLoginModal(loginWindow);
          const image = await loginWindow.webContents.capturePage();
          const png = image.toPNG();
          response.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "authorization, content-type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
          });
          response.end(png);
        } catch (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : "capture failed"
          });
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate") {
        const requestId = `doubao-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const body = await readGenerateRequest(request, requestId);

        // 执行器协议 v2：幂等键。重复提交只返回已有请求，绝不二次生成或扣额度（铁律 1）。
        let clientRequestId: string | null;
        try {
          clientRequestId = normalizeClientRequestId(body.clientRequestId);
        } catch (error) {
          paramError(response, error instanceof Error ? error.message : "invalid clientRequestId");
          return;
        }
        if (clientRequestId) {
          const existing = this.database.getApiRequestByClientRequestId(clientRequestId);
          if (existing) {
            sendJson(response, 200, requestView(existing, { idempotentReplay: true }));
            return;
          }
        }

        const prompt = body.prompt?.trim();
        if (!prompt) {
          paramError(response, "prompt is required");
          return;
        }

        const model = normalizeModel(body.model || settings.defaultModel);
        if (!model) {
          paramError(response, "unsupported model");
          return;
        }

        let durationSeconds: number | null = null;
        try {
          if (!isImageModel(model)) durationSeconds = normalizeVideoDuration(body.durationSeconds ?? body.duration);
        } catch (error) {
          paramError(response, error instanceof Error ? error.message : "invalid video duration");
          return;
        }
        const preferredAccountId = parseOptionalAccountId(body.accountId);
        if (Number.isNaN(preferredAccountId)) {
          paramError(response, "accountId must be a positive integer");
          return;
        }
        const excludeAccountIds = parseAccountIdList(body.excludeAccountIds);
        const queueFlag = typeof body.queue === "string" ? parseOptionalBoolean(body.queue) : body.queue ?? undefined;
        // 旧调用方（无 clientRequestId）保持原行为：无空闲账号立即失败；v2 调用方默认排队。
        const allowQueue = queueFlag ?? Boolean(clientRequestId);
        const queueTimeoutSeconds = normalizeQueueTimeoutSeconds(body.queueTimeoutSeconds);

        const referenceImagePaths = await prepareReferenceImages(body, requestId);
        const referenceImagePath = referenceImagePaths[0] || null;
        // api_requests.aspect_ratio 为 NOT NULL：缺省用 16:9 兜底，避免整单在入库阶段炸掉。
        const aspectRatio = typeof body.aspectRatio === "string" && body.aspectRatio.trim() ? body.aspectRatio.trim() : "16:9";
        const resolution = typeof body.resolution === "string" && body.resolution.trim() ? body.resolution.trim() : null;
        const imageCount = Math.min(4, Math.max(1, Number(body.count ?? body.n ?? 1) || 1));
        const parentRequestId = typeof body.parentRequestId === "string" && body.parentRequestId.trim()
          ? body.parentRequestId.trim().slice(0, 128)
          : null;

        // 幂等检查、选号、预扣、入库在同一个事务内完成（参考图下载等 await 之后再次检查幂等键）。
        const admitted = this.database.admitGenerateRequest({
          requestId,
          clientRequestId,
          parentRequestId,
          source: body.source,
          model,
          prompt,
          referenceImagePath,
          referenceImagePaths,
          aspectRatio,
          resolution,
          imageCount,
          durationSeconds,
          removeWatermark: body.removeWatermark ?? true,
          callbackUrl: body.callbackUrl,
          executorEnabled: settings.executorEnabled,
          allowQueue,
          queueTimeoutSeconds,
          selection: { accountId: preferredAccountId, excludeAccountIds }
        });

        if (admitted.outcome === "replay") {
          sendJson(response, 200, requestView(admitted.request, { idempotentReplay: true }));
          return;
        }

        if (admitted.outcome === "accepted") {
          if (settings.executorEnabled) {
            this.requestExecutor.enqueue(admitted.request.requestId);
          }
          this.database.appendOperationLog({
            requestId,
            accountId: admitted.account.id,
            action: "接收接口请求",
            status: "success",
            message: admitted.request.message
          });
        } else if (admitted.outcome === "queued") {
          this.database.appendOperationLog({
            requestId,
            action: "排队等待账号",
            status: "info",
            message: admitted.request.message
          });
        } else {
          this.database.appendOperationLog({
            requestId,
            action: "分配账号",
            status: "failed",
            message: admitted.request.message
          });
        }
        notifyDataChanged();
        void postCallback(admitted.request);
        sendJson(response, admitted.outcome === "rejected" ? 409 : 202, requestView(admitted.request));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/requests") {
        const statusParam = requestUrl.searchParams.get("status");
        const statuses = statusParam
          ? statusParam.split(",").map((item) => item.trim()).filter((item): item is ApiRequestStatus =>
            (REQUEST_STATUSES as string[]).includes(item))
          : undefined;
        const since = requestUrl.searchParams.get("since");
        if (since && Number.isNaN(Date.parse(since))) {
          paramError(response, "since must be an ISO timestamp");
          return;
        }
        const requests = this.database.queryApiRequests({
          statuses,
          since: since ? new Date(since).toISOString() : null,
          source: requestUrl.searchParams.get("source"),
          clientRequestIdPrefix: requestUrl.searchParams.get("clientRequestIdPrefix"),
          limit: Number(requestUrl.searchParams.get("limit") || 100)
        });
        sendJson(response, 200, {
          serverTime: new Date().toISOString(),
          protocol: POOL_PROTOCOL,
          requests: requests.map((item) => requestView(item))
        });
        return;
      }

      const abandonMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/abandon$/);
      if (request.method === "POST" && abandonMatch) {
        const requestId = decodeURIComponent(abandonMatch[1]);
        const result = supervisor.abandon(requestId);
        if (result.httpStatus === 404) {
          sendJson(response, 404, { error: "request not found", code: "JOB_NOT_FOUND" });
          return;
        }
        notifyDataChanged();
        if (result.httpStatus === 409) {
          sendJson(response, 409, {
            error: "任务已提交到豆包，不能放弃；请等待结果或在失败后「找回结果」",
            code: result.code,
            request: requestView(result.request)
          });
          return;
        }
        sendJson(response, result.httpStatus, {
          ...requestView(result.request),
          alreadyFinished: result.httpStatus === 200 ? result.alreadyFinished : false
        });
        return;
      }

      const recoveryMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/retry-result$/);
      if (request.method === "POST" && recoveryMatch) {
        const requestId = decodeURIComponent(recoveryMatch[1]);
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (isImageModel(apiRequest.model)) {
          sendJson(response, 409, { error: "图片请求不支持找回结果，请重新提交", code: "RECOVER_UNSUPPORTED" });
          return;
        }
        if (
          apiRequest.status === "queued" ||
          apiRequest.status === "accepted" ||
          apiRequest.status === "running" ||
          this.requestExecutor.isTracked(requestId)
        ) {
          sendJson(response, 409, { error: "请求仍在进行中，不能同时找回", code: "JOB_ACTIVE", request: requestView(apiRequest) });
          return;
        }
        if (apiRequest.status === "success") {
          // 唯一例外：结果与更早的请求重复（误认了别人的视频），允许回到本次会话重新找回。
          const collision = findEarlierResultCollision(apiRequest, this.database.listDeliveredVideoResults(requestId));
          if (!collision) {
            sendJson(response, 409, { error: "请求已成功，无需找回", code: "ALREADY_SUCCEEDED", request: requestView(apiRequest) });
            return;
          }
          this.database.appendOperationLog({
            requestId,
            accountId: apiRequest.accountId,
            action: "结果校验",
            status: "failed",
            message: resultCollisionMessage(collision),
            targetUrl: apiRequest.cleanVideoUrl || apiRequest.rawVideoUrl || undefined
          });
        }
        if (apiRequest.errorCode && !apiRequest.submittedAt && apiRequest.errorCode !== "RECOVER_NOT_FOUND") {
          sendJson(response, 409, { error: "该请求从未提交到豆包，没有可找回的结果；请重新提交", code: "NOTHING_TO_RECOVER", request: requestView(apiRequest) });
          return;
        }
        if (!apiRequest.accountId) {
          sendJson(response, 409, { error: "request has no assigned account", code: "NOTHING_TO_RECOVER" });
          return;
        }
        this.requestExecutor.enqueueRecovery(requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: apiRequest.accountId,
          action: "恢复视频结果",
          status: "info",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        sendJson(response, 202, {
          requestId,
          status: "accepted",
          message: "已进入结果恢复队列，不会重新提交视频生成",
          request: requestView(apiRequest)
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/requests/")) {
        const requestId = decodeURIComponent(requestUrl.pathname.replace("/api/requests/", ""));
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found", code: "JOB_NOT_FOUND" });
          return;
        }
        sendJson(response, 200, requestView(apiRequest, { logs: requestUrl.searchParams.get("view") === "full" }));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/watermark/parse") {
        const body = await readJsonBody<{ url?: string }>(request);
        const sourceUrl = body.url?.trim();
        if (!sourceUrl) {
          sendJson(response, 400, { error: "url is required" });
          return;
        }
        try {
          const cleanVideoUrl = await resolveCleanVideoUrl(settings, sourceUrl);
          recordOperation(null, null, "独立去水印解析", "success", "已验证真实 MP4 地址", sourceUrl);
          sendJson(response, 200, {
            status: "success",
            message: "去水印 MP4 地址已验证",
            cleanVideoUrl,
            outputVideoPath: null
          });
        } catch (error) {
          recordOperation(
            null,
            null,
            "独立去水印解析",
            "failed",
            error instanceof Error ? error.message : "去水印解析失败",
            sourceUrl
          );
          sendJson(response, 422, {
            status: "failed",
            message: error instanceof Error ? error.message : "去水印解析失败",
            cleanVideoUrl: null,
            outputVideoPath: null
          });
        }
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "豆包账号池接口服务",
    webPreferences: {
      preload: path.join(__dirname, "preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

const doubaoWindows = new Map<number, BrowserWindow>();

/** 已触发过登录弹窗的窗口（每窗口只点一次"登录"） */
const loginModalOpened = new WeakSet<BrowserWindow>();

/** 自动点开豆包登录弹窗（登录二维码在里面）。 */
async function openDoubaoLoginModal(win: BrowserWindow): Promise<boolean> {
  try {
    const result = await win.webContents.executeJavaScript(
      `(() => {
        const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, div, span"));
        const target = candidates.find((el) => {
          if (!el.offsetParent) return false;
          const text = (el.textContent || "").trim();
          return text === "登录" || text === "登录/注册" || text === "立即登录";
        });
        if (target) {
          target.click();
          return "clicked:" + target.tagName;
        }
        return "";
      })()`,
      true
    );
    return Boolean(result);
  } catch {
    return false;
  }
}

/** 确保登录弹窗已点开（含等待渲染），每窗口一次。 */
async function ensureDoubaoLoginModal(win: BrowserWindow): Promise<void> {
  if (loginModalOpened.has(win)) return;
  const clicked = await openDoubaoLoginModal(win);
  if (clicked) {
    loginModalOpened.add(win);
    await new Promise((resolve) => setTimeout(resolve, 2300));
  }
}

/**
 * 幽灵登录窗口：上屏渲染（capturePage 需要真实渲染）但完全不可见、鼠标穿透。
 * 天衍账号中心通过 /api/accounts/:id/login-qr 拉取窗口截图展示二维码。
 */
function ensureLoginWindow(accountId: number) {
  const existing = doubaoWindows.get(accountId);
  if (existing && !existing.isDestroyed()) {
    if (!existing.isVisible()) existing.showInactive();
    return existing;
  }
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");
  const titleName = account.remark || account.name;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    x: -32000,
    y: -32000,
    show: true,
    skipTaskbar: true,
    focusable: false,
    title: `豆包登录 - ${titleName}`,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  // 离屏渲染（opacity:0 会导致 capturePage 拿不到像素——0字节空图，实测踩坑）。
  doubaoWindows.set(accountId, win);
  win.on("closed", () => {
    if (doubaoWindows.get(accountId) === win) {
      doubaoWindows.delete(accountId);
    }
  });
  void win.loadURL("https://www.doubao.com/chat");
  // 页面就绪后自动点开登录弹窗（二维码）
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        void ensureDoubaoLoginModal(win);
      }
    }, 2500);
  });
  return win;
}

function createDoubaoWindow(accountId: number) {
  const existing = doubaoWindows.get(accountId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const titleName = account.remark || account.name;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    title: `豆包 - ${titleName}`,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  doubaoWindows.set(accountId, win);
  win.on("closed", () => {
    if (doubaoWindows.get(accountId) === win) {
      doubaoWindows.delete(accountId);
    }
  });
  void win.loadURL("https://www.doubao.com/chat");
  return win;
}

async function detectLoginStatus(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  const cookies = await accountSession.cookies.get({ url: "https://www.doubao.com" });
  // 匿名落地页也会种 cookie（ttwid/passport_csrf_token 等匿名也有）——必须按"真登录态
  // 独有 cookie"判定（2026-10-14 实测对照：sessionid/sid_tt/sid_guard/user_token/
  // multi_sids/passport_auth_status 系仅在登录后出现）。
  const authCookiePattern =
    /^(sessionid|sessionid_ss|sid_tt|sid_guard|sid_ucp_v1|ssid_ucp_v1|uid_tt|uid_tt_ss|user_token|multi_sids|passport_auth_status|passport_auth_status_ss|session_tlb_tag)$/i;
  const hasAuthCookie = cookies.some((cookie) => authCookiePattern.test(cookie.name));
  const loginStatus = hasAuthCookie ? "logged_in" : "logged_out";
  // 诊断日志（天衍日志可见）：便于日后核对 cookie 命名
  console.log(
    `[login-check] account=${accountId} cookies=[${cookies.map((cookie) => cookie.name).join(",")}] -> ${loginStatus}`
  );
  const activeRequest = db.listApiRequests(1000).some((request) =>
    request.accountId === accountId && (request.status === "accepted" || request.status === "running")
  );
  // Probe only an already-open account window. Login/readiness checks must not
  // launch a browser or consume quota. A failed/unfinished probe is not a logout.
  let mediaPageKind = loginStatus === "logged_out" ? "unknown" as const : account.mediaPageKind ?? "unknown";
  const existingWindow = doubaoWindows.get(accountId);
  if (loginStatus === "logged_in" && existingWindow && !existingWindow.isDestroyed()) {
    const observed = await inspectMediaPageKind(existingWindow.webContents);
    if (observed !== "unknown") mediaPageKind = observed;
  }
  const updated = db.updateAccount({
    id: accountId,
    loginStatus,
    mediaPageKind,
    currentStatus: cookies.length > 0
      ? activeRequest
        ? "busy"
        : "idle"
      : "login_required"
  });

  if (loginStatus === "logged_in" && account.loginStatus !== "logged_in") {
    const win = doubaoWindows.get(accountId);
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.setPosition(-32000, -32000);
      win.setSkipTaskbar(true);
      recordOperation(null, accountId, "登录成功自动隐身", "success", "账号窗口已移至屏幕外，生成任务将在后台隐形执行");
    }
  }

  return updated;
}

async function detectAllLoginStatuses() {
  const accounts = db.listAccounts();
  for (const account of accounts) {
    await detectLoginStatus(account.id);
  }
  return db.listAccounts();
}

async function clearAccountSession(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  return db.updateAccount({
    id: accountId,
    loginStatus: "logged_out",
    currentStatus: "login_required"
  });
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => db.listAccounts());
  ipcMain.handle("accounts:create", (_event, remark?: string) => {
    const account = db.createAccount({ remark });
    recordOperation(null, account.id, "创建账号", "success", `已创建 ${account.partition}`);
    return account;
  });
  ipcMain.handle("accounts:update", (_event, input: AccountUpdateInput) => {
    const account = db.updateAccount(input);
    recordOperation(null, account.id, "修改账号设置", "success", "已保存账号备注和额度设置");
    return account;
  });
  ipcMain.handle("accounts:delete", async (_event, id: number) => {
    const account = db.getAccount(id);
    await clearAccountSession(id);
    db.deleteAccount(id);
    recordOperation(null, id, "删除账号", "success", `已删除 ${account?.partition || id}`);
    return true;
  });
  ipcMain.handle("accounts:open", (_event, id: number) => {
    const result = createDoubaoWindow(id);
    recordOperation(null, id, "打开豆包窗口", "success", "已打开独立账号窗口");
    return result;
  });
  ipcMain.handle("accounts:relogin", async (_event, id: number) => {
    await clearAccountSession(id);
    createDoubaoWindow(id);
    recordOperation(null, id, "重新登录账号", "success", "已清空登录状态并打开登录窗口");
    return true;
  });
  ipcMain.handle("accounts:detect-login", async (_event, id: number) => {
    const account = await detectLoginStatus(id);
    recordOperation(null, id, "检测登录状态", "success", `当前状态：${account.loginStatus}`);
    return account;
  });
  ipcMain.handle("accounts:detect-all", async () => {
    const accounts = await detectAllLoginStatuses();
    recordOperation(null, null, "检测全部账号", "success", `已检测 ${accounts.length} 个账号`);
    return accounts;
  });
  ipcMain.handle("accounts:reset-quota", (_event, id: number) => {
    const accounts = db.resetAccountQuota(id);
    recordOperation(null, id, "重置账号额度", "success", "已重置今日额度");
    return accounts;
  });
  ipcMain.handle("accounts:reset-all-quotas", () => {
    const accounts = db.resetAllQuotas();
    recordOperation(null, null, "重置全部额度", "success", `已重置 ${accounts.length} 个账号`);
    return accounts;
  });

  ipcMain.handle("settings:get", () => db.getSettings());
  ipcMain.handle("settings:update", async (_event, input: AppSettingsUpdateInput) => {
    const settings = db.updateSettings(input);
    await apiServer.applySettings(settings);
    recordOperation(null, null, "保存配置", "success", "配置已保存并应用");
    return settings;
  });

  ipcMain.handle("api-server:status", () => apiServer.getStatus());
  ipcMain.handle("api-server:restart", async () => apiServer.applySettings(db.getSettings()));

  ipcMain.handle("api-requests:list", (_event, limit?: number) => db.listApiRequests(limit || 100));
  ipcMain.handle("api-requests:clear", () => {
    db.clearApiRequests();
    return true;
  });
  ipcMain.handle("operation-logs:list", (_event, limit?: number) => db.listOperationLogs(limit || 500));
  ipcMain.handle("operation-logs:clear", () => {
    db.clearOperationLogs();
    return true;
  });
}

function recordOperation(
  requestId: string | null,
  accountId: number | null,
  action: string,
  status: "info" | "success" | "failed",
  message: string,
  targetUrl?: string | null
) {
  db.appendOperationLog({ requestId, accountId, action, status, message, targetUrl });
  notifyDataChanged();
}

function notifyDataChanged() {
  mainWindow?.webContents.send("data:changed");
}

function normalizeModel(model: string): DoubaoModel | null {
  if (model === "seedance_2_0_mini" || model === "seedance_2_0_fast" || model === "seedance_2_0") return model;
  if (isImageModel(model)) return model;
  return null;
}

function isAuthorized(request: IncomingMessage, apiKey: string) {
  if (!apiKey.trim()) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

async function readGenerateRequest(request: IncomingMessage, requestId: string): Promise<GenerateRequestBody> {
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartGenerateRequest(await readBufferBody(request), contentType, requestId);
  }
  return readJsonBody<GenerateRequestBody>(request);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const raw = (await readBufferBody(request)).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function readBufferBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseReferenceImagePathsField(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean).slice(0, 9);
      }
    } catch {
      return null;
    }
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 9);
}

async function parseMultipartGenerateRequest(buffer: Buffer, contentType: string, requestId: string): Promise<GenerateRequestBody> {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("multipart boundary is required");

  const fields: Record<string, string> = {};
  let uploadedReferenceImagePath: string | null = null;
  const uploadedReferenceImagePaths: string[] = [];
  const maxReferenceImages = 9;
  const delimiter = Buffer.from(`--${boundary}`);

  for (const rawPart of splitBuffer(buffer, delimiter)) {
    let part = rawPart;
    if (part.length === 0 || part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    if (!disposition.name) continue;

    if (disposition.filename) {
      if (uploadedReferenceImagePaths.length < maxReferenceImages && body.length > 0) {
        const savedPath = await saveUploadedFile({
          requestId,
          fieldName: disposition.name,
          filename: disposition.filename,
          contentType: headers["content-type"],
          bytes: body
        });
        uploadedReferenceImagePaths.push(savedPath);
        if (!uploadedReferenceImagePath) {
          uploadedReferenceImagePath = savedPath;
        }
      }
      continue;
    }

    fields[disposition.name] = body.toString("utf8");
  }

  return {
    model: fields.model as DoubaoModel | undefined,
    prompt: fields.prompt || "",
    referenceImagePath: uploadedReferenceImagePath || fields.referenceImagePath || null,
    referenceImagePaths: uploadedReferenceImagePaths.length
      ? uploadedReferenceImagePaths
      : parseReferenceImagePathsField(fields.referenceImagePaths),
    referenceImageUrl: fields.referenceImageUrl || null,
    removeWatermark: parseOptionalBoolean(fields.removeWatermark),
    callbackUrl: fields.callbackUrl || null,
    aspectRatio: fields.aspectRatio || null,
    resolution: fields.resolution || null,
    count: fields.count ? Number(fields.count) : undefined,
    durationSeconds: fields.durationSeconds ?? fields.duration,
    source: fields.source || "multipart-api",
    clientRequestId: fields.clientRequestId || null,
    parentRequestId: fields.parentRequestId || null,
    accountId: fields.accountId || null,
    excludeAccountIds: fields.excludeAccountIds || null,
    queue: fields.queue ?? null,
    queueTimeoutSeconds: fields.queueTimeoutSeconds ?? null
  };
}

async function prepareReferenceImages(body: GenerateRequestBody, requestId: string): Promise<string[]> {
  if (Array.isArray(body.referenceImagePaths) && body.referenceImagePaths.length > 0) {
    const paths = body.referenceImagePaths.map((item) => String(item).trim()).filter(Boolean).slice(0, 9);
    if (paths.length) return paths;
  }
  const single = await prepareReferenceImage(body, requestId);
  return single ? [single] : [];
}

async function prepareReferenceImage(body: GenerateRequestBody, requestId: string) {
  if (body.referenceImagePath?.trim()) return body.referenceImagePath.trim();
  const imageUrl = body.referenceImageUrl?.trim();
  if (!imageUrl) return null;

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`参考图下载失败：HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const urlExt = path.extname(new URL(imageUrl).pathname);
  const ext = urlExt || extensionFromContentType(contentType) || ".png";
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const imagePath = path.join(uploadDir, `${requestId}-reference${ext}`);
  await fs.writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
  return imagePath;
}

async function saveUploadedFile(input: {
  requestId: string;
  fieldName: string;
  filename: string;
  contentType?: string;
  bytes: Buffer;
}) {
  const safeName = sanitizeFilename(input.filename || `${input.fieldName}${extensionFromContentType(input.contentType) || ".png"}`);
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${input.requestId}-${input.fieldName}-${safeName}`);
  await fs.writeFile(filePath, input.bytes);
  return filePath;
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    if (index > start) {
      parts.push(buffer.subarray(start, index));
    }
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function parsePartHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value: string) {
  const result: { name?: string; filename?: string } = {};
  for (const item of value.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    const unquoted = rawValue.join("=").trim().replace(/^"|"$/g, "");
    if (key === "name") result.name = unquoted;
    if (key === "filename") result.filename = unquoted;
  }
  return result;
}

function parseOptionalBoolean(value: string | undefined) {
  if (value == null || value === "") return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function extensionFromContentType(contentType?: string) {
  if (!contentType) return null;
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return null;
}

function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[/\\?%*:|"<>]/g, "_").trim();
  return cleaned.slice(0, 120) || "reference-image";
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (statusCode === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

async function postCallback(payload: ApiRequest) {
  if (!payload.callbackUrl) return;
  await fetch(payload.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestView(payload)),
    signal: AbortSignal.timeout(5000)
  }).catch(() => undefined);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    log.initialize();
    db = new AppDatabase();
    executor = new DoubaoExecutor(db, notifyDataChanged, {
      onRunSettled: () => supervisor?.dispatchQueued()
    });
    supervisor = new RequestSupervisor({
      database: db,
      executor,
      onRequestChanged: (changed) => {
        notifyDataChanged();
        void postCallback(changed);
      }
    });
    // 启动清扫：上次进程留下的 accepted/running 都是孤儿（内存队列已丢失）。
    const swept = supervisor.sweepOrphans("restart");
    if (swept.length) log.warn(`启动清扫：收尾 ${swept.length} 个中断请求`, swept.map((item) => `${item.requestId}:${item.errorCode}`));
    supervisor.start();
    apiServer = new LocalApiServer(db, executor);
    registerIpc();
    await apiServer.applySettings(db.getSettings());
    if (!embeddedMode) {
      createMainWindow();

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createMainWindow();
        }
      });
    } else {
      log.info("号池以内嵌模式运行（无管理器窗口，等待天衍调度）");
    }
  }).catch((error) => {
    log.error(error);
  });
}

app.on("before-quit", async () => {
  supervisor?.stop();
  await apiServer?.stop();
});

app.on("window-all-closed", () => {
  // 内嵌模式：执行器窗口开合不得触发退出（生命周期归宿主）
  if (process.platform !== "darwin" && !embeddedMode) {
    app.quit();
  }
});
