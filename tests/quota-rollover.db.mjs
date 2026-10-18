// Run with Electron, never normal Node: better-sqlite3 uses the Electron ABI.
//   node_modules/.bin/electron tests/quota-rollover.db.mjs
// 每日额度自动回满：跨额度日回满、同日累加不回满、老数据迁移不冲额度、hubId 绑定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-quota-rollover-fixture-'));
const output = process.env.POOL_TEST_BUILD_DIR || 'dist-electron';
app.setPath('userData', root);
app.whenReady().then(async () => {
  let db;
  let code = 0;
  try {
    const { AppDatabase, quotaDayKey } = await import(pathToFileURL(path.resolve(output, 'database.js')).href);

    // 额度日切日：本地时间，按 dailyResetTime 偏移
    const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
    assert.equal(quotaDayKey(at(2026, 10, 18, 0, 0), '00:00'), '2026-10-18');
    assert.equal(quotaDayKey(at(2026, 10, 17, 23, 59), '00:00'), '2026-10-17');
    assert.equal(quotaDayKey(at(2026, 10, 18, 3, 59), '04:00'), '2026-10-17');
    assert.equal(quotaDayKey(at(2026, 10, 18, 4, 0), '04:00'), '2026-10-18');
    assert.equal(quotaDayKey(at(2026, 10, 18, 0, 5), 'garbage'), '2026-10-18', 'invalid reset time falls back to midnight');

    db = new AppDatabase();
    const fresh = db.createAccount({ remark: 'fresh' });
    const legacy = db.createAccount({ remark: 'legacy' });
    const ready = { loginStatus: 'logged_in', currentStatus: 'idle', mediaPageKind: 'consumer' };
    db.updateAccount({ id: fresh.id, ...ready, quotaRemaining: 2, quotaUsedToday: 8 });
    db.updateAccount({ id: legacy.id, ...ready, quotaRemaining: 0, quotaUsedToday: 29 });

    // 老数据：quota_day 为空，最后使用在前天 → 回满；从没用过的只补记今天，不冲掉手动额度
    const twoDaysAgo = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    db.db.prepare('UPDATE accounts SET quota_day = NULL, last_used_at = NULL WHERE id = ?').run(fresh.id);
    db.db.prepare('UPDATE accounts SET quota_day = NULL, last_used_at = ? WHERE id = ?').run(twoDaysAgo, legacy.id);
    const listed = db.listAccounts();
    assert.equal(listed.find((a) => a.id === fresh.id).quotaRemaining, 2, 'never-used account keeps its quota');
    assert.equal(listed.find((a) => a.id === fresh.id).quotaUsedToday, 8);
    assert.equal(listed.find((a) => a.id === legacy.id).quotaRemaining, 10, 'stale legacy account is refilled');
    assert.equal(listed.find((a) => a.id === legacy.id).quotaUsedToday, 0);
    const today = db.currentQuotaDay();
    const dayOf = (id) => db.db.prepare('SELECT quota_day AS d FROM accounts WHERE id = ?').get(id).d;
    assert.equal(dayOf(fresh.id), today);
    assert.equal(dayOf(legacy.id), today);

    // 同日扣额度累加，不回满；扣额度会记 quota_day
    db.deductQuota(legacy.id, 'seedance_2_0_fast');
    db.deductQuota(legacy.id, 'seedream_5_0_flash');
    assert.equal(db.getAccount(legacy.id).quotaRemaining, 6);
    assert.equal(db.getAccount(legacy.id).quotaUsedToday, 4);
    assert.deepEqual(db.rolloverDailyQuotas(), [], 'same quota day: nothing to reset');
    assert.equal(db.getAccount(legacy.id).quotaRemaining, 6);

    // 选号入口自带回满：额度日过期的 0 额度账号应能被选中
    db.updateAccount({ id: fresh.id, quotaRemaining: 0, quotaUsedToday: 10 });
    db.updateAccount({ id: legacy.id, quotaRemaining: 0, quotaUsedToday: 10 });
    assert.equal(db.findAvailableAccount('seedance_2_0_mini'), undefined, 'exhausted today');
    db.db.prepare("UPDATE accounts SET quota_day = '2000-01-01' WHERE id = ?").run(fresh.id);
    assert.equal(db.findAvailableAccount('seedance_2_0_mini')?.id, fresh.id, 'stale day refilled at selection time');
    assert.equal(db.getAccount(fresh.id).quotaRemaining, 10);
    assert.equal(db.getAccount(legacy.id).quotaRemaining, 0, 'current-day account untouched');

    // 显式跨日：明天全部回满
    const tomorrow = new Date(Date.now() + 26 * 3600 * 1000);
    assert.deepEqual(db.rolloverDailyQuotas(tomorrow).sort(), [fresh.id, legacy.id].sort());
    assert.equal(db.getAccount(legacy.id).quotaRemaining, 10);
    assert.equal(dayOf(legacy.id), db.currentQuotaDay(tomorrow));

    // 手动重置也记额度日
    db.db.prepare("UPDATE accounts SET quota_day = '2000-01-01', quota_remaining = 0 WHERE id = ?").run(legacy.id);
    db.resetAccountQuota(legacy.id);
    assert.equal(dayOf(legacy.id), today);

    // hubId 绑定：写 name；被别人占用时拒绝
    assert.equal(db.bindHubId(fresh.id, 'acct-hub-1'), true);
    assert.equal(db.getAccount(fresh.id).name, 'acct-hub-1');
    assert.equal(db.bindHubId(legacy.id, 'acct-hub-1'), false, 'hub id already owned by another row');
    assert.notEqual(db.getAccount(legacy.id).name, 'acct-hub-1');
    assert.equal(db.bindHubId(fresh.id, 'acct-hub-1'), true, 'idempotent');

    // 重开（迁移）保留额度与额度日
    db.db.close(); db = null;
    db = new AppDatabase();
    assert.equal(dayOf(legacy.id), today);
    assert.equal(db.getAccount(legacy.id).quotaRemaining, 10);
    assert.equal(db.getAccount(fresh.id).name, 'acct-hub-1');
    console.log('PASS: quota day keys honour dailyResetTime; stale days refill on list/select/deduct; same-day usage accumulates; legacy rows migrate without wiping quota; hub id binding is unique; reopen safe.');
    db.db.close(); db = null;
  } catch (error) {
    console.error(error);
    if (db) try { db.db.close(); } catch {}
    code = 1;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    app.exit(code);
  }
});
