import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { displays, type ShellPrefs } from "./focus-window.js";
import { placeRound, type Rect } from "./placement.js";
import { roundHash, RoundSet, roundTarget } from "./round-rules.js";

// 会话弹窗 as a window of its own (2026-11-16, the user: 脉络点击的弹窗要独立弹窗，不然会被限制拖动范围): a card picked in
// 脉络's building opens that session's conversation, with its composer, in a window loaded with #round?…, which can go
// anywhere — past the workbench's edge, onto another display. The workbench's windows' rules: owned by the workbench
// (above it, not above other programs; they go when it hides or closes), and reused as the viewer is — the one not
// pinned shows the next card, a pinned one stays and the next card opens another (round-rules.ts). The workbench is
// told which are open (amo:rounds): its building marks the card of the one not pinned, and its composer steps aside
// while one shows the building's own session.

export interface RoundWindowOptions {
  /** The UI's address (the Host, or the dev server). */
  url: string;
  preload: string;
  icon: string;
  testMode: boolean;
  mainWindow: BrowserWindow;
  prefs: ShellPrefs;
}

/** Handles the amo:round-* calls; call once, after the workbench window exists. */
export function installRoundWindows(options: RoundWindowOptions): void {
  const { mainWindow, testMode } = options;
  const set = new RoundSet<BrowserWindow>();
  let opened = 0;
  const tell = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("amo:rounds", set.list());
  };
  const forward = (win: BrowserWindow) => {
    if (testMode || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  ipcMain.handle("amo:round-open", (_event, target: unknown) => {
    const t = roundTarget(target);
    if (!t) return;
    const hash = roundHash(t, ++opened);
    const reuse = set.target();
    if (reuse && !reuse.isDestroyed()) {
      set.shown(reuse, t);
      void reuse.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      tell();
      // Shown again if it was minimised, but the focus stays in the building (the next card, the arrow keys).
      if (!testMode && reuse.isMinimized()) reuse.showInactive();
      return;
    }
    const win = createRoundWindow(`${options.url}${hash}`, options, set.all().map((w) => w.getBounds()));
    set.created(win, t);
    win.on("closed", () => {
      set.closed(win);
      tell();
    });
    tell();
  });

  // From the workbench: a building's window not pinned (its card let go), or (all) every one of it (the building gone).
  ipcMain.handle("amo:round-close", (_event, v: unknown) => {
    const a = v as { towerFor?: unknown; all?: unknown } | null;
    if (typeof a?.towerFor !== "string") return;
    for (const w of set.ofTower(a.towerFor, a.all === true)) if (!w.isDestroyed()) w.close();
  });
  // 切到弹窗: the window showing that session, in front.
  ipcMain.handle("amo:round-show", (_event, sessionId: unknown) => {
    const w = typeof sessionId === "string" ? set.showing(sessionId) : null;
    if (w) forward(w);
  });
  ipcMain.handle("amo:rounds-get", () => set.list());

  // From a window: 固定 (it stays; answers whether it now is), whether it is, and 到对话里看.
  const own = (sender: WebContents) => {
    const w = BrowserWindow.fromWebContents(sender);
    return w && set.targetOf(w) ? w : null;
  };
  ipcMain.handle("amo:round-pin", (event) => {
    const w = own(event.sender);
    const ok = !!w && set.pin(w);
    tell();
    return ok;
  });
  ipcMain.handle("amo:round-state", (event) => {
    const w = own(event.sender);
    return { pinned: !!w && set.isPinned(w) };
  });
  ipcMain.handle("amo:round-chat", (event, itemId: unknown) => {
    const w = own(event.sender);
    const t = w && set.targetOf(w);
    if (!w || !t || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("amo:round-chat", { taskId: t.taskId, sessionId: t.sessionId, towerFor: t.towerFor, ...(typeof itemId === "string" && itemId ? { itemId } : {}) });
    w.close();
    if (testMode) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // They are the building's, which is in the workbench: hidden (its × keeps Studio in the tray) or closed, they go.
  const closeAll = () => {
    for (const w of set.all()) if (!w.isDestroyed()) w.destroy();
  };
  mainWindow.on("hide", closeAll);
  mainWindow.on("closed", closeAll);
  // The workbench's page loaded again (F5): its building is drawn anew, with nothing picked.
  mainWindow.webContents.on("did-navigate", closeAll);
  // Quitting: closed before the workbench is. Left open to go with it, quitting never got to will-quit (the e2e's
  // app.close() hung every time with one open, 2026-11-16; why, not found out).
  app.on("before-quit", closeAll);
}

function createRoundWindow(url: string, { preload, icon, testMode, mainWindow, prefs }: RoundWindowOptions, open: Rect[]): BrowserWindow {
  const main = mainWindow.isMaximized() || mainWindow.isMinimized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  const bounds = testMode ? { width: 600, height: 760 } : placeRound(prefs.round(), main, displays(), open);
  const win = new BrowserWindow({
    ...bounds,
    // Narrower than this, the composer's bar (model, effort, send) no longer fits on its line.
    minWidth: 400,
    minHeight: 280,
    // The page renames it after the session (document.title).
    title: "会话弹窗",
    icon,
    backgroundColor: "#efede8",
    // Owned by the workbench: always above it, never under it, not above other programs; it goes when the workbench does.
    parent: mainWindow,
    // No system title bar (AMO's style): the page's head drags the window; its edges size it.
    titleBarStyle: "hidden",
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
  if (!testMode) {
    // Where it is and how big, for the next one (as the workbench's: written once it has been still a moment).
    let soon: NodeJS.Timeout | null = null;
    const remember = () => {
      if (soon) clearTimeout(soon);
      soon = null;
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
      prefs.setRound(win.getBounds());
    };
    const later = () => {
      if (soon) clearTimeout(soon);
      soon = setTimeout(remember, 500);
    };
    win.on("resize", later);
    win.on("move", later);
    win.on("close", remember);
  }
  void win.loadURL(url);
  return win;
}
