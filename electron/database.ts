import path from "node:path";
import Database from "better-sqlite3";
import { app } from "electron";
import type {
  Account,
  AccountCreateInput,
  AccountRuntimeStatus,
  AccountUpdateInput,
  ApiRequest,
  ApiRequestCreateInput,
  ApiRequestStatus,
  ApiRequestUpdateInput,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoModel,
  OperationLog,
  OperationLogCreateInput
} from "./types.js";
import { modelCost } from "./types.js";
import { phaseForProgress, type ErrorCode } from "./request-lifecycle.js";

const now = () => new Date().toISOString();

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * 额度日（本地时区 YYYY-MM-DD）：以 dailyResetTime（HH:MM，本地时间）为日界。
 * 例如 dailyResetTime="04:00" 时，本地 03:59 仍算前一天的额度日。
 */
export const quotaDayKey = (at: Date, dailyResetTime: string): string => {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(dailyResetTime ?? "").trim());
  const offsetMinutes = match ? Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2])) : 0;
  const shifted = new Date(at.getTime() - offsetMinutes * 60_000);
  return `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}-${pad2(shifted.getDate())}`;
};

const API_REQUEST_COLUMNS = `
        api_requests.id,
        api_requests.request_id AS requestId,
        api_requests.source,
        api_requests.model,
        api_requests.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        api_requests.status,
        api_requests.message,
        api_requests.prompt,
        api_requests.reference_image_path AS referenceImagePath,
        api_requests.reference_image_paths AS referenceImagePaths,
        api_requests.remove_watermark AS removeWatermark,
        api_requests.callback_url AS callbackUrl,
        api_requests.retry_count AS retryCount,
        api_requests.doubao_thread_url AS doubaoThreadUrl,
        api_requests.raw_video_url AS rawVideoUrl,
        api_requests.clean_video_url AS cleanVideoUrl,
        api_requests.output_video_path AS outputVideoPath,
        api_requests.aspect_ratio AS aspectRatio,
        api_requests.duration_seconds AS durationSeconds,
        api_requests.resolution AS resolution,
        api_requests.image_count AS imageCount,
        api_requests.image_urls AS imageUrls,
        api_requests.output_image_paths AS outputImagePaths,
        api_requests.created_at AS createdAt,
        api_requests.updated_at AS updatedAt,
        api_requests.finished_at AS finishedAt,
        api_requests.client_request_id AS clientRequestId,
        api_requests.parent_request_id AS parentRequestId,
        api_requests.workflow_phase AS workflowPhase,
        api_requests.submitted_at AS submittedAt,
        api_requests.heartbeat_at AS heartbeatAt,
        api_requests.error_code AS errorCode,
        api_requests.quota_refunded AS quotaRefunded,
        api_requests.queue_deadline_at AS queueDeadlineAt,
        api_requests.preferred_account_id AS preferredAccountId,
        api_requests.exclude_account_ids AS excludeAccountIds`;

const ACTIVE_STATUSES = ["queued", "accepted", "running"] as const;

export interface AccountSelectionOptions {
  /** 严格指定账号；为空表示任意可用账号。 */
  accountId?: number | null;
  /** 本次不使用的账号。 */
  excludeAccountIds?: number[] | null;
}

export type AccountAvailability =
  | { available: true }
  | { available: false; couldBecomeAvailable: boolean; code: ErrorCode; message: string };

export interface AdmitGenerateInput extends Omit<ApiRequestCreateInput, "status" | "accountId" | "message"> {
  clientRequestId?: string | null;
  executorEnabled: boolean;
  /** 无空闲账号时是否允许排队。 */
  allowQueue: boolean;
  queueTimeoutSeconds: number;
  selection: AccountSelectionOptions;
}

export type AdmitGenerateResult =
  | { outcome: "replay"; request: ApiRequest }
  | { outcome: "accepted"; request: ApiRequest; account: Account; cost: number }
  | { outcome: "queued"; request: ApiRequest }
  | { outcome: "rejected"; request: ApiRequest; code: ErrorCode };

export interface ApiRequestQuery {
  limit?: number;
  statuses?: ApiRequestStatus[];
  /** 只返回 updated_at >= since 的请求（ISO 时间）。 */
  since?: string | null;
  source?: string | null;
  clientRequestIdPrefix?: string | null;
}

export interface FinalizeRequestInput {
  requestId: string;
  /** 只有当前状态属于这些值时才会写入（防止覆盖已成功/已失败的结果）。 */
  expectStatuses: ApiRequestStatus[];
  message: string;
  errorCode: ErrorCode;
  workflowPhase: string;
  refund: boolean;
  /** 若该账号上已没有其他活跃请求，则把账号置回 idle。 */
  releaseAccount: boolean;
}
const OPERATION_LOG_RETENTION_DAYS = 3;
const WORK_ONLY_MESSAGE = "已登录的账号都是豆包工作/飞书个人版，不支持普通豆包 Seedream/Seedance 模型；请登录普通豆包账号";

