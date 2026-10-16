// fix-stuck-30.cjs — 收尸：挂死任务判死 + 风控账号标记
const Database = require("better-sqlite3");
const db = new Database((process.env.APPDATA || "") + "/doubao-account-manager/doubao-manager.sqlite3");
const now = new Date().toISOString();
const msg = "账号触发字节风控验证码（人机验证），请到「账号管理」重新登录该豆包账号后再试；本单未出图";
const r1 = db
  .prepare("UPDATE api_requests SET status='failed', message=?, finished_at=?, updated_at=? WHERE id=30 AND status='running'")
  .run(msg, now, now);
const r2 = db
  .prepare("UPDATE accounts SET login_status='login_required', current_status='idle', updated_at=? WHERE id=6")
  .run(now);
console.log("request#30 changes:", r1.changes);
console.log("account#6 changes:", r2.changes);
console.log("acct6:", JSON.stringify(db.prepare("SELECT id,remark,login_status,current_status FROM accounts WHERE id IN (6,9)").all()));
