import { BrowserWindow, ipcMain } from "electron";
import { viewerHash, ViewerSet } from "./viewer-rules.js";
import { sendMaximized } from "./window-controls.js";

// The viewer windows (查看器, stage 13): a file opened from a conversation (or a mark) shows in one preview window,
// loaded with #viewer?path=…; opening another file reuses it. 固定 keeps that window, and the next file opens a new one.

export interface ViewerWindowOptions {
  /** The UI's address (Host or dev server), once the Host is connected. */
  url(): string | null;
  preload: string;
  icon: string;
  testMode: boolean;
}

/** Handles `amo:open-viewer`, `amo:viewer-pin` and `amo:viewer-state`; returns what closes the viewers with the workbench. */
export function setupViewerWindows(options: ViewerWindowOptions): { closeAll(): void; open(target: unknown): void } {
  const set = new ViewerSet<BrowserWindow>();
  let opened = 0;

  // Opened from a page (amo:open-viewer) or, in the AMO Reviewer program, by the main process itself (2026-10-23).
  const open = (target: unknown): void => {
    const hash = viewerHash(target, ++opened);
    const url = options.url();
    if (!hash || !url) return;
    const reuse = set.target();
    if (reuse && !reuse.isDestroyed()) {
      void reuse.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      if (options.testMode) return;
      if (reuse.isMinimized()) reuse.restore();
      reuse.show();
      reuse.focus();
      return;
    }
    const win = createViewerWindow(`${url}${hash}`, options);
    set.created(win);
    win.on("closed", () => set.closed(win));
  };
  ipcMain.handle("amo:open-viewer", (_event, target: unknown) => open(target));

  // 固定 from the page: this window is kept. Answers whether it is (now) pinned.
  ipcMain.handle("amo:viewer-pin", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return !!win && set.pin(win);
  });
  ipcMain.handle("amo:viewer-state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { pinned: !!win && set.isPinned(win) };
  });

  return {
    open,
    closeAll: () => {
      for (const w of set.all()) if (!w.isDestroyed()) w.destroy();
    },
  };
}

function createViewerWindow(url: string, { preload, icon, testMode }: ViewerWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 520,
    minHeight: 360,
    // The page renames it after the file (document.title).
    title: "查看器",
    icon,
    backgroundColor: "#efede8",
    // No system title bar (2026-10-29): the page's head is the title bar, with its own window buttons.
    titleBarStyle: "hidden",
    // Tests: off-screen, out of the taskbar, never focused (LOOP_RULES red line 7), as the workbench.
    show: false,
    ...(testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    paintWhenInitiallyHidden: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !testMode },
  });
  sendMaximized(win);
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  win.once("ready-to-show", () => (testMode ? win.showInactive() : win.show()));
  void win.loadURL(url);
  return win;
}
