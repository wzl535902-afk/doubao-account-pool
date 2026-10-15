import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, session } from "electron";
import log from "electron-log/main.js";
import { AppDatabase } from "./database.js";
import { DoubaoExecutor } from "./executor.js";
import { toPublicApiRequest } from "./public-api.js";
import type {
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoModel,
  GenerateRequestBody
} from "./types.js";
import { isImageModel, modelCost } from "./types.js";
import { resolveCleanVideoUrl } from "./watermark.js";

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
          api: this.getStatus()
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
        const prompt = body.prompt?.trim();
        if (!prompt) {
          sendJson(response, 400, { error: "prompt is required" });
          return;
        }

        const model = normalizeModel(body.model || settings.defaultModel);
        if (!model) {
          sendJson(response, 400, { error: "unsupported model" });
          return;
        }

        const referenceImagePaths = await prepareReferenceImages(body, requestId);
        const referenceImagePath = referenceImagePaths[0] || null;
        // api_requests.aspect_ratio 为 NOT NULL：缺省用 16:9 兜底，避免整单在入库阶段炸掉。
        const aspectRatio = typeof body.aspectRatio === "string" && body.aspectRatio.trim() ? body.aspectRatio.trim() : "16:9";
        const resolution = typeof body.resolution === "string" && body.resolution.trim() ? body.resolution.trim() : null;
        const imageCount = Math.min(4, Math.max(1, Number(body.count ?? body.n ?? 1) || 1));
        const account = settings.executorEnabled
          ? this.database.reserveAvailableAccount(model)
          : this.database.findAvailableAccount(model);
        const cost = modelCost(settings, model);

        if (!account) {
          const failed = this.database.createApiRequest({
            requestId,
            source: body.source,
            model,
            status: "failed",
            message: "没有可用账号，或该模型剩余额度不足",
            prompt,
            referenceImagePath,
            referenceImagePaths,
            aspectRatio,
            resolution,
            imageCount,
            removeWatermark: true,
            callbackUrl: body.callbackUrl
          });
          this.database.appendOperationLog({
            requestId,
            action: "分配账号",
            status: "failed",
            message: failed.message
          });
          notifyDataChanged();
          void postCallback(failed);
          sendJson(response, 409, toPublicApiRequest(failed));
          return;
        }

        this.database.deductQuota(account.id, model);
        const created = this.database.createApiRequest({
          requestId,
          source: body.source,
          model,
          accountId: account.id,
          status: "accepted",
          message: settings.executorEnabled
            ? `已接收，已预扣 ${cost} 额度，已进入执行队列`
            : `已接收，已预扣 ${cost} 额度，自动执行已关闭`,
          prompt,
          referenceImagePath,
          referenceImagePaths,
          aspectRatio,
          resolution,
          imageCount,
          removeWatermark: body.removeWatermark ?? true,
          callbackUrl: body.callbackUrl
        });
        if (settings.executorEnabled) {
          this.requestExecutor.enqueue(created.requestId);
        }
        this.database.appendOperationLog({
          requestId,
          accountId: account.id,
          action: "接收接口请求",
          status: "success",
          message: created.message
        });
        notifyDataChanged();
        void postCallback(created);
        sendJson(response, 202, toPublicApiRequest(created));
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
        if (!apiRequest.accountId) {
          sendJson(response, 409, { error: "request has no assigned account" });
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
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/requests/")) {
        const requestId = decodeURIComponent(requestUrl.pathname.replace("/api/requests/", ""));
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(apiRequest));
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
  const updated = db.updateAccount({
    id: accountId,
    loginStatus,
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
    source: fields.source || "multipart-api"
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
    body: JSON.stringify(toPublicApiRequest(payload))
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
    executor = new DoubaoExecutor(db, notifyDataChanged);
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
  await apiServer?.stop();
});

app.on("window-all-closed", () => {
  // 内嵌模式：执行器窗口开合不得触发退出（生命周期归宿主）
  if (process.platform !== "darwin" && !embeddedMode) {
    app.quit();
  }
});
