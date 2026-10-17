import type { BrowserWindow } from "electron";

type PageWindow = Pick<BrowserWindow, "webContents" | "loadURL" | "isDestroyed">;

/** Wait only for the main document. Subframes and superseded navigations are not task failures. */
export async function loadUrl(win: PageWindow, url: string, timeoutMs = 30000): Promise<void> {
  if (win.isDestroyed()) throw new Error("豆包执行窗口已关闭");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      win.webContents.removeListener("did-finish-load", onFinish);
      win.webContents.removeListener("did-fail-load", onFail);
      if (timer) clearTimeout(timer);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onFinish = () => finish();
    const onFail = (_event: Electron.Event, code: number, description: string, validatedURL: string, isMainFrame: boolean) => {
      // ERR_ABORTED is emitted when a SPA/login redirect supersedes navigation.
      // Keep the listener installed: a later real main-frame failure still matters.
      if (isMainFrame === false || code === -3) return;
      let host = "unknown";
      try { host = new URL(validatedURL || url).hostname; } catch { /* no full URLs in diagnostics */ }
      finish(new Error(`豆包主页面加载失败：code=${code} ${description || "unknown"} host=${host}`));
    };
    win.webContents.on("did-finish-load", onFinish);
    win.webContents.on("did-fail-load", onFail);
    timer = setTimeout(() => {
      finish(new Error(`豆包主页面加载超时（${Math.ceil(timeoutMs / 1000)} 秒），尚未确认页面就绪`));
      if (!win.isDestroyed()) win.webContents.stop();
    }, timeoutMs);
    void win.loadURL(url).catch((error: unknown) => {
      const detail = error as { code?: string; errno?: number; message?: string };
      if (detail?.code === "ERR_ABORTED" || detail?.errno === -3 || /ERR_ABORTED/.test(detail?.message || "")) return;
      finish(error instanceof Error ? error : new Error("豆包主页面 loadURL 被拒绝"));
    });
  });
}

/** A renderer can stop responding indefinitely; a timeout is uncertainty, not permission to resubmit. */
export function withPageDeadline<T>(operation: () => Promise<T>, onTimeout: () => void, timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout(); } catch { /* retain the original timeout */ }
      reject(new Error("豆包页面脚本超时，执行窗口已终止；提交结果可能未知，请勿自动重复生成"));
    }, timeoutMs);
    void Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}
