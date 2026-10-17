import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const output = process.env.POOL_TEST_BUILD_DIR || 'dist-electron';
const { loadUrl, withPageDeadline } = await import(pathToFileURL(path.resolve(output, 'page-runtime.js')).href);

function fixture() {
  const wc = new EventEmitter();
  wc.stop = () => {};
  return { webContents: wc, isDestroyed: () => false, loadURL: async () => {} };
}
test('ignores subframe failures and waits for main document', async () => {
  const win = fixture();
  const ready = loadUrl(win, 'https://www.doubao.com/chat', 500);
  win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://subframe.invalid/', false);
  win.webContents.emit('did-finish-load');
  await ready;
  assert.equal(win.webContents.listenerCount('did-fail-load'), 0);
});
test('keeps listening after aborted navigation and reports a later main failure', async () => {
  const win = fixture();
  const ready = loadUrl(win, 'https://www.doubao.com/chat', 500);
  win.webContents.emit('did-fail-load', {}, -3, '', 'https://www.doubao.com/chat', true);
  win.webContents.emit('did-fail-load', {}, -105, '', 'https://www.doubao.com/chat?secret=not-logged', true);
  await assert.rejects(ready, (error) => /code=-105/.test(error.message) && !error.message.includes('secret'));
});
test('does not fail a redirect merely because loadURL rejects ERR_ABORTED', async () => {
  const win = fixture();
  win.loadURL = async () => { throw Object.assign(new Error('ERR_ABORTED'), { errno: -3 }); };
  const ready = loadUrl(win, 'https://www.doubao.com/chat', 500);
  await new Promise((resolve) => setTimeout(resolve, 0));
  win.webContents.emit('did-finish-load');
  await ready;
});
test('times out and cleans listeners when no main completion arrives', async () => {
  const win = fixture();
  let stopped = 0;
  win.webContents.stop = () => { stopped += 1; };
  await assert.rejects(loadUrl(win, 'https://www.doubao.com/chat', 5), /超时/);
  assert.equal(stopped, 1);
  assert.equal(win.webContents.listenerCount('did-finish-load'), 0);
  assert.equal(win.webContents.listenerCount('did-fail-load'), 0);
});
test('reports genuine main document errors with a nonblank error code', async () => {
  const win = fixture();
  const ready = loadUrl(win, 'https://www.doubao.com/chat', 500);
  win.webContents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', '', true);
  await assert.rejects(ready, /code=-106 ERR_INTERNET_DISCONNECTED/);
});
test('closes an unresponsive owned executor once without retrying the operation', async () => {
  let calls = 0, closed = 0;
  await assert.rejects(withPageDeadline(() => { calls += 1; return new Promise(() => {}); }, () => { closed += 1; }, 5), /结果可能未知/);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
});
test('a completed script does not later close its window', async () => {
  let closed = 0;
  assert.equal(await withPageDeadline(async () => 42, () => { closed += 1; }, 5), 42);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, 0);
});
