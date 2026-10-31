import { BrowserWindow, ipcMain } from "electron";

// The pages' own title bars (2026-10-29, the user: every window in AMO's style, like the workbench): the windows have
// no system title bar, the page draws one and its minimise / maximise (restore) / close buttons (ui/src/shell/
// WindowControls.tsx), which act on the window that sent them. Studio's workbench hides on × by its own close handler;
// every other window closes.

/** `amo:window`, `amo:window-maximized` and `amo:window-top` for every window of the program; call once. */
export function installWindowControls(): void {
  ipcMain.on("amo:window", (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") {
      if (!win.isMaximizable()) return;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === "close") win.close();
  });
  ipcMain.handle("amo:window-maximized", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return !!win && !win.isDestroyed() && win.isMaximized();
  });
  // 置顶 (pin) left of 最小化 (2026-10-31, 问题 #3): the window above other windows or not; without a value, whether it is.
  ipcMain.handle("amo:window-top", (event, on: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (typeof on === "boolean") win.setAlwaysOnTop(on, "floating");
    return win.isAlwaysOnTop();
  });
}

/** The window tells its page when it is maximised or restored (the page's button shows 最大化 or 还原). */
export function sendMaximized(win: BrowserWindow): void {
  win.on("maximize", () => win.webContents.send("amo:window-maximized", true));
  win.on("unmaximize", () => win.webContents.send("amo:window-maximized", false));
}
