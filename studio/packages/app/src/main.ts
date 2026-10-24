import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectHost, keepHostAlive, stopHost, type HostConnection, type HostLinkOptions } from "./host-link.js";
import { createFocusWindow, displays, mainBounds, pagePressed, recoverLostClicks, refitFocusWindow, rescaleFocusWindow, ShellPrefs, UI_SCALES, uiScaleOk } from "./focus-window.js";
import { centreIn, displayFor } from "./placement.js";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveDataDir } from "./paths.js";
import { runSetup, SETUP_TEMP_PROFILE } from "./setup.js";
import { installNotesLink } from "./notes-link.js";
import { setupReviewWindows, setupViewerWindows } from "@amo-studio/reviewer";
import { installMarksWindow } from "./marks-window.js";
import { ResizeTrace } from "./resize-trace.js";
import { setupBotFlight } from "./bot-window.js";
import { installFolderIpc } from "./folders.js";

// Electron main process: single instance, connects to (or starts) the resident Host, and opens the workbench window.
// Env:
//   AMO_STUDIO_DATA_DIR   data dir (default: studio/.data in development; the portable build's saved choice or
//                         data/ next to the exe, see paths.ts)
//   AMO_STUDIO_PORTABLE_DIR  tests: behave as the portable build installed in this folder
//   AMO_STUDIO_DEV_URL    load the UI from the Vite dev server instead of the Host
//   AMO_STUDIO_TEST=1     test mode: hidden window that never takes focus, Host stops with the app
//   AMO_STUDIO_PORT       Host port (tests use 0)

const here = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(here, "..", "..", "..");
const testMode = process.env.AMO_STUDIO_TEST === "1";
/** Window and taskbar icon (the exe's own icon is set when packaging). */
const APP_ICON = join(here, "..", "assets", "icon.png");
// The portable build is Electron itself with Studio in resources/app; the exe's folder is the portable root.
const portableDir = process.env.AMO_STUDIO_PORTABLE_DIR ?? (app.isPackaged ? dirname(process.execPath) : null);
const dataChoice = resolveDataDir({ env: process.env, portableDir, studioRoot });
const dataDir = dataChoice.dataDir;

// Experiments for the resize flicker (2026-10-15; off unless set when starting the app): use the GPU even when
// Chromium's blocklist says not to, and the system title bar instead of the page-drawn one.
if (process.env.AMO_STUDIO_GPU === "ignore-blocklist") app.commandLine.appendSwitch("ignore-gpu-blocklist");
// Pages build no accessibility tree (2026-10-20). When a program reads a window through UI Automation (word pickers,
// translators, some input methods), its page sends this process its whole tree and every change to it, and this
// process handles them on its main thread: opening a 2879-line prefab in the viewer (33k elements) held it up for 18 s,
// freezing every window, Focus on top of all others included. Screen readers and such tools then see no text in
// Studio; AMO_STUDIO_A11Y=1 turns it back on.
if (process.env.AMO_STUDIO_A11Y !== "1") app.commandLine.appendSwitch("disable-renderer-accessibility");
const nativeFrame = process.env.AMO_STUDIO_NATIVE_FRAME === "1";
/** The main window's smallest size, and whether the window itself keeps it (the old way; see createMainWindow). */
const MAIN_MIN = { width: 960, height: 600 };
const windowMinSize = process.env.AMO_STUDIO_WINDOW_MIN === "1";

// Chromium's profile (localStorage, caches) and the single-instance lock live in userData. Without this it is the
// generic %APPDATA%\Electron, shared by every run: tests saw each other's remembered model, and a test run could
// collide with a Studio the person has open. Keep it with the data dir instead (set before the lock is taken).
// First run of the portable build: the data dir is not chosen yet, so the setup window gets a throwaway profile.
app.setPath("userData", dataChoice.firstRun ? SETUP_TEMP_PROFILE(tmpdir()) : join(dataDir, "electron"));

