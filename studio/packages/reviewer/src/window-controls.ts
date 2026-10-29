import { BrowserWindow, ipcMain } from "electron";

// The pages' own title bars (2026-10-29, the user: every window in AMO's style, like the workbench): the windows have
// no system title bar, the page draws one and its minimise / maximise (restore) / close buttons (ui/src/shell/
// WindowControls.tsx), which act on the window that sent them. Studio's workbench hides on × by its own close handler;
// every other window closes.

/** `amo:window` and `amo:window-maximized` for every window of the program; call once. */
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
}

/** The window tells its page when it is maximised or restored (the page's button shows 最大化 or 还原). */
export function sendMaximized(win: BrowserWindow): void {
  win.on("maximize", () => win.webContents.send("amo:window-maximized", true));
  win.on("unmaximize", () => win.webContents.send("amo:window-maximized", false));
}
