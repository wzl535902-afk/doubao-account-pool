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

const now = () => new Date().toISOString();
const OPERATION_LOG_RETENTION_DAYS = 3;

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

  constructor() {
    const dbPath = path.join(app.getPath("userData"), "doubao-manager.sqlite3");
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
        updated_at = ?
      WHERE id = ?
    `).run(now(), id);
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
        updated_at = ?
    `).run(now());
    return this.listAccounts();
  }

  findAvailableAccount(model: DoubaoModel): Account | undefined {
    const settings = this.getSettings();
    const requiredQuota = modelCost(settings, model);
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
      ORDER BY
        ${
          settings.accountSelectionMode === "lru"
            ? "CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END ASC, last_used_at ASC,"
            : "last_used_at DESC,"
        }
        id ASC
      LIMIT 1
    `).get(requiredQuota, now()) as Account | undefined;
  }

  reserveAvailableAccount(model: DoubaoModel): Account | undefined {
    return this.db.transaction(() => {
      const account = this.findAvailableAccount(model);
      if (!account) return undefined;
      this.markAccountAllocated(account.id, "busy");
      return this.getAccount(account.id);
    })();
  }

  deductQuota(accountId: number, model: DoubaoModel): Account {
    const settings = this.getSettings();
    const cost = modelCost(settings, model);
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET quota_remaining = MAX(0, quota_remaining - ?),
          quota_used_today = quota_used_today + ?,
          last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(cost, cost, timestamp, timestamp, accountId);
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
          updated_at = ?
      WHERE request_id = ?
    `).run(accountId, message, now(), requestId);
    return this.getApiRequest(requestId)!;
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
      SELECT
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
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      ORDER BY api_requests.id DESC
      LIMIT ?
    `).all(limit).map(normalizeApiRequest);
  }

  getApiRequest(requestId: string): ApiRequest | undefined {
    const row = this.db.prepare(`
      SELECT
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
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      WHERE api_requests.request_id = ?
    `).get(requestId);
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
        created_at,
        updated_at,
        finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    removeWatermark: Boolean(request.removeWatermark)
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
