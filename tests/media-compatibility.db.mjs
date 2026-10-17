// Run with Electron, never normal Node: better-sqlite3 uses the Electron ABI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'doubao-media-capability-fixture-'));
const output=process.env.POOL_TEST_BUILD_DIR || 'dist-electron';
app.setPath('userData',root);
app.whenReady().then(async () => {
let db;
let code=0;
try {
 const {AppDatabase}=await import(pathToFileURL(path.resolve(output,'database.js')).href);
 db=new AppDatabase();
 const normal=db.createAccount({remark:'fixture consumer'});
 const work=db.createAccount({remark:'fixture work'});
 db.updateAccount({id:normal.id,loginStatus:'logged_in',currentStatus:'idle',mediaPageKind:'consumer',quotaRemaining:2,quotaUsedToday:8});
 db.updateAccount({id:work.id,loginStatus:'logged_in',currentStatus:'idle',mediaPageKind:'work',quotaRemaining:8,quotaUsedToday:2});
 const before=db.getAccount(work.id);
 assert.equal(db.listAccounts().find(a=>a.id===work.id).mediaPageKind,'work');
 assert.equal(db.findAvailableAccount('seedance_2_0_mini').id,normal.id);
 assert.equal(db.reserveAvailableAccount('seedance_2_0_mini').id,normal.id);
 assert.equal(db.findAvailableAccount('seedance_2_0_mini'),undefined,'must not fall back to a logged-in Work-only account');
 assert.equal(db.getAccount(work.id).loginStatus,before.loginStatus);
 assert.equal(db.getAccount(work.id).quotaRemaining,8);
 assert.equal(db.getAccount(work.id).quotaUsedToday,2);
 assert.equal(db.getAccount(work.id).currentStatus,'idle');
 db.updateAccount({id:work.id,loginStatus:'logged_out'});
 assert.equal(db.getAccount(work.id).mediaPageKind,'unknown','new login must be able to re-probe');
 assert.equal(db.getAccount(work.id).quotaRemaining,8,'logout classification must not alter quota');
 db.db.close();db=null;
 db=new AppDatabase();
 assert.equal(db.listAccounts().length,2,'migration must preserve accounts');
 assert.equal(db.getAccount(normal.id).currentStatus,'busy','migration must not clear an existing busy account');
 assert.equal(db.getAccount(normal.id).quotaRemaining,2,'migration must not reset quota');
 assert.equal(db.getAccount(work.id).quotaRemaining,8);
 console.log('PASS: isolated DB fixture preserves accounts, quota and busy state; Work-only media profiles excluded; capability reset on logout; repeat migration safe.');
 db.db.close();db=null;

} catch(error) {
 console.error(error);
 if(db)try{db.db.close();}catch{}
 code=1;
} finally {
 try{fs.rmSync(root,{recursive:true,force:true});}catch{}
 app.exit(code);
}
});