const DEFAULT_SETTINGS: AppSettings = {
  apiServiceEnabled: true,
  apiPort: 17888,
  apiKey: "local-doubao-key",
  executorEnabled: true,
  showExecutorWindow: false,
  autoCloseExecutorWindow: true,
  doubaoChatUrl: "https://www.doubao.com/chat",
  defaultModel: "seedance_2_0_mini",
  dailyQuotaLimit: 10,
  miniCost: 2,
  fastCost: 3,
  standardCost: 5,
  imageCost: 1,
  dailyResetTime: "00:00",
  generationTimeoutSeconds: 900,
  maxConcurrentAccounts: 4,
  retryCount: 1,
  accountSelectionMode: "sticky",
  accountCooldownSeconds: 300,
  requestRetryLimit: 1,
  autoRemoveWatermark: true,
  watermarkApiUrl: "https://nologo.code24.top/api/water-mask/parse",
  watermarkApiToken: "",
  outputDir: ""
};

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(dbPath = path.join(app.getPath("userData"), "doubao-manager.sqlite3")) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        partition TEXT NOT NULL UNIQUE,
        remark TEXT NOT NULL DEFAULT '',
        login_status TEXT NOT NULL DEFAULT 'unknown',
        current_status TEXT NOT NULL DEFAULT 'idle',
        daily_quota_limit INTEGER NOT NULL DEFAULT 10,
        quota_remaining INTEGER NOT NULL DEFAULT 10,
        quota_used_today INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL DEFAULT 'local',
        model TEXT NOT NULL,
        account_id INTEGER,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        reference_image_path TEXT,
        remove_watermark INTEGER NOT NULL DEFAULT 1,
        callback_url TEXT,
        doubao_thread_url TEXT,
        raw_video_url TEXT,
        clean_video_url TEXT,
        output_video_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        account_id INTEGER,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL DEFAULT '',
        target_url TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_operation_logs_request_id ON operation_logs(request_id);
    `);

    this.ensureAccountColumns();
    this.ensureApiRequestColumns();
    this.pruneOperationLogs();
    this.cleanInvalidSuccessfulResults();
    this.ensureDefaultSettings();
    this.migrateExecutorConcurrency();
  }

  listAccounts(): Account[] {
    this.rolloverDailyQuotas();
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        media_page_kind AS mediaPageKind,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_used_at AS lastUsedAt,
        cooldown_until AS cooldownUntil,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      ORDER BY id ASC
    `).all() as Account[];
  }

  getAccount(id: number): Account | undefined {
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        media_page_kind AS mediaPageKind,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_used_at AS lastUsedAt,
        cooldown_until AS cooldownUntil,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      WHERE id = ?
    `).get(id) as Account | undefined;
  }

  createAccount(input: AccountCreateInput = {}): Account {
    const timestamp = now();
    const settings = this.getSettings();
    const nextNumber = this.nextAccountNumber();
    const name = `账号 ${String(nextNumber).padStart(3, "0")}`;
    const partition = `persist:doubao_account_${String(nextNumber).padStart(3, "0")}`;

    const result = this.db.prepare(`
      INSERT INTO accounts (
        name,
        partition,
        remark,
        login_status,
        current_status,
        daily_quota_limit,
        quota_remaining,
        quota_used_today,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, 'unknown', 'login_required', ?, ?, 0, ?, ?)
    `).run(
      name,
      partition,
      input.remark?.trim() || "",
      settings.dailyQuotaLimit,
      settings.dailyQuotaLimit,
      timestamp,
      timestamp
    );

    return this.getAccount(Number(result.lastInsertRowid))!;
  }

  updateAccount(input: AccountUpdateInput): Account {
    const existing = this.getAccount(input.id);
    if (!existing) throw new Error("Account not found");

    const updated = {
      remark: input.remark ?? existing.remark,
      loginStatus: input.loginStatus ?? existing.loginStatus,
      mediaPageKind: input.mediaPageKind ?? (input.loginStatus === "logged_out" ? "unknown" : existing.mediaPageKind ?? "unknown"),
      currentStatus: input.currentStatus ?? existing.currentStatus,
      dailyQuotaLimit: input.dailyQuotaLimit ?? existing.dailyQuotaLimit,
      quotaRemaining: input.quotaRemaining ?? existing.quotaRemaining,
      quotaUsedToday: input.quotaUsedToday ?? existing.quotaUsedToday,
      updatedAt: now()
    };

    this.db.prepare(`
      UPDATE accounts
      SET
        remark = ?,
        login_status = ?,
        media_page_kind = ?,
        current_status = ?,
        daily_quota_limit = ?,
        quota_remaining = ?,
        quota_used_today = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updated.remark.trim(),
      updated.loginStatus,
      updated.mediaPageKind,
      updated.currentStatus,
      clampInt(updated.dailyQuotaLimit),
      clampInt(updated.quotaRemaining),
      clampInt(updated.quotaUsedToday),
      updated.updatedAt,
      input.id
    );

    return this.getAccount(input.id)!;
  }

  deleteAccount(id: number) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  resetAccountQuota(id: number): Account {
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        quota_day = ?,
        updated_at = ?
      WHERE id = ?
    `).run(this.currentQuotaDay(), now(), id);
    return this.getAccount(id)!;
  }

  resetAllQuotas(): Account[] {
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        quota_day = ?,
        updated_at = ?
    `).run(this.currentQuotaDay(), now());
    return this.listAccounts();
  }

  /** 当前额度日（按设置里的 dailyResetTime 切日）。 */
  currentQuotaDay(at: Date = new Date()): string {
    return quotaDayKey(at, this.getSettings().dailyResetTime);
  }

  /**
   * 每日额度自动回满。此前引擎只有手动「重置额度」，quota_used_today 会一直累加，
   * 账号用完一次就永久没额度（10-17 起豆包全部 NO_ACCOUNT_QUOTA 的根因）。
   *
   * 每个账号记自己的额度日 quota_day：
   * - quota_day 为空（老数据/新账号）：只补记，不清零。按 last_used_at 推断当天，
   *   从没用过的记为今天；这样迁移不会冲掉手动设置的额度。
   * - quota_day 不是当前额度日：额度回满（mini/fast/总额度），quota_day 记为今天。
   * 幂等、开销极小，可在任意读写入口前调用。返回本次回满的账号 id。
   */
  rolloverDailyQuotas(at: Date = new Date()): number[] {
    const resetTime = this.getSettings().dailyResetTime;
    const today = quotaDayKey(at, resetTime);
    return this.db.transaction(() => {
      const unstamped = this.db.prepare(`SELECT id, last_used_at AS lastUsedAt FROM accounts WHERE quota_day IS NULL`)
        .all() as Array<{ id: number; lastUsedAt: string | null }>;
      if (unstamped.length) {
        const stamp = this.db.prepare(`UPDATE accounts SET quota_day = ? WHERE id = ?`);
        for (const row of unstamped) {
          const used = row.lastUsedAt ? new Date(row.lastUsedAt) : null;
          const day = used && Number.isFinite(used.getTime()) ? quotaDayKey(used, resetTime) : today;
          stamp.run(day, row.id);
        }
      }
      const stale = this.db.prepare(`SELECT id FROM accounts WHERE quota_day != ?`).all(today) as Array<{ id: number }>;
      if (!stale.length) return [];
      const timestamp = now();
      const reset = this.db.prepare(`
        UPDATE accounts
        SET
          mini_remaining = mini_daily_limit,
          mini_used_today = 0,
          fast_remaining = fast_daily_limit,
          fast_used_today = 0,
          quota_remaining = daily_quota_limit,
          quota_used_today = 0,
          quota_day = ?,
          updated_at = ?
        WHERE id = ?
      `);
      for (const row of stale) reset.run(today, timestamp, row.id);
      return stale.map((row) => row.id);
    })();
  }

  /**
   * 把号池账号绑定到账号枢纽 ID（存在 name 字段，作为 hub↔pool 的稳定身份）。
   * 已被其他账号占用时不改，返回 false。
   */
  bindHubId(id: number, hubId: string): boolean {
    const value = String(hubId ?? "").trim();
    if (!value) return false;
    const owner = this.db.prepare(`SELECT id FROM accounts WHERE name = ? AND id != ?`).get(value, id);
    if (owner) return false;
    this.db.prepare(`UPDATE accounts SET name = ?, updated_at = ? WHERE id = ? AND name != ?`).run(value, now(), id, value);
    return true;
  }

  findAvailableAccount(model: DoubaoModel, options: AccountSelectionOptions = {}): Account | undefined {
    this.rolloverDailyQuotas();
    const settings = this.getSettings();
    const requiredQuota = modelCost(settings, model);
    const exclude = (options.excludeAccountIds ?? []).filter((id) => Number.isInteger(id));
    const filters: string[] = [];
    const params: unknown[] = [requiredQuota, now()];
    if (options.accountId != null) {
      filters.push("AND id = ?");
      params.push(options.accountId);
    }
    if (exclude.length) {
      filters.push(`AND id NOT IN (${exclude.map(() => "?").join(", ")})`);
      params.push(...exclude);
    }
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        media_page_kind AS mediaPageKind,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_used_at AS lastUsedAt,
        cooldown_until AS cooldownUntil,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      WHERE login_status = 'logged_in'
        AND media_page_kind != 'work'
        AND current_status IN ('idle', 'error')
        AND quota_remaining >= ?
        AND (cooldown_until IS NULL OR cooldown_until <= ?)
        ${filters.join("\n        ")}
      ORDER BY
        ${
          settings.accountSelectionMode === "lru"
            ? "CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END ASC, last_used_at ASC,"
            : "last_used_at DESC,"
        }
        id ASC
      LIMIT 1
    `).get(...params) as Account | undefined;
  }

  reserveAvailableAccount(model: DoubaoModel, options: AccountSelectionOptions = {}): Account | undefined {
    return this.db.transaction(() => {
      const account = this.findAvailableAccount(model, options);
      if (!account) return undefined;
      this.markAccountAllocated(account.id, "busy");
      return this.getAccount(account.id);
    })();
  }

  deductQuota(accountId: number, model: DoubaoModel): Account {
    this.rolloverDailyQuotas();
    const settings = this.getSettings();
    const cost = modelCost(settings, model);
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET quota_remaining = MAX(0, quota_remaining - ?),
          quota_used_today = quota_used_today + ?,
          last_used_at = ?,
          quota_day = ?,
          updated_at = ?
      WHERE id = ?
    `).run(cost, cost, timestamp, quotaDayKey(new Date(), settings.dailyResetTime), timestamp, accountId);
    return this.getAccount(accountId)!;
  }

  refundQuota(accountId: number, model: DoubaoModel): Account {
    const settings = this.getSettings();
    const cost = modelCost(settings, model);
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET quota_remaining = MIN(daily_quota_limit, quota_remaining + ?),
          quota_used_today = MAX(0, quota_used_today - ?),
          updated_at = ?
      WHERE id = ?
    `).run(cost, cost, timestamp, accountId);
    return this.getAccount(accountId)!;
  }

  markAccountAllocated(id: number, status: AccountRuntimeStatus = "idle") {
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET current_status = ?,
          last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(status, timestamp, timestamp, id);
  }

  /** 池宪法④：失败账号冷却退避（秒）。0=不冷却。 */
  markAccountCooldown(id: number, seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const until = new Date(Date.now() + seconds * 1000).toISOString();
    this.db.prepare(`UPDATE accounts SET cooldown_until = ?, updated_at = ? WHERE id = ?`).run(until, now(), id);
  }

  /** 成功产片后清冷却（账号已自证健康）。 */
  clearAccountCooldown(id: number) {
    this.db.prepare(`UPDATE accounts SET cooldown_until = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  }

  /** 池宪法④：请求换号重试（改绑账号、回队列、计数+1）。 */
  markApiRequestRetry(requestId: string, accountId: number, message: string) {
    this.db.prepare(`
      UPDATE api_requests
      SET account_id = ?,
          retry_count = COALESCE(retry_count, 0) + 1,
          status = 'accepted',
          message = ?,
          -- 新一轮执行：清空上一轮的提交标记/会话/错误码（上一轮仅在平台确认未扣次数时才会换号重试）
          submitted_at = NULL,
          doubao_thread_url = NULL,
          error_code = NULL,
          workflow_phase = 'queued',
          updated_at = ?
      WHERE request_id = ?
    `).run(accountId, message, now(), requestId);
    return this.getApiRequest(requestId)!;
  }

  /**
   * 账号暂不可用时，判断是“稍后可能可用”（忙碌/冷却，可排队）还是“不可能可用”（直接失败）。
   */
  describeAccountAvailability(model: DoubaoModel, options: AccountSelectionOptions = {}): AccountAvailability {
    if (this.findAvailableAccount(model, options)) return { available: true };
    const cost = modelCost(this.getSettings(), model);
    const exclude = new Set(options.excludeAccountIds ?? []);
    const candidates = this.listAccounts().filter((account) =>
      !exclude.has(account.id) && (options.accountId == null || account.id === options.accountId)
    );
    const specific = options.accountId != null;
    if (specific && candidates.length === 0) {
      return { available: false, couldBecomeAvailable: false, code: "ACCOUNT_UNAVAILABLE", message: `指定账号 ${options.accountId} 不存在或已被排除` };
    }
    const loggedIn = candidates.filter((account) => account.loginStatus === "logged_in");
    if (loggedIn.length === 0) {
      return {
        available: false,
        couldBecomeAvailable: false,
        code: specific ? "ACCOUNT_UNAVAILABLE" : "NO_ACCOUNT_LOGIN",
        message: specific ? `指定账号 ${options.accountId} 未登录` : "没有已登录的豆包账号，请到「账号管理」登录后再试"
      };
    }
    const consumer = loggedIn.filter((account) => account.mediaPageKind !== "work");
    if (consumer.length === 0) {
      return { available: false, couldBecomeAvailable: false, code: "ACCOUNT_WORK_PAGE", message: WORK_ONLY_MESSAGE };
    }
    const withQuota = consumer.filter((account) => account.quotaRemaining >= cost);
    if (withQuota.length === 0) {
      return {
        available: false,
        couldBecomeAvailable: false,
        code: specific ? "ACCOUNT_UNAVAILABLE" : "NO_ACCOUNT_QUOTA",
        message: specific ? `指定账号 ${options.accountId} 剩余额度不足（需要 ${cost}）` : `所有已登录账号剩余额度不足（需要 ${cost}）`
      };
    }
    return {
      available: false,
      couldBecomeAvailable: true,
      code: specific ? "ACCOUNT_UNAVAILABLE" : "NO_ACCOUNT",
      message: specific ? `指定账号 ${options.accountId} 正忙或冷却中` : "所有可用账号正忙或冷却中"
    };
  }

  /**
   * 执行器协议 v2 的受理入口：幂等检查 + 选号 + 预扣 + 入库在同一个事务里完成，
   * 任何一步失败都整体回滚（不会出现“扣了额度却没有请求”的情况）。
   */
  admitGenerateRequest(input: AdmitGenerateInput): AdmitGenerateResult {
    return this.db.transaction((): AdmitGenerateResult => {
      if (input.clientRequestId) {
        const existing = this.getApiRequestByClientRequestId(input.clientRequestId);
        if (existing) return { outcome: "replay", request: existing };
      }
      const settings = this.getSettings();
      const cost = modelCost(settings, input.model);
      const { executorEnabled: _executorEnabled, allowQueue: _allowQueue, queueTimeoutSeconds: _queueTimeout, selection: _selection, ...createFields } = input;
      const base: ApiRequestCreateInput = {
        ...createFields,
        status: "accepted",
        clientRequestId: input.clientRequestId ?? null,
        preferredAccountId: input.selection.accountId ?? null,
        excludeAccountIds: input.selection.excludeAccountIds?.length ? input.selection.excludeAccountIds : null
      };

      const account = input.executorEnabled
        ? this.reserveAvailableAccount(input.model, input.selection)
        : this.findAvailableAccount(input.model, input.selection);
      if (account) {
        this.deductQuota(account.id, input.model);
        const request = this.createApiRequest({
          ...base,
          accountId: account.id,
          status: "accepted",
          workflowPhase: "queued",
          message: input.executorEnabled
            ? `已接收，已预扣 ${cost} 额度，已进入执行队列`
            : `已接收，已预扣 ${cost} 额度，自动执行已关闭`
        });
        return { outcome: "accepted", request, account: this.getAccount(account.id)!, cost };
      }

      const availability = this.describeAccountAvailability(input.model, input.selection);
      if (!availability.available && availability.couldBecomeAvailable && input.allowQueue && input.executorEnabled) {
        const deadline = new Date(Date.now() + input.queueTimeoutSeconds * 1000).toISOString();
        const request = this.createApiRequest({
          ...base,
          accountId: null,
          status: "queued",
          workflowPhase: "queued",
          queueDeadlineAt: deadline,
          message: `${availability.message}，已排队等待（最长 ${Math.round(input.queueTimeoutSeconds / 60)} 分钟，未扣额度）`
        });
        return { outcome: "queued", request };
      }

      const code: ErrorCode = availability.available ? "NO_ACCOUNT" : availability.code;
      const message = availability.available ? "没有可用账号" : availability.message;
      const request = this.createApiRequest({
        ...base,
        accountId: null,
        status: "failed",
        workflowPhase: "failed",
        errorCode: code,
        quotaRefunded: true,
        message
      });
      return { outcome: "rejected", request, code };
    })();
  }

  /**
   * 为一个 queued 请求选号、预扣并转为 accepted。没有可用账号时返回 null（保持排队）。
   */
  dispatchQueuedRequest(requestId: string): { request: ApiRequest; account: Account; cost: number } | null {
    return this.db.transaction(() => {
      const request = this.getApiRequest(requestId);
      if (!request || request.status !== "queued") return null;
      const selection: AccountSelectionOptions = {
        accountId: request.preferredAccountId ?? null,
        excludeAccountIds: request.excludeAccountIds ?? null
      };
      const account = this.reserveAvailableAccount(request.model, selection);
      if (!account) return null;
      this.deductQuota(account.id, request.model);
      const cost = modelCost(this.getSettings(), request.model);
      const timestamp = now();
      this.db.prepare(`
        UPDATE api_requests
        SET account_id = ?, status = 'accepted', workflow_phase = 'queued', queue_deadline_at = NULL,
            message = ?, updated_at = ?
        WHERE request_id = ? AND status = 'queued'
      `).run(account.id, `已分配账号，已预扣 ${cost} 额度，已进入执行队列`, timestamp, requestId);
      return { request: this.getApiRequest(requestId)!, account: this.getAccount(account.id)!, cost };
    })();
  }

  listQueuedApiRequests(): ApiRequest[] {
    return this.db.prepare(`
      SELECT ${API_REQUEST_COLUMNS}
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      WHERE api_requests.status = 'queued'
      ORDER BY api_requests.id ASC
    `).all().map(normalizeApiRequest);
  }

  listActiveApiRequests(): ApiRequest[] {
    return this.db.prepare(`
      SELECT ${API_REQUEST_COLUMNS}
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      WHERE api_requests.status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})
      ORDER BY api_requests.id ASC
    `).all(...ACTIVE_STATUSES).map(normalizeApiRequest);
  }

  /** 已把提示词提交给豆包：此后任何自动流程都不得重新生成（铁律 3）。只记录首次时间。 */
  markApiRequestSubmitted(requestId: string) {
    this.db.prepare(`
      UPDATE api_requests
      SET submitted_at = COALESCE(submitted_at, ?), updated_at = ?
      WHERE request_id = ?
    `).run(now(), now(), requestId);
  }

  touchApiRequestHeartbeat(requestId: string) {
    this.db.prepare(`UPDATE api_requests SET heartbeat_at = ? WHERE request_id = ?`).run(now(), requestId);
  }

  /**
   * 原子收尾（孤儿/卡死/放弃/排队超时）：仅在状态符合预期时写入，必要时退款并释放账号。
   * 返回更新后的请求；状态已不符合预期时返回 null（例如已经成功）。
   */
  finalizeApiRequest(input: FinalizeRequestInput): ApiRequest | null {
    return this.db.transaction(() => {
      const request = this.getApiRequest(input.requestId);
      if (!request || !input.expectStatuses.includes(request.status)) return null;
      const timestamp = now();
      const shouldRefund = input.refund && request.accountId != null && !request.quotaRefunded && request.status !== "queued";
      if (shouldRefund) this.refundQuota(request.accountId!, request.model);
      this.db.prepare(`
        UPDATE api_requests
        SET status = 'failed', message = ?, error_code = ?, workflow_phase = ?,
            quota_refunded = CASE WHEN ? THEN 1 WHEN status = 'queued' THEN 1 ELSE quota_refunded END,
            queue_deadline_at = NULL, updated_at = ?, finished_at = COALESCE(finished_at, ?)
        WHERE request_id = ?
      `).run(input.message, input.errorCode, input.workflowPhase, shouldRefund ? 1 : 0, timestamp, timestamp, input.requestId);
      if (input.releaseAccount && request.accountId != null) this.releaseAccountIfIdle(request.accountId, input.requestId);
      return this.getApiRequest(input.requestId)!;
    })();
  }

  /** 账号上没有其他 accepted/running 请求时，把 busy 账号置回 idle。 */
  releaseAccountIfIdle(accountId: number, ignoreRequestId?: string) {
    const other = this.db.prepare(`
      SELECT 1 FROM api_requests
      WHERE account_id = ? AND status IN ('accepted', 'running') AND request_id != ?
      LIMIT 1
    `).get(accountId, ignoreRequestId ?? "");
    if (other) return false;
    this.db.prepare(`
      UPDATE accounts SET current_status = 'idle', updated_at = ?
      WHERE id = ? AND current_status = 'busy'
    `).run(now(), accountId);
    return true;
  }

  /** 释放所有“busy 但没有任何活跃请求”的账号（启动清扫/周期清扫）。 */
  releaseOrphanBusyAccounts(): number[] {
    const rows = this.db.prepare(`
      SELECT id FROM accounts
      WHERE current_status = 'busy'
        AND NOT EXISTS (
          SELECT 1 FROM api_requests
          WHERE api_requests.account_id = accounts.id AND api_requests.status IN ('accepted', 'running')
        )
    `).all() as Array<{ id: number }>;
    const timestamp = now();
    const update = this.db.prepare(`UPDATE accounts SET current_status = 'idle', updated_at = ? WHERE id = ?`);
    for (const row of rows) update.run(timestamp, row.id);
    return rows.map((row) => row.id);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const data = { ...DEFAULT_SETTINGS } as Record<keyof AppSettings, unknown>;
    for (const row of rows) {
      if (isSettingsKey(row.key)) {
        data[row.key] = parseSettingValue(row.key, row.value);
      }
    }
    return data as AppSettings;
  }

  updateSettings(input: AppSettingsUpdateInput): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      ...input,
      apiPort: clampPort(input.apiPort ?? current.apiPort),
      executorEnabled: Boolean(input.executorEnabled ?? current.executorEnabled),
      showExecutorWindow: Boolean(input.showExecutorWindow ?? current.showExecutorWindow),
      autoCloseExecutorWindow: Boolean(input.autoCloseExecutorWindow ?? current.autoCloseExecutorWindow),
      doubaoChatUrl: String(input.doubaoChatUrl || current.doubaoChatUrl || DEFAULT_SETTINGS.doubaoChatUrl),
      dailyQuotaLimit: clampInt(input.dailyQuotaLimit ?? current.dailyQuotaLimit),
      miniCost: Math.max(1, clampInt(input.miniCost ?? current.miniCost)),
      fastCost: Math.max(1, clampInt(input.fastCost ?? current.fastCost)),
      standardCost: Math.max(1, clampInt(input.standardCost ?? current.standardCost)),
      imageCost: Math.max(1, clampInt(input.imageCost ?? current.imageCost)),
      generationTimeoutSeconds: clampInt(input.generationTimeoutSeconds ?? current.generationTimeoutSeconds),
      maxConcurrentAccounts: Math.max(1, clampInt(input.maxConcurrentAccounts ?? current.maxConcurrentAccounts)),
      retryCount: clampInt(input.retryCount ?? current.retryCount),
      accountSelectionMode: (input.accountSelectionMode ?? current.accountSelectionMode) === "lru" ? "lru" : "sticky",
      accountCooldownSeconds: Math.max(0, clampInt(input.accountCooldownSeconds ?? current.accountCooldownSeconds)),
      requestRetryLimit: Math.max(0, clampInt(input.requestRetryLimit ?? current.requestRetryLimit))
    };

    const timestamp = now();
    const statement = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
      const value = next[key];
      statement.run(key, stringifySettingValue(value), timestamp);
    }

    return this.getSettings();
  }

  listApiRequests(limit = 100): ApiRequest[] {
    return this.db.prepare(`
      SELECT ${API_REQUEST_COLUMNS}
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      ORDER BY api_requests.id DESC
      LIMIT ?
    `).all(limit).map(normalizeApiRequest);
  }

  /** 其他请求已认领的豆包会话地址（结果防误认：扫描最近对话时排除）。 */
  listClaimedThreadUrls(excludeRequestId: string): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT doubao_thread_url AS url
      FROM api_requests
      WHERE request_id != ? AND doubao_thread_url IS NOT NULL AND doubao_thread_url != ''
    `).all(excludeRequestId) as Array<{ url: string }>).map((row) => row.url);
  }

  /** 其他请求已交付的视频地址（结果防误认：交付前校验对象键不重复）。 */
  listDeliveredVideoResults(excludeRequestId: string): Array<{ requestId: string; createdAt: string; urls: string[] }> {
    return (this.db.prepare(`
      SELECT request_id AS requestId, created_at AS createdAt, clean_video_url AS cleanVideoUrl, raw_video_url AS rawVideoUrl
      FROM api_requests
      WHERE request_id != ? AND (clean_video_url IS NOT NULL OR raw_video_url IS NOT NULL)
      ORDER BY id ASC
    `).all(excludeRequestId) as Array<{ requestId: string; createdAt: string; cleanVideoUrl: string | null; rawVideoUrl: string | null }>).map(
      (row) => ({
        requestId: row.requestId,
        createdAt: row.createdAt,
        urls: [row.cleanVideoUrl, row.rawVideoUrl].filter((url): url is string => Boolean(url))
      })
    );
  }

  queryApiRequests(query: ApiRequestQuery = {}): ApiRequest[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.statuses?.length) {
      where.push(`api_requests.status IN (${query.statuses.map(() => "?").join(", ")})`);
      params.push(...query.statuses);
    }
    if (query.since) {
      where.push("api_requests.updated_at >= ?");
      params.push(query.since);
    }
    if (query.source) {
      where.push("api_requests.source = ?");
      params.push(query.source);
    }
    if (query.clientRequestIdPrefix) {
      where.push("substr(api_requests.client_request_id, 1, ?) = ?");
      params.push(query.clientRequestIdPrefix.length, query.clientRequestIdPrefix);
    }
    const limit = Math.max(1, Math.min(1000, Math.trunc(query.limit ?? 100) || 100));
    params.push(limit);
    return this.db.prepare(`
      SELECT ${API_REQUEST_COLUMNS}
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY api_requests.id DESC
      LIMIT ?
    `).all(...params).map(normalizeApiRequest);
  }

  getApiRequest(requestId: string): ApiRequest | undefined {
    const row = this.db.prepare(`
      SELECT ${API_REQUEST_COLUMNS}
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      WHERE api_requests.request_id = ?
    `).get(requestId);
    return row ? normalizeApiRequest(row) : undefined;
  }

  getApiRequestByClientRequestId(clientRequestId: string): ApiRequest | undefined {
    const row = this.db.prepare(`
      SELECT ${API_REQUEST_COLUMNS}
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      WHERE api_requests.client_request_id = ?
    `).get(clientRequestId);
    return row ? normalizeApiRequest(row) : undefined;
  }

  createApiRequest(input: ApiRequestCreateInput): ApiRequest {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO api_requests (
        request_id,
        source,
        model,
        account_id,
        status,
        message,
        prompt,
        reference_image_path,
        reference_image_paths,
        remove_watermark,
        callback_url,
        aspect_ratio,
        resolution,
        image_count,
        duration_seconds,
        client_request_id,
        parent_request_id,
        workflow_phase,
        error_code,
        quota_refunded,
        queue_deadline_at,
        preferred_account_id,
        exclude_account_ids,
        created_at,
        updated_at,
        finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId,
      input.source || "local-api",
      input.model,
      input.accountId ?? null,
      input.status,
      input.message || "",
      input.prompt,
      input.referenceImagePath || null,
      input.referenceImagePaths?.length ? JSON.stringify(input.referenceImagePaths.slice(0, 9)) : null,
      input.removeWatermark === false ? 0 : 1,
      input.callbackUrl || null,
      input.aspectRatio || null,
      input.resolution || null,
      Math.min(4, Math.max(1, input.imageCount || 1)),
      input.durationSeconds ?? null,
      input.clientRequestId || null,
      input.parentRequestId || null,
      input.workflowPhase ?? phaseForProgress(input.message, input.status, null),
      input.errorCode || null,
      input.quotaRefunded ? 1 : 0,
      input.queueDeadlineAt || null,
      input.preferredAccountId ?? null,
      input.excludeAccountIds?.length ? JSON.stringify(input.excludeAccountIds) : null,
      timestamp,
      timestamp,
      input.status === "failed" || input.status === "success" || input.status === "stopped" ? timestamp : null
    );
    return this.getApiRequest(input.requestId)!;
  }

  updateApiRequestStatus(requestId: string, status: ApiRequestStatus, message: string) {
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET status = ?, message = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(status, message, now(), finishedAt, requestId);
    return this.getApiRequest(requestId)!;
  }

  updateApiRequest(input: ApiRequestUpdateInput) {
    const existing = this.getApiRequest(input.requestId);
    if (!existing) throw new Error("Request not found");

    const status = input.status ?? existing.status;
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = ?,
        message = ?,
        doubao_thread_url = ?,
        raw_video_url = ?,
        clean_video_url = ?,
        output_video_path = ?,
        image_urls = ?,
        output_image_paths = ?,
        workflow_phase = ?,
        error_code = ?,
        quota_refunded = ?,
        updated_at = ?,
        finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(
      status,
      input.message ?? existing.message,
      input.doubaoThreadUrl ?? existing.doubaoThreadUrl,
      input.rawVideoUrl ?? existing.rawVideoUrl,
      input.cleanVideoUrl ?? existing.cleanVideoUrl,
      input.outputVideoPath ?? existing.outputVideoPath,
      input.imageUrls === undefined
        ? (existing.imageUrls ? JSON.stringify(existing.imageUrls) : null)
        : (input.imageUrls ? JSON.stringify(input.imageUrls) : null),
      input.outputImagePaths === undefined
        ? (existing.outputImagePaths ? JSON.stringify(existing.outputImagePaths) : null)
        : (input.outputImagePaths ? JSON.stringify(input.outputImagePaths) : null),
      input.workflowPhase === undefined ? (existing.workflowPhase ?? null) : input.workflowPhase,
      input.errorCode === undefined ? (existing.errorCode ?? null) : input.errorCode,
      (input.quotaRefunded === undefined ? existing.quotaRefunded : input.quotaRefunded) ? 1 : 0,
      now(),
      finishedAt,
      input.requestId
    );
    return this.getApiRequest(input.requestId)!;
  }

  clearApiRequests() {
    this.db.prepare("DELETE FROM api_requests").run();
  }

  appendOperationLog(input: OperationLogCreateInput): OperationLog {
    this.pruneOperationLogs();
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO operation_logs (
        request_id,
        account_id,
        action,
        status,
        message,
        target_url,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId || null,
      input.accountId ?? null,
      input.action,
      input.status || "info",
      input.message,
      input.targetUrl || null,
      timestamp
    );
    return this.getOperationLog(Number(result.lastInsertRowid))!;
  }

  listOperationLogs(limit = 500): OperationLog[] {
    this.pruneOperationLogs();
    return this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      ORDER BY operation_logs.id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(2000, limit))).map(normalizeOperationLog);
  }

  listOperationLogsForRequest(requestId: string, limit = 300): OperationLog[] {
    return this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      WHERE operation_logs.request_id = ?
      ORDER BY operation_logs.id ASC
      LIMIT ?
    `).all(requestId, Math.max(1, Math.min(2000, limit))).map(normalizeOperationLog);
  }

  getOperationLog(id: number): OperationLog | undefined {
    const row = this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      WHERE operation_logs.id = ?
    `).get(id);
    return row ? normalizeOperationLog(row) : undefined;
  }

  clearOperationLogs() {
    this.db.prepare("DELETE FROM operation_logs").run();
  }

  private pruneOperationLogs() {
    const cutoff = new Date(Date.now() - OPERATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM operation_logs WHERE created_at < ?").run(cutoff);
  }

  private ensureDefaultSettings() {
    const existingCount = this.db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
    if (existingCount.count === 0) {
      this.updateSettings(DEFAULT_SETTINGS);
    }
  }

  private migrateExecutorConcurrency() {
    const migrationKey = "executorConcurrencyV1";
    const migrated = this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(migrationKey);
    if (migrated) return;

    const timestamp = now();
    this.db.prepare(`
      UPDATE settings
      SET value = '4', updated_at = ?
      WHERE key = 'maxConcurrentAccounts' AND CAST(value AS INTEGER) = 1
    `).run(timestamp);
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', ?)")
      .run(migrationKey, timestamp);
  }

  private ensureAccountColumns() {
    this.addColumnIfMissing("accounts", "media_page_kind", "TEXT NOT NULL DEFAULT 'unknown'");
    this.addColumnIfMissing("accounts", "name", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "remark", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "current_status", "TEXT NOT NULL DEFAULT 'idle'");
    this.addColumnIfMissing("accounts", "daily_quota_limit", "INTEGER NOT NULL DEFAULT 10");
    this.addColumnIfMissing("accounts", "quota_remaining", "INTEGER NOT NULL DEFAULT 10");
    this.addColumnIfMissing("accounts", "quota_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "cooldown_until", "TEXT");
    this.addColumnIfMissing("accounts", "quota_day", "TEXT");
    this.addColumnIfMissing("accounts", "mini_daily_limit", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_remaining", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "fast_daily_limit", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_remaining", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_used_today", "INTEGER NOT NULL DEFAULT 0");

    this.db.prepare(`
      UPDATE accounts
      SET
        name = CASE WHEN name = '' THEN '账号 ' || printf('%03d', id) ELSE name END,
        remark = CASE WHEN remark = '' AND name NOT LIKE '账号 %' THEN name ELSE remark END,
        daily_quota_limit = CASE WHEN daily_quota_limit = 10 AND (mini_daily_limit + fast_daily_limit) != 8 THEN mini_daily_limit + fast_daily_limit ELSE daily_quota_limit END,
        quota_remaining = CASE WHEN quota_remaining = 10 AND (mini_remaining + fast_remaining) != 8 THEN mini_remaining + fast_remaining ELSE quota_remaining END,
        quota_used_today = CASE WHEN quota_used_today = 0 AND (mini_used_today + fast_used_today) > 0 THEN mini_used_today + fast_used_today ELSE quota_used_today END
    `).run();
  }

  private ensureApiRequestColumns() {
    this.addColumnIfMissing("api_requests", "source", "TEXT NOT NULL DEFAULT 'local'");
    this.addColumnIfMissing("api_requests", "reference_image_path", "TEXT");
    this.addColumnIfMissing("api_requests", "reference_image_paths", "TEXT");
    this.addColumnIfMissing("api_requests", "remove_watermark", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("api_requests", "callback_url", "TEXT");
    this.addColumnIfMissing("api_requests", "retry_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "doubao_thread_url", "TEXT");
    this.addColumnIfMissing("api_requests", "raw_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "clean_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "output_video_path", "TEXT");
    this.addColumnIfMissing("api_requests", "aspect_ratio", "TEXT");
    this.addColumnIfMissing("api_requests", "duration_seconds", "INTEGER");
    this.addColumnIfMissing("api_requests", "resolution", "TEXT");
    this.addColumnIfMissing("api_requests", "image_count", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("api_requests", "image_urls", "TEXT");
    this.addColumnIfMissing("api_requests", "output_image_paths", "TEXT");
    this.addColumnIfMissing("api_requests", "finished_at", "TEXT");
    // 执行器协议 v2（部分列在旧库中已存在：workflow_phase/submitted_at/error_code）
    this.addColumnIfMissing("api_requests", "workflow_phase", "TEXT");
    this.addColumnIfMissing("api_requests", "submitted_at", "TEXT");
    this.addColumnIfMissing("api_requests", "error_code", "TEXT");
    this.addColumnIfMissing("api_requests", "heartbeat_at", "TEXT");
    this.addColumnIfMissing("api_requests", "client_request_id", "TEXT");
    this.addColumnIfMissing("api_requests", "parent_request_id", "TEXT");
    this.addColumnIfMissing("api_requests", "quota_refunded", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "queue_deadline_at", "TEXT");
    this.addColumnIfMissing("api_requests", "preferred_account_id", "INTEGER");
    this.addColumnIfMissing("api_requests", "exclude_account_ids", "TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_requests_client_request_id
        ON api_requests(client_request_id) WHERE client_request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_api_requests_status ON api_requests(status);
    `);
  }

  private cleanInvalidSuccessfulResults() {
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = 'failed',
        message = '历史结果不包含有效的去水印 MP4',
        raw_video_url = NULL,
        clean_video_url = NULL,
        output_video_path = NULL,
        updated_at = ?,
        finished_at = COALESCE(finished_at, ?)
      WHERE status = 'success'
        AND model NOT LIKE 'seedream%'
        AND NOT (
          LOWER(COALESCE(clean_video_url, '')) LIKE '%.mp4%'
          OR LOWER(COALESCE(clean_video_url, '')) LIKE '%video_mp4%'
          OR LOWER(COALESCE(output_video_path, '')) LIKE '%.mp4'
        )
    `).run(now(), now());
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }

  private nextAccountNumber(): number {
    const rows = this.db.prepare("SELECT partition FROM accounts").all() as Array<{ partition: string }>;
    const used = rows
      .map((row) => row.partition.match(/^persist:doubao_account_(\d+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));

    let current = 1;
    while (used.includes(current)) current += 1;
    return current;
  }
}

function clampInt(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampPort(value: number) {
  const port = clampInt(value);
  if (port < 1 || port > 65535) return DEFAULT_SETTINGS.apiPort;
  return port;
}

function stringifySettingValue(value: unknown) {
  return JSON.stringify(value);
}

function parseSettingValue(key: keyof AppSettings, value: string) {
  try {
    return JSON.parse(value) as AppSettings[typeof key];
  } catch {
    return value;
  }
}

function isSettingsKey(key: string): key is keyof AppSettings {
  return key in DEFAULT_SETTINGS;
}

function parseJsonStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      return null;
    }
  }
  return null;
}

function parseJsonNumberArray(value: unknown): number[] | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.map((item) => Number(item)).filter((item) => Number.isInteger(item));
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

function normalizeApiRequest(row: unknown): ApiRequest {
  const request = row as ApiRequest & { removeWatermark: number | boolean };
  const rawPaths = (request as { referenceImagePaths?: unknown }).referenceImagePaths;
  let referenceImagePaths: string[] | null = null;
  if (Array.isArray(rawPaths)) {
    referenceImagePaths = rawPaths.map((item) => String(item)).filter(Boolean);
  } else if (typeof rawPaths === "string" && rawPaths.trim()) {
    try {
      const parsed = JSON.parse(rawPaths);
      if (Array.isArray(parsed)) {
        referenceImagePaths = parsed.map((item) => String(item)).filter(Boolean);
      }
    } catch {
      referenceImagePaths = null;
    }
  }
  return {
    ...request,
    referenceImagePaths,
    imageUrls: parseJsonStringArray((request as { imageUrls?: unknown }).imageUrls),
    outputImagePaths: parseJsonStringArray((request as { outputImagePaths?: unknown }).outputImagePaths),
    imageCount: Number((request as { imageCount?: unknown }).imageCount ?? 1) || 1,
    removeWatermark: Boolean(request.removeWatermark),
    clientRequestId: request.clientRequestId ?? null,
    parentRequestId: request.parentRequestId ?? null,
    workflowPhase: request.workflowPhase ?? null,
    submittedAt: request.submittedAt ?? null,
    heartbeatAt: request.heartbeatAt ?? null,
    errorCode: request.errorCode ?? null,
    quotaRefunded: Boolean(request.quotaRefunded),
    queueDeadlineAt: request.queueDeadlineAt ?? null,
    preferredAccountId: request.preferredAccountId == null ? null : Number(request.preferredAccountId),
    excludeAccountIds: parseJsonNumberArray((request as { excludeAccountIds?: unknown }).excludeAccountIds)
  };
}

function normalizeOperationLog(row: unknown): OperationLog {
  const log = row as OperationLog & { accountId: number | null };
  return {
    ...log,
    requestId: log.requestId || null,
    accountId: log.accountId === null || log.accountId === undefined ? null : Number(log.accountId),
    accountName: log.accountName || null,
    accountPartition: log.accountPartition || null,
    status: log.status === "success" || log.status === "failed" ? log.status : "info",
    targetUrl: log.targetUrl || null
  };
}
