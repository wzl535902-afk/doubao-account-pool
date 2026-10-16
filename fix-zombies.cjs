// fix-zombies.cjs — 停用池子里已被枢纽删除的僵尸账号
const Database = require("better-sqlite3");
const dbPath = (process.env.APPDATA || "") + "/doubao-account-manager/doubao-manager.sqlite3";
const db = new Database(dbPath);
const now = new Date().toISOString();
const zombieIds = [5, 7, 8]; // 234(8f54)/9fa1/58e3 —— 枢纽已删
for (const id of zombieIds) {
  db.prepare(
    "UPDATE accounts SET login_status='logged_out', current_status='idle', last_used_at=?, updated_at=? WHERE id=?"
  ).run("2099-01-01T00:00:00.000Z", now, id);
}
console.log("zombies disabled");
for (const row of db.prepare("SELECT id, name, remark, login_status, current_status, last_used_at FROM accounts").all()) {
  console.log(JSON.stringify(row));
}
db.close();
