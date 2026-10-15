import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectHost, keepHostAlive, stopHost, type HostConnection, type HostLinkOptions } from "./host-link.js";
import { createFocusWindow, mainBounds, refitFocusWindow, ShellPrefs } from "./focus-window.js";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveDataDir } from "./paths.js";
import { runSetup, SETUP_TEMP_PROFILE } from "./setup.js";
import { installScratchpad } from "./scratchpad-window.js";
import { setupReviewWindows } from "./review-window.js";
import { installMarksWindow } from "./marks-window.js";
import { setupViewerWindows } from "./viewer-window.js";

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

// Chromium's profile (localStorage, caches) and the single-instance lock live in userData. Without this it is the
// generic %APPDATA%\Electron, shared by every run: tests saw each other's remembered model, and a test run could
// collide with a Studio the person has open. Keep it with the data dir instead (set before the lock is taken).
// First run of the portable build: the data dir is not chosen yet, so the setup window gets a throwaway profile.
app.setPath("userData", dataChoice.firstRun ? SETUP_TEMP_PROFILE(tmpdir()) : join(dataDir, "electron"));

let host: HostConnection | null = null;
let stopKeepAlive: (() => void) | null = null;
let mainWindow: BrowserWindow | null = null;
let focusWindow: BrowserWindow | null = null;
const prefs = new ShellPrefs(dataDir);
const reviews = setupReviewWindows({ url: () => (host ? (process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`) : null), preload: join(here, "preload.cjs"), icon: APP_ICON, testMode });
const viewers = setupViewerWindows({ url: () => (host ? (process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`) : null), preload: join(here, "preload.cjs"), icon: APP_ICON, testMode });

/** Focus is on by default for people and off in tests unless a test turns it on. */
function setFocusVisible(on: boolean): void {
  prefs.setFocus(on);
  if (on && !focusWindow && host) {
    focusWindow = createFocusWindow({
      url: process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`,
      preload: join(here, "preload.cjs"),
      testMode,
      saved: prefs.focusPos(),
      onMoved: (pos) => prefs.setFocusPos(pos),
    });
    focusWindow.on("closed", () => (focusWindow = null));
  } else if (!on && focusWindow) {
    focusWindow.destroy();
    focusWindow = null;
  }
  mainWindow?.webContents.send("amo:focus-changed", on);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // A user launched Studio again: bring the existing window forward (never happens in tests).
    if (mainWindow && !testMode) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
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
    focusWindow.setShape(ok);
    if (testMode) (globalThis as { __amoFocusShape?: unknown }).__amoFocusShape = ok;
  });
  ipcMain.on("amo:focus-mouse", (event, ignore: unknown) => {
    if (!focusWindow || event.sender !== focusWindow.webContents) return;
    focusWindow.setIgnoreMouseEvents(ignore === true, { forward: true });
    if (testMode) (globalThis as { __amoFocusIgnore?: boolean }).__amoFocusIgnore = ignore === true;
  });
  // "在工作台打开" from Focus: the workbench shows that task and session (and comes forward, except in tests).
  ipcMain.handle("amo:open-in-workbench", (_event, target: unknown) => {
    const t = target as { taskId?: unknown; sessionId?: unknown } | null;
    // No (or an empty) taskId opens the board: scheduler proposals, and topic sessions from Focus.
    if (!mainWindow) return;
    const taskId = typeof t?.taskId === "string" ? t.taskId : "";
    mainWindow.webContents.send("amo:navigate", { taskId, ...(taskId && typeof t?.sessionId === "string" ? { sessionId: t.sessionId } : {}) });
    if (testMode) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  ipcMain.handle("amo:pick-directory", async () => {
    const options = { title: "选择工作区文件夹", properties: ["openDirectory" as const] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
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
      // Throwaway profiles of earlier first-run setups (they cannot be removed while their process runs).
      for (const name of safeList(tmpdir())) if (/^amo-studio-setup-\d+$/.test(name)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
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
        reviews.closeAll();
        viewers.closeAll();
      });
      if (prefs.focus(!testMode)) setFocusVisible(true);
      // The scratchpad window (便签) and its global shortcut.
      installScratchpad({ host, url: process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`, preload: join(here, "preload.cjs"), icon: APP_ICON, testMode, dataDir, mainWindow });
      // The file marks window (文件标记).
      installMarksWindow({ url: process.env.AMO_STUDIO_DEV_URL ?? `${host.url}/`, preload: join(here, "preload.cjs"), icon: APP_ICON, testMode, mainWindow });
      if (!testMode) {
        // Displays unplugged, rearranged or rescaled: keep both windows reachable.
        const refit = () => {
          if (focusWindow) refitFocusWindow(focusWindow);
          if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
            const current = mainWindow.getBounds();
            const next = mainBounds(current, current);
            if (next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height) mainWindow.setBounds(next);
          }
        };
        screen.on("display-added", refit);
        screen.on("display-removed", refit);
        screen.on("display-metrics-changed", refit);
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
    minWidth: 960,
    minHeight: 600,
    title: "AMO Studio",
    icon: APP_ICON,
    // Before the page paints: the light (editorial) theme is the default.
    backgroundColor: "#efede8",
    // No system title bar: the page's top bar is the title bar and draws the window buttons in its own style.
    titleBarStyle: "hidden",
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
  if (!testMode) win.on("close", () => prefs.setMain({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
  void win.loadURL(process.env.AMO_STUDIO_DEV_URL ?? `${conn.url}/`);
  return win;
}