let host: HostConnection | null = null;
let stopKeepAlive: (() => void) | null = null;
let mainWindow: BrowserWindow | null = null;
let focusWindow: BrowserWindow | null = null;
/** Resize trace (logs/resize-trace.log), made once the app is ready. */
let trace: ResizeTrace | null = null;
/** Whether the Focus window lets clicks through right now (点击穿透), for the trace. */
let focusIgnoring = false;
/** What each Focus page last asked for (a new Focus window starts over). */
const focusMouseSet = new WeakMap<Electron.WebContents, boolean>();
/** 界面大小 one step (Ctrl + = / - / 0), set up with the IPC handlers. */
let stepUiScaleRef: (dir: 1 | -1 | 0) => void = () => undefined;
const prefs = new ShellPrefs(dataDir);
const reviews = setupReviewWindows({ url: () => (host ? (process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`) : null), preload: join(here, "preload.cjs"), icon: APP_ICON, testMode });
// The angry robot that flies about the screen when something waited too long (2026-10-15 evening).
const bot = setupBotFlight({
  url: () => (host ? (process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`) : null),
  preload: join(here, "preload.cjs"),
  testMode,
  scale: () => prefs.uiScale(),
  onCaught: () => focusWindow?.webContents.send("amo:bot-caught"),
  note: (what) => trace?.note("bot", what),
});
const viewers = setupViewerWindows({ url: () => (host ? (process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`) : null), preload: join(here, "preload.cjs"), icon: APP_ICON, testMode });

/** Focus is on by default for people and off in tests unless a test turns it on. */
function setFocusVisible(on: boolean): void {
  prefs.setFocus(on);
  if (on && !focusWindow && host) {
    focusWindow = createFocusWindow({
      url: process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`,
      preload: join(here, "preload.cjs"),
      testMode,
      scale: prefs.uiScale(),
      saved: prefs.focusPos(),
      onMoved: (pos) => prefs.setFocusPos(pos),
    });
    focusWindow.on("closed", () => {
      focusWindow = null;
      bot.land();
    });
    // Every mouse message of Focus, written on the main thread: only when asked for (2026-10-15 click investigation).
    if (process.env.AMO_STUDIO_TRACE_INPUT === "1") trace?.watchInput(focusWindow, "focus");
    recoverLostClicks(focusWindow, { testMode, note: (at) => trace?.note("focus", "click given back", `at ${at.x},${at.y}`) });
  } else if (!on && focusWindow) {
    focusWindow.destroy();
    focusWindow = null;
    bot.land();
  }
  mainWindow?.webContents.send("amo:focus-changed", on);
}

/**
 * Brings the workbench window to the front (Focus's 打开主窗口, 在工作台打开, the robot). Focus never activates, and when
 * Windows dropped the press on it (MA_NOACTIVATEANDEAT; focus-clicks.ts gives the click back) Studio has no right to
 * take the foreground: focus() alone then only flashes the taskbar button and the window stays behind (2026-10-19:
 * in the trace every 打开主窗口 that did nothing was a click given back). Topmost for a moment raises it anyway; if it
 * still did not get the keyboard, the taskbar button stops flashing (the window is already in front).
 */
