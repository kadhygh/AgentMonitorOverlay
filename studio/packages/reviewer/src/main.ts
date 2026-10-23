import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startHost, type RunningHost } from "@amo-studio/host";
import type { HostEvent } from "@amo-studio/protocol";
import { setupReviewWindows } from "./review-window.js";
import { setupViewerWindows } from "./viewer-window.js";

// AMO Reviewer (2026-10-23): Git Review, the viewer and 查看包 as a program of their own, for any tool or model, not
// only AMO Studio (plans/reviewer-standalone.md). It runs a Host of its own with no models — its own data dir, the same
// routes the review pages use — and opens the windows the Host is asked for: `amo-review <folder> --data <its data>`,
// or this program started with a folder. Comments are copied (复制注释); there is nothing to send them to. Bookmarks are
// Studio's and are not shown here. It ends with its last window.
// Env:
//   AMO_REVIEWER_HOME    its home (default %APPDATA%\AMO Reviewer); the Host's data is in its data\
//   AMO_REVIEWER_UI_DIR  the UI build (default packages/ui/dist)
//   AMO_REVIEWER_TEST=1  test mode: windows off-screen, never focused; copies recorded, not put on the clipboard
// Args: <folder> [--file <path>] [--line <n>] [--end-line <n>] [--mode file|changes] [--commit <ref>] [--base <ref>]

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.AMO_REVIEWER_TEST === "1";
const home = resolve(process.env.AMO_REVIEWER_HOME ?? join(app.getPath("appData"), "AMO Reviewer"));
const dataDir = join(home, "data");
const uiDir = resolve(process.env.AMO_REVIEWER_UI_DIR ?? join(here, "..", "..", "ui", "dist"));
const ICON = [join(here, "..", "assets", "icon.png"), join(here, "..", "..", "app", "assets", "icon.png")].find((p) => existsSync(p)) ?? "";
const preload = join(here, "preload.cjs");

app.setPath("userData", join(home, "electron"));
// Its own taskbar group, also when it runs from AMO Studio.exe.
if (process.platform === "win32") app.setAppUserModelId("AMO.Reviewer");

let host: RunningHost | null = null;
const pageUrl = () => (host ? `${host.info.url}/reviewer.html` : null);
const reviews = setupReviewWindows({ url: pageUrl, preload, icon: ICON, testMode });
const viewers = setupViewerWindows({ url: pageUrl, preload, icon: ICON, testMode });

/** What the command line asks to open: a folder (its changes, or a file of it), as `amo-review` takes it. */
export function parseArgs(argv: readonly string[]): Record<string, unknown> | null {
  // `electron …/main.js <folder>` in development; the portable exe has no script argument: `AMO Reviewer.exe <folder>`.
  const script = argv.findIndex((a) => /main\.js$|[\\/]reviewer$/i.test(a));
  const args = argv.slice(script >= 0 ? script + 1 : 1).filter((a) => !a.startsWith("--inspect"));
  const out: Record<string, unknown> = {};
  let folder: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = args[i + 1];
    if (a === "--file" && value) out.file = (i++, value);
    else if ((a === "--line" || a === "--end-line") && value) out[a === "--line" ? "line" : "endLine"] = (i++, Number(value));
    else if (a === "--mode" && value) out.mode = (i++, value);
    else if (a === "--commit" && value) out.commit = (i++, value);
    else if (a === "--base" && value) out.base = (i++, value);
    else if (!a.startsWith("--") && !folder) folder = a;
  }
  return folder ? { ...out, path: resolve(folder) } : null;
}

/** Asks the Host to open what the command line names; the Host's event opens the window. */
async function openFromArgs(argv: readonly string[]): Promise<void> {
  const target = parseArgs(argv);
  if (!target || !host) return;
  try {
    await host.service.gitReview.openReview(target as never);
  } catch (err) {
    console.error(`AMO Reviewer: cannot open ${String(target.path)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The windows the Host is asked for (review_open, view_open, amo-review): as Studio's main window opens them. */
function onHostEvent(e: HostEvent): void {
  if (Date.now() - Date.parse((e as { at?: string }).at ?? "") > 60_000) return;
  if (e.type === "review.open") {
    const t = e.target;
    if (t.mode === "file" && t.file) viewers.open({ path: t.file, workspaceId: t.workspaceId, ...(t.line !== undefined ? { line: t.line } : {}), ...(t.endLine !== undefined ? { endLine: t.endLine } : {}) });
    else reviews.open({ ...t, nonce: `ext-${e.seq}` });
  } else if (e.type === "viewpack.open") {
    viewers.open({ path: "", pack: e.packId, ...(e.itemId ? { item: e.itemId } : {}) });
  }
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  mkdirSync(dataDir, { recursive: true });
  host = await startHost({ dataDir, port: 0, uiDir, profiles: [] });
  // The Host opens Review only for a listening window; here the program itself listens (onHostEvent).
  host.service.liveWindows = 1;
  host.service.on("event", onHostEvent);

  ipcMain.handle("amo:host", () => (host ? { url: host.info.url, token: host.token } : null));
  ipcMain.handle("amo:copy", (_event, text: string) => {
    // Tests run side by side: they record what would be copied instead of taking the person's clipboard.
    if (testMode) ((globalThis as { __reviewerCopied?: string[] }).__reviewerCopied ??= []).push(String(text));
    else clipboard.writeText(String(text));
  });
  ipcMain.handle("amo:open-external", (_event, url: string) => (/^https?:\/\//.test(String(url)) ? shell.openExternal(String(url)) : undefined));
  ipcMain.on("amo:min-width", (event, px: number) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed() && Number.isFinite(px) && px > 0) w.setMinimumSize(Math.min(Math.round(px), 1600), w.getMinimumSize()[1] ?? 0);
  });
  if (testMode) Object.assign(globalThis, { __reviewerHost: { url: host.info.url, token: host.token, dataDir } });

  await openFromArgs(process.argv);
}

if (!app.requestSingleInstanceLock()) {
  // One runs already: it opens what this start asked for (second-instance) and this one ends.
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => void openFromArgs(argv));
  // Started without a folder it waits for amo-review; it ends with its last window once one was opened.
  let hadWindow = false;
  app.on("browser-window-created", () => (hadWindow = true));
  app.on("window-all-closed", () => {
    if (hadWindow) app.quit();
  });
  app.on("will-quit", () => void host?.shutdown());
  void app.whenReady().then(start);
}
