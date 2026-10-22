import { BrowserWindow, ipcMain } from "electron";

// The file marks window (文件标记, S12-D; 书签 since 2026-10-19): one ordinary window, loaded with #marks?topic=….
// Opening it again brings it forward and points it at the new project instead of opening another. It closes with the
// workbench.

export interface MarksWindowOptions {
  /** The UI's address (the Host, or the dev server). */
  url: string;
  preload: string;
  icon: string;
  testMode: boolean;
  mainWindow: BrowserWindow;
}

const ID = /^[\w-]{1,80}$/;

let opened = 0;

/**
 * `#marks?topic=…&workspace=…&task=…&mark=…&edit=1&n=…` for what the page asked (invalid ids are dropped; topic "none" is
 * 未归专题). `n` changes on every open, so asking for the same mark again still reaches the page as a hash change.
 */
export function marksHash(target: unknown): string {
  const t = target as { topicId?: unknown; workspaceId?: unknown; taskId?: unknown; markId?: unknown; edit?: unknown } | null;
  const q: string[] = [];
  if (typeof t?.topicId === "string" && ID.test(t.topicId)) q.push(`topic=${t.topicId}`);
  if (typeof t?.workspaceId === "string" && ID.test(t.workspaceId)) q.push(`workspace=${t.workspaceId}`);
  if (typeof t?.taskId === "string" && ID.test(t.taskId)) q.push(`task=${t.taskId}`);
  if (typeof t?.markId === "string" && ID.test(t.markId)) {
    q.push(`mark=${t.markId}`);
    if (t.edit === true) q.push("edit=1");
    q.push(`n=${++opened}`);
  }
  return q.length ? `#marks?${q.join("&")}` : "#marks";
}

/** Handles `amo:open-marks` from the pages; call once, after the workbench window exists. */
export function installMarksWindow(options: MarksWindowOptions): void {
  let win: BrowserWindow | null = null;

  ipcMain.handle("amo:open-marks", (_event, target: unknown) => {
    const hash = marksHash(target);
    if (win && !win.isDestroyed()) {
      void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      if (options.testMode) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = createMarksWindow(`${options.url}${hash}`, options);
    win.on("closed", () => (win = null));
  });

  options.mainWindow.on("closed", () => {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  });
}

function createMarksWindow(url: string, { preload, icon, testMode }: MarksWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 520,
    minHeight: 400,
    title: "书签",
    icon,
    backgroundColor: "#efede8",
    // Tests: off-screen, out of the taskbar, never focused (LOOP_RULES red line 7), as the workbench.
    show: false,
    ...(testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    paintWhenInitiallyHidden: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !testMode },
  });
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  win.once("ready-to-show", () => (testMode ? win.showInactive() : win.show()));
  void win.loadURL(url);
  return win;
}
