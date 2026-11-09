import { BrowserWindow, ipcMain } from "electron";
import { sendMaximized } from "@amo-studio/reviewer";

// 计划窗口 (2026-11-09, the user: Claude 的计划在聊天里是一大章文字，不能批注，回复还要回到聊天输入框 — plans/done/plan-review-window.md):
// a plan Claude asks to have reviewed opens in a window of its own, loaded with #plan?session=…&item=…, beside the
// conversation; the plan takes annotations there and has its own box for what to change. One window per session:
// opening that session's plan again brings it forward (on the version asked for). They close with the workbench.

export interface PlanWindowOptions {
  /** The UI's address (the Host, or the dev server). */
  url: string;
  preload: string;
  icon: string;
  testMode: boolean;
  mainWindow: BrowserWindow;
}

const ID = /^[\w-]{1,80}$/;

/** `#plan?session=…&item=…` for a valid request (the item is optional: the session's latest plan), null otherwise. */
export function planHash(target: unknown): string | null {
  const t = target as { sessionId?: unknown; itemId?: unknown } | null;
  if (typeof t?.sessionId !== "string" || !ID.test(t.sessionId)) return null;
  const q = new URLSearchParams({ session: t.sessionId });
  if (typeof t.itemId === "string" && ID.test(t.itemId)) q.set("item", t.itemId);
  return `#plan?${q.toString()}`;
}

/** Handles `amo:open-plan`; call once, after the workbench window exists. */
export function installPlanWindows(options: PlanWindowOptions): void {
  const windows = new Map<string, BrowserWindow>();

  ipcMain.handle("amo:open-plan", (_event, target: unknown) => {
    const hash = planHash(target);
    if (!hash) return;
    const sessionId = (target as { sessionId: string }).sessionId;
    const open = windows.get(sessionId);
    if (open && !open.isDestroyed()) {
      void open.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      if (options.testMode) return;
      if (open.isMinimized()) open.restore();
      open.show();
      open.focus();
      return;
    }
    const win = createPlanWindow(`${options.url}${hash}`, options);
    windows.set(sessionId, win);
    win.on("closed", () => {
      if (windows.get(sessionId) === win) windows.delete(sessionId);
    });
  });

  options.mainWindow.on("closed", () => {
    for (const w of windows.values()) if (!w.isDestroyed()) w.destroy();
    windows.clear();
  });
}

function createPlanWindow(url: string, { preload, icon, testMode }: PlanWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 820,
    minWidth: 520,
    minHeight: 400,
    // The page renames it after the plan (document.title).
    title: "计划",
    icon,
    backgroundColor: "#efede8",
    // No system title bar (AMO's style): the page's head drags the window and has its buttons.
    titleBarStyle: "hidden",
    // Tests: off-screen, out of the taskbar, never focused (LOOP_RULES red line 7), as the workbench.
    show: false,
    ...(testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    paintWhenInitiallyHidden: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !testMode },
  });
  win.setMenuBarVisibility(false);
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