function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  if (!win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
  }
  win.focus();
  setTimeout(() => {
    if (win.isDestroyed()) return;
    const focused = win.isFocused();
    if (!focused) win.flashFrame(false);
    trace?.note("main", "bring forward", focused ? "focused" : "raised, not focused");
  }, 300);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // A user launched Studio again: bring the existing window forward (never happens in tests).
    if (mainWindow && !testMode) bringForward(mainWindow);
  });

  ipcMain.handle("amo:host", () => (host ? { url: host.url, token: host.token } : null));
  // The page draws the title bar and its window buttons (minimise, maximise / restore, close).
  ipcMain.on("amo:window", (event, action: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (action === "minimize") mainWindow.minimize();
    else if (action === "maximize") mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === "close") mainWindow.close();
  });
  ipcMain.handle("amo:window-maximized", (event) => (mainWindow && event.sender === mainWindow.webContents ? mainWindow.isMaximized() : false));
  // Copy through the main process: navigator.clipboard needs a focused document, which is not always the case.
  // Tests never touch the user's clipboard; they read the recorded text instead.
  // A page's top bar needs this much width (CSS px, lib/fitWidth.ts): the window keeps at least that, never less than
  // the minimum it was made with (2026-10-23: Review's buttons from 历史 to 刷新 always on one line).
  const madeMin = new WeakMap<BrowserWindow, number[]>();
  ipcMain.on("amo:min-width", (event, px: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || typeof px !== "number" || !Number.isFinite(px) || px < 0 || px > 10_000) return;
    if (!madeMin.has(win)) madeMin.set(win, win.getMinimumSize());
    const [floorW, floorH] = madeMin.get(win)!;
    const frame = win.getSize()[0]! - win.getContentSize()[0]!;
    const want = Math.max(floorW!, Math.ceil(px * event.sender.getZoomFactor()) + frame);
    win.setMinimumSize(want, floorH!);
    const [w, h] = win.getSize();
    if (w! < want && !win.isMaximized() && !win.isFullScreen()) win.setSize(want, h!);
  });
  ipcMain.handle("amo:copy", (_event, text: unknown) => {
    if (typeof text !== "string") return;
    if (testMode) ((globalThis as { __amoCopied?: string[] }).__amoCopied ??= []).push(text);
    else clipboard.writeText(text);
  });
  // Links in replies open in the system browser; only http(s) is allowed through.
  ipcMain.handle("amo:open-external", async (_event, url: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    // Tests never open a browser (it would take focus); they read the recorded URLs instead.
    if (testMode) {
      ((globalThis as { __amoOpenedUrls?: string[] }).__amoOpenedUrls ??= []).push(url);
      return;
    }
    await shell.openExternal(url);
  });
  // 置顶 (stage 14): the workbench window above other windows, remembered for the next start.
  ipcMain.handle("amo:pin-get", () => mainWindow?.isAlwaysOnTop() ?? false);
  ipcMain.handle("amo:pin-set", (_event, on: unknown) => {
    const pinned = on === true;
    prefs.setPinned(pinned);
    if (!mainWindow) return;
    mainWindow.setAlwaysOnTop(pinned);
    mainWindow.webContents.send("amo:pin-changed", pinned);
  });
  // 界面大小 (2026-10-15): one zoom for every Studio page, kept for the next start. Chromium zooms by origin, so
  // setting it on one page sets it on all of them; each page gets it again when it loads.
  const setUiScale = (scale: number) => {
    prefs.setUiScale(scale);
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.setZoomFactor(scale);
    if (focusWindow) rescaleFocusWindow(focusWindow, scale);
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("amo:ui-scale-changed", scale);
  };
  app.on("web-contents-created", (_e, contents) => {
    contents.on("did-finish-load", () => contents.setZoomFactor(prefs.uiScale()));
  });
  ipcMain.handle("amo:ui-scale-get", () => prefs.uiScale());
  ipcMain.handle("amo:ui-scale-set", (_event, scale: unknown) => {
    if (uiScaleOk(scale)) setUiScale(scale);
  });
  /** Ctrl + = / - / 0 in a Studio page: one step bigger, smaller, back to 100%. */
  const stepUiScale = (dir: 1 | -1 | 0) => {
    const cur = UI_SCALES.findIndex((s) => Math.abs(s - prefs.uiScale()) < 0.001);
    const next = dir === 0 ? 1 : UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, cur + dir))]!;
    if (Math.abs(next - prefs.uiScale()) > 0.001) setUiScale(next);
  };
  stepUiScaleRef = stepUiScale;
  ipcMain.handle("amo:focus-get", () => focusWindow !== null);
  ipcMain.handle("amo:focus-set", (_event, on: unknown) => setFocusVisible(on === true));
  // Only the Focus window may set its own shape and click-through.
  ipcMain.on("amo:focus-shape", (event, rects: unknown) => {
    if (!focusWindow || event.sender !== focusWindow.webContents || !Array.isArray(rects)) return;
    const ok = rects
      .slice(0, 8)
      .filter((r): r is { x: number; y: number; width: number; height: number } => !!r && ["x", "y", "width", "height"].every((k) => Number.isFinite((r as Record<string, unknown>)[k])))
      .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }));
    if (!ok.length) return;
    // The page reports its own (zoomed) CSS pixels; the window's shape is in screen points.
    const z = focusWindow.webContents.getZoomFactor() || 1;
    focusWindow.setShape(z === 1 ? ok : ok.map((r) => ({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.max(1, Math.round(r.width * z)), height: Math.max(1, Math.round(r.height * z)) })));
    trace?.note("focus", "focus-shape", ok.map((r) => `${r.width}×${r.height}@${r.x},${r.y}`).join(" ") + (z === 1 ? "" : ` zoom=${z}`));
    if (testMode) (globalThis as { __amoFocusShape?: unknown }).__amoFocusShape = ok;
  });
  ipcMain.on("amo:focus-pointer", (event) => pagePressed(event.sender));
  // Focus sends its robot flying, or calls it back; the robot's own page asks what to say and says it was caught.
  ipcMain.on("amo:bot-fly", (event, message: unknown) => {
    if (focusWindow && event.sender === focusWindow.webContents && typeof message === "string") bot.fly(message.slice(0, 120), focusWindow.getBounds());
  });
  ipcMain.on("amo:bot-land", (event) => {
    if (focusWindow && event.sender === focusWindow.webContents) bot.land();
  });
  ipcMain.handle("amo:bot-message", () => bot.message());
  ipcMain.on("amo:bot-shape", (event, rects: unknown) => {
    if (Array.isArray(rects)) bot.setShape(event.sender, rects as Array<{ x: number; y: number; width: number; height: number }>);
  });
  ipcMain.on("amo:bot-caught", (event) => bot.caught(event.sender));
  ipcMain.on("amo:focus-mouse", (event, ignore: unknown) => {
    if (!focusWindow || event.sender !== focusWindow.webContents) return;
    // Only changes reach Windows (2026-10-20): ignoring with `forward` installs a system-wide mouse hook that runs on
    // this thread, so every desktop mouse event waits on it; re-setting it on each pointerover churned it needlessly.
    if (focusMouseSet.get(event.sender) === (ignore === true)) return;
    focusMouseSet.set(event.sender, ignore === true);
    if (ignore === true !== focusIgnoring) trace?.note("focus", ignore === true ? "ignore-mouse on" : "ignore-mouse off");
    focusIgnoring = ignore === true;
    focusWindow.setIgnoreMouseEvents(ignore === true, { forward: true });
    if (testMode) (globalThis as { __amoFocusIgnore?: boolean }).__amoFocusIgnore = ignore === true;
  });
  // 移动位置 (10-22): while it lasts, Focus may activate. A press on a window that cannot activate may come with
  // WM_MOUSEACTIVATE, which Chromium answers by dropping the press (focus-clicks.ts); a click is given back, a drag is
  // not, and in some runs that was every press, so Focus could not be moved at all. Activatable, the press starts
  // Windows' own move. Done: it never takes focus again, hands it on to the window below, and stays off the taskbar.
  ipcMain.on("amo:focus-moving", (event, on: unknown) => {
    if (!focusWindow || event.sender !== focusWindow.webContents) return;
    focusWindow.setFocusable(on === true);
    focusWindow.setSkipTaskbar(true);
    if (on !== true && focusWindow.isFocused()) focusWindow.blur();
    trace?.note("focus", on === true ? "moving on" : "moving off");
    if (testMode) (globalThis as { __amoFocusMoving?: boolean }).__amoFocusMoving = on === true;
  });
  // "在工作台打开" from Focus: the workbench shows that task and session (and comes forward, except in tests).
  ipcMain.handle("amo:open-in-workbench", (_event, target: unknown) => {
    const t = target as { taskId?: unknown; sessionId?: unknown; show?: unknown; passage?: unknown } | null;
    // No (or an empty) taskId opens the board: scheduler proposals, and topic sessions from Focus. `show`: only bring
    // the window forward, where it is (Focus's icon, 2026-10-15).
    if (!mainWindow) return;
    if (t?.show !== true) {
      const taskId = typeof t?.taskId === "string" ? t.taskId : "";
      const passage = taskId && typeof t?.sessionId === "string" ? passageOf(t.passage) : null;
      mainWindow.webContents.send("amo:navigate", { taskId, ...(taskId && typeof t?.sessionId === "string" ? { sessionId: t.sessionId } : {}), ...(passage ? { passage } : {}) });
    }
    if (testMode) {
      const g = globalThis as { __amoMainShown?: number };
      g.__amoMainShown = (g.__amoMainShown ?? 0) + 1;
      return;
    }
    bringForward(mainWindow);
  });
  // 主窗口回到屏幕中央 (Focus's menu, 2026-10-19): the workbench, at its size, in the middle of the display Focus is on
  // (where the person is looking), and in front — for a window dragged off every screen. Tests only record where.
  ipcMain.handle("amo:main-center", () => {
    if (!mainWindow) return;
    const all = displays();
    const display = focusWindow ? displayFor(focusWindow.getBounds(), all) : (all.find((d) => d.id === screen.getPrimaryDisplay().id) ?? all[0]);
    if (!display) return;
    const next = centreIn(mainWindow.isMaximized() || mainWindow.isMinimized() ? mainWindow.getNormalBounds() : mainWindow.getBounds(), display.workArea);
    trace?.note("main", "center", `${next.width}×${next.height}@${next.x},${next.y}`);
    if (testMode) {
      (globalThis as { __amoMainCentered?: unknown }).__amoMainCentered = { ...next, display: display.workArea };
      return;
    }
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setBounds(next);
    bringForward(mainWindow);
  });
  // Studio's own folder picker lists, makes and renames folders through these (folders.ts, 2026-10-25).
  installFolderIpc();
  // The system dialog, the picker's 用系统对话框… (and every picker before 2026-10-25). From 设置 → 项目与目录 → 默认路径
  // (2026-10-17) when set. Tests read what it would start at and pick for it.
  ipcMain.handle("amo:pick-directory", async (_e, start?: unknown) => {
    const defaultPath = typeof start === "string" && start.trim() && existsSync(start.trim()) ? start.trim() : undefined;
    if (testMode) {
      const g = globalThis as { __amoPickDirectory?: { started: Array<string | null>; answer: string | null } };
      g.__amoPickDirectory ??= { started: [], answer: null };
      g.__amoPickDirectory.started.push(defaultPath ?? null);
      return g.__amoPickDirectory.answer;
    }
    const options = { title: "选择工作区文件夹", properties: ["openDirectory" as const], ...(defaultPath ? { defaultPath } : {}) };
    // Not modal to the main window: when an Explorer extension hangs the dialog, Studio stays usable (2026-10-25).
    const result = await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  app
    .whenReady()
    .then(async () => {
      if (dataChoice.firstRun) {
        const chosen = await runSetup({ portableDir: portableDir!, configPath: dataChoice.configPath!, defaultDir: dataDir, preload: join(here, "preload.cjs"), icon: APP_ICON, testMode });
        // Start again with the saved choice (data dir, profile and lock all follow it). Tests just end here: a relaunched
        // process would escape the test harness.
        if (chosen && !testMode) app.relaunch();
        app.exit(0);
        return;
      }
      // Every window's resizes, with what its page saw (the main window flickered when dragged, 2026-10-15).
      trace = new ResizeTrace(dataDir, process.env.AMO_STUDIO_TRACE_RESIZE === "1" || (!testMode && process.env.AMO_STUDIO_TRACE_RESIZE !== "0"));
      trace.watchStalls();
      if (trace.on) {
        const nameOf = (w: BrowserWindow) => (w === mainWindow ? "main" : w === focusWindow ? "focus" : (new URL(w.webContents.getURL() || "about:blank").hash.slice(1).split("?")[0] || "window"));
        app.on("browser-window-created", (_e, w) => trace!.attach(w, () => nameOf(w)));
        ipcMain.on("amo:trace", (event, summary: unknown) => {
          const w = BrowserWindow.fromWebContents(event.sender);
          trace!.page(w ? nameOf(w) : "?", summary);
        });
      }
      // Throwaway profiles of earlier first-run setups (they cannot be removed while their process runs). Off the main
      // thread, and a file still held (EBUSY) no longer ends the start (2026-10-20).
      for (const name of safeList(tmpdir())) if (/^amo-studio-setup-\d+$/.test(name)) void rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => undefined);
      const link: HostLinkOptions = {
        dataDir,
        hostBin: join(studioRoot, "packages", "host", "dist", "bin.js"),
        uiDir: join(studioRoot, "packages", "ui", "dist"),
        ...(process.env.AMO_STUDIO_PORT !== undefined ? { port: Number(process.env.AMO_STUDIO_PORT) } : {}),
        attached: testMode,
      };
      host = await connectHost(link);
      // The Host crashed or was killed: start it again; the windows reconnect and say what happened.
      stopKeepAlive = keepHostAlive({
        link,
        current: () => host!,
        onRestarted: (conn) => {
          host = conn;
          for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("amo:host-restarted");
        },
        log: (line) => console.error(`[${new Date().toISOString()}] ${line}`),
        ...(process.env.AMO_STUDIO_KEEPALIVE_MS ? { intervalMs: Number(process.env.AMO_STUDIO_KEEPALIVE_MS) } : {}),
      });
      mainWindow = createMainWindow(host);
      mainWindow.on("closed", () => {
        mainWindow = null;
        // Focus, the review and the viewer windows live with the workbench window.
        focusWindow?.destroy();
        bot.destroy();
        reviews.closeAll();
        viewers.closeAll();
      });
      if (prefs.focus(!testMode)) setFocusVisible(true);
      // 便签 is a program of its own (packages/notes, 2026-10-23): started with Studio, brought up from the title bar.
      installNotesLink({ studioRoot, dataDir, host, testMode, log: (line) => console.error(`[${new Date().toISOString()}] ${line}`) });
      // The file marks window (文件标记).
      installMarksWindow({ url: process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`, preload: join(here, "preload.cjs"), icon: APP_ICON, testMode, mainWindow });
      if (!testMode) {
        // Displays unplugged, rearranged or rescaled: keep both windows reachable.
        const refit = () => {
          if (focusWindow) refitFocusWindow(focusWindow);
          if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
            const current = mainWindow.getBounds();
            const next = mainBounds(current, current);
            const moved = next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height;
            trace?.note("main", moved ? "display-refit-setBounds" : "display-refit");
            if (moved) mainWindow.setBounds(next);
          }
        };
        // Once a burst of display changes settles (docking, DPI, the taskbar moving send several at once).
        let refitTimer: ReturnType<typeof setTimeout> | undefined;
        const refitSoon = () => {
          clearTimeout(refitTimer);
          refitTimer = setTimeout(refit, 200);
        };
        screen.on("display-added", refitSoon);
        screen.on("display-removed", refitSoon);
        screen.on("display-metrics-changed", refitSoon);
      }
    })
    .catch((err: unknown) => {
      console.error("AMO Studio failed to start:", err);
      app.exit(1);
    });

  app.on("window-all-closed", () => app.quit());

  let quitting = false;
  app.on("before-quit", (event) => {
    // Quitting stops (in tests) or leaves the Host; it is not to be restarted.
    stopKeepAlive?.();
    // The Host is resident; only a Host this shell attached (tests) stops with the app.
    if (quitting || !host?.child || !testMode) return;
    event.preventDefault();
    quitting = true;
    void stopHost(host).finally(() => app.quit());
  });

  // A window's page process crashed (or ran out of memory): load it again; the Host and the sessions never stopped.
  // A page that keeps crashing is left alone after three tries in a minute.
  const crashes = new WeakMap<Electron.WebContents, number[]>();
  app.on("render-process-gone", (_event, contents, details) => {
    if (details.reason === "clean-exit" || contents.isDestroyed()) return;
    const now = Date.now();
    const recent = (crashes.get(contents) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    crashes.set(contents, recent);
    console.error(`[${new Date().toISOString()}] a window's page process stopped (${details.reason}, exit ${details.exitCode})${recent.length > 3 ? "; not reloading it again" : "; reloading"}`);
    if (recent.length <= 3) contents.reload();
  });
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function createMainWindow(conn: HostConnection): BrowserWindow {
  // No menu bar (File / Edit / View…): everything lives in the page. Reload and DevTools stay on their keys below.
  Menu.setApplicationMenu(null);
  // Remembered bounds, pulled back onto a display if that display is gone (tests always sit off-screen).
  const saved = testMode ? null : prefs.main();
  const bounds = testMode ? { width: 1440, height: 900 } : mainBounds(saved?.bounds ?? null, { width: 1440, height: 900 });
  const win = new BrowserWindow({
    ...bounds,
    // The smallest size: kept by the resize handler below, not by the window (2026-10-15 flicker; see there).
    ...(windowMinSize ? { minWidth: MAIN_MIN.width, minHeight: MAIN_MIN.height } : {}),
    title: "AMO Studio",
    icon: APP_ICON,
    // Before the page paints: the light (editorial) theme is the default.
    backgroundColor: "#efede8",
    // No system title bar: the page's top bar is the title bar and draws the window buttons in its own style
    // (AMO_STUDIO_NATIVE_FRAME=1 keeps the system's, to compare the resize flicker).
    ...(nativeFrame ? {} : { titleBarStyle: "hidden" as const }),
    // Test windows sit off-screen, out of the taskbar, and are shown without activation so they keep painting for
    // capturePage but never take focus (LOOP_RULES red line 7).
    show: false,
    ...(testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    paintWhenInitiallyHidden: true,
    // 置顶, as it was left (stage 14). The window never activates for it, so off-screen test windows stay harmless.
    alwaysOnTop: prefs.pinned(),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !testMode,
    },
  });
  // The smallest size (2026-10-15): growing the window by its corner, every other resize briefly set it to exactly its
  // minimum, 960×600 (the flicker; with the system title bar too), without any will-resize asking for it — the
  // window's own minimum constraint snapping it there. So the window has no minimum and a drag below it is refused here
  // instead. AMO_STUDIO_WINDOW_MIN=1 puts the window's own minimum back, to compare.
  if (!windowMinSize)
    win.on("will-resize", (event, next) => {
      if (next.width >= MAIN_MIN.width && next.height >= MAIN_MIN.height) return;
      event.preventDefault();
      trace?.note("main", `min-refused ${next.width}×${next.height}`);
    });
  win.on("maximize", () => win.webContents.send("amo:window-maximized", true));
  win.on("unmaximize", () => win.webContents.send("amo:window-maximized", false));
  // Without a menu, the usual keys: F5 / Ctrl+R reload, F12 / Ctrl+Shift+I DevTools.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if (key === "f5" || (input.control && !input.shift && key === "r")) {
      event.preventDefault();
      win.webContents.reload();
    } else if (key === "f12" || (input.control && input.shift && key === "i")) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    } else if (input.control && !input.alt && (key === "=" || key === "+" || key === "-" || key === "0")) {
      event.preventDefault();
      stepUiScaleRef(key === "0" ? 0 : key === "-" ? -1 : 1);
    }
  });
  // The workbench never opens other windows or navigates away from the Host / dev server origin.
  const allowedOrigin = new URL(process.env.AMO_STUDIO_DEV_URL ?? conn.url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  win.once("ready-to-show", () => {
    if (testMode) win.showInactive();
    else {
      if (saved?.maximized) win.maximize();
      win.show();
    }
  });
  if (!testMode) {
    // Where the window is, kept as it changes (2026-10-19): a Studio that is killed (a restart, the task manager) never
    // gets its close, so remembering only then lost every resize. Written once the window has been still a moment.
    let soon: NodeJS.Timeout | null = null;
    const remember = () => {
      if (soon) clearTimeout(soon);
      soon = null;
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      prefs.setMain({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    };
    const later = () => {
      if (soon) clearTimeout(soon);
      soon = setTimeout(remember, 500);
    };
    win.on("resize", later);
    win.on("move", later);
    win.on("maximize", later);
    win.on("unmaximize", later);
    win.on("close", remember);
  }
  void win.loadURL(process.env.AMO_STUDIO_DEV_URL ?? `${conn.url}/`);
  return win;
}

/** A bookmarked passage to flash in the workbench (书签, 2026-10-19), or null when the value is not one. */
function passageOf(v: unknown): { itemId: string; start: number; end: number; quote: string } | null {
  const p = v as { itemId?: unknown; start?: unknown; end?: unknown; quote?: unknown } | null;
  if (!p || typeof p.itemId !== "string" || typeof p.quote !== "string" || !Number.isInteger(p.start) || !Number.isInteger(p.end)) return null;
  return { itemId: p.itemId, start: p.start as number, end: p.end as number, quote: p.quote.slice(0, 8000) };
}
