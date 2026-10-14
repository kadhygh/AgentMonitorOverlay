import { BrowserWindow, ipcMain } from "electron";

// The Git Review windows (S11-D): one ordinary window per project, loaded with #review?workspace=…&session=…. Opening
// a project's review again brings its window forward (and points it at the new session) instead of opening another.
// A commit from the history (S13-B) opens in a window of its own, one per commit: #review?workspace=…&commit=….

export interface ReviewWindowOptions {
  /** The UI's address (Host or dev server), once the Host is connected. */
  url(): string | null;
  preload: string;
  icon: string;
  testMode: boolean;
}

const ID = /^[\w-]{1,80}$/;
/** A commit, abbreviated or full. */
const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * `#review?workspace=…&session=…` (or `&commit=…`) for a valid target, null otherwise; `key` names the window: the
 * project's, or the project's commit's. A commit that is not 7–40 hex digits makes the target invalid.
 */
export function reviewHash(target: unknown): { key: string; hash: string } | null {
  const t = target as { workspaceId?: unknown; sessionId?: unknown; commit?: unknown } | null;
  if (typeof t?.workspaceId !== "string" || !ID.test(t.workspaceId)) return null;
  if (t.commit !== undefined && (typeof t.commit !== "string" || !COMMIT.test(t.commit))) return null;
  const commit = typeof t.commit === "string" ? t.commit : null;
  if (commit) return { key: `${t.workspaceId}@${commit}`, hash: `#review?workspace=${t.workspaceId}&commit=${commit}` };
  const session = typeof t.sessionId === "string" && ID.test(t.sessionId) ? t.sessionId : null;
  return { key: t.workspaceId, hash: `#review?workspace=${t.workspaceId}${session ? `&session=${session}` : ""}` };
}

/** Handles `amo:open-review` from the pages; returns what the main window needs to close the reviews with it. */
export function setupReviewWindows(options: ReviewWindowOptions): { closeAll(): void } {
  const windows = new Map<string, BrowserWindow>();

  ipcMain.handle("amo:open-review", (_event, target: unknown) => {
    const t = reviewHash(target);
    const url = options.url();
    if (!t || !url) return;
    const open = windows.get(t.key);
    if (open && !open.isDestroyed()) {
      // Same project: the page follows the new hash (another session), and the window comes forward.
      void open.webContents.executeJavaScript(`location.hash = ${JSON.stringify(t.hash)}`);
      if (options.testMode) return;
      if (open.isMinimized()) open.restore();
      open.show();
      open.focus();
      return;
    }
    const win = createReviewWindow(`${url}${t.hash}`, options);
    windows.set(t.key, win);
    win.on("closed", () => windows.delete(t.key));
  });

  return {
    closeAll: () => {
      for (const w of windows.values()) if (!w.isDestroyed()) w.destroy();
      windows.clear();
    },
  };
}

function createReviewWindow(url: string, { preload, icon, testMode }: ReviewWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    // The page renames it after its project (document.title).
    title: "Git Review",
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
