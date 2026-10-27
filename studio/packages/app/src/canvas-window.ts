import { BrowserWindow, ipcMain } from "electron";

// 画布小窗 (2026-10-27, 画布审阅 stage 3): one small window that keeps a topic's canvas in sight beside other work,
// loaded with #canvas-mini?topic=…; on top of other windows unless the person unpins it. Opening it again brings it
// forward on the topic asked for. It closes with the workbench.

export interface CanvasWindowOptions {
  /** The UI's address (the Host, or the dev server). */
  url: string;
  preload: string;
  icon: string;
  testMode: boolean;
  mainWindow: BrowserWindow;
}

const ID = /^[\w-]{1,80}$/;

/** `#canvas-mini?topic=…` for the topic asked (an invalid id is dropped: the window picks one). */
export function canvasMiniHash(target: unknown): string {
  const t = target as { topicId?: unknown } | null;
  return typeof t?.topicId === "string" && ID.test(t.topicId) ? `#canvas-mini?topic=${t.topicId}` : "#canvas-mini";
}

/** Handles `amo:open-canvas-mini` and `amo:canvas-mini-top`; call once, after the workbench window exists. */
export function installCanvasWindow(options: CanvasWindowOptions): void {
  let win: BrowserWindow | null = null;

  ipcMain.handle("amo:open-canvas-mini", (_event, target: unknown) => {
    const hash = canvasMiniHash(target);
    if (win && !win.isDestroyed()) {
      void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      if (options.testMode) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = createCanvasWindow(`${options.url}${hash}`, options);
    win.on("closed", () => (win = null));
  });

  // 置顶 in the window: on top of other windows or not; answers whether it now is.
  ipcMain.handle("amo:canvas-mini-top", (event, on: unknown) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || w !== win) return false;
    if (typeof on === "boolean") w.setAlwaysOnTop(on, "floating");
    return w.isAlwaysOnTop();
  });

  options.mainWindow.on("closed", () => {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  });
}

function createCanvasWindow(url: string, { preload, icon, testMode }: CanvasWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 460,
    minWidth: 360,
    minHeight: 280,
    title: "画布小窗",
    icon,
    backgroundColor: "#efede8",
    alwaysOnTop: true,
    // Tests: off-screen, out of the taskbar, never focused (LOOP_RULES red line 7), as the workbench.
    show: false,
    ...(testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    paintWhenInitiallyHidden: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !testMode },
  });
  win.setMenuBarVisibility(false);
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  win.once("ready-to-show", () => (testMode ? win.showInactive() : win.show()));
  void win.loadURL(url);
  return win;
}
