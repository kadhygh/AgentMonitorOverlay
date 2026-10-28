import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { amoLocalHome } from "@amo-studio/account";
import { Platform, type PlatformShell } from "./platform.js";
import type { PlatformCalls, PlatformView } from "./view.js";

// AMO 平台 (plans/amo-lan-platform.md, step 2): a tray program that installs, updates and starts the AMO tools from the
// team server. One instance; the window is made when shown and destroyed when closed — the program stays in the tray
// with only its main process (user, 10-28). The page is packages/ui's platform.html, served on amo-platform://.
// Env:
//   AMO_HOME            %APPDATA%\AMO: account.json, platform.json, programs.json
//   AMO_LOCAL_HOME      %LOCALAPPDATA%\AMO: apps\<tool>\…, and this program's Chromium profile
//   AMO_PLATFORM_UI_DIR the UI build (default packages/ui/dist)
//   AMO_PLATFORM_TEST=1 test mode (e2e): window off-screen and never focused, no tray, dialogs and starting with
//                       Windows recorded instead of done
// Args: --channel test|stable  overrides the 更新通道 setting for this run (start-platform.cmd uses test)
//       --hidden               start in the tray only (how Windows starts it at login)

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.AMO_PLATFORM_TEST === "1";
const uiDir = resolve(process.env.AMO_PLATFORM_UI_DIR ?? join(here, "..", "..", "ui", "dist"));
const ICON = [join(here, "..", "assets", "icon.png"), join(here, "..", "..", "app", "assets", "icon.png")].find((p) => existsSync(p)) ?? "";
const SCHEME = "amo-platform";
const PAGE = `${SCHEME}://app/platform.html`;
const startHidden = process.argv.includes("--hidden");
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// The Chromium profile and the single-instance lock: outside the program folder (constraint 2), in local app data.
app.setPath("userData", join(amoLocalHome(), "platform-profile"));
if (process.platform === "win32") app.setAppUserModelId("AMO.Platform");
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

type TestGlobals = { __platformPicks?: string[]; __platformOpened?: string[]; __platformOpenAtLogin?: boolean; __platformTray?: () => string[]; __platformTrayClick?: (label: string) => void; __platformShow?: () => void };
const g = globalThis as TestGlobals;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const platformShell: PlatformShell = {
  async pickFolder(title, start) {
    // Tests queue the folders "picked" (app.evaluate) instead of a real dialog.
    if (testMode) return g.__platformPicks?.shift() ?? null;
    const options = { title, properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">, ...(start ? { defaultPath: start } : {}) };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async openPath(path) {
    mkdirSync(path, { recursive: true });
    if (testMode) {
      g.__platformOpened = [...(g.__platformOpened ?? []), path];
      return;
    }
    await shell.openPath(path);
  },
  setOpenAtLogin(on) {
    if (testMode) {
      g.__platformOpenAtLogin = on;
      return;
    }
    // Packaged: the exe itself; in development: electron with this package.
    const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args });
  },
};

const platform = new Platform({ env: process.env, argv: process.argv, version: VERSION, testMode, shell: platformShell });

// ---- the window

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".wasm": "application/wasm" };

function serveUi(): void {
  protocol.handle(SCHEME, (req) => {
    const url = new URL(req.url);
    const file = normalize(join(uiDir, decodeURIComponent(url.pathname)));
    if (url.host === "app" && file.startsWith(uiDir + sep) && existsSync(file)) return new Response(readFileSync(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
    return new Response("not found", { status: 404 });
  });
}

function createWindow(): BrowserWindow {
  const size = { width: 960, height: 640 };
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = testMode ? { x: -32000, y: -32000, ...size } : { x: Math.round(area.x + (area.width - size.width) / 2), y: Math.round(area.y + (area.height - size.height) / 2), ...size };
  const w = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 480,
    title: "AMO 平台",
    ...(ICON ? { icon: ICON } : {}),
    // The page's top bar is the title bar and draws the window buttons (as AMO Studio and 中转).
    frame: false,
    backgroundColor: "#fbfaf7",
    show: false,
    ...(testMode ? { focusable: false, skipTaskbar: true } : {}),
    webPreferences: { preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: !testMode },
  });
  w.setMenu(null);
  w.once("ready-to-show", () => (testMode ? w.showInactive() : w.show()));
  // Closing destroys it; the program stays in the tray.
  w.on("closed", () => {
    if (win === w) win = null;
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${SCHEME}://`)) e.preventDefault();
  });
  w.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      event.preventDefault();
      w.webContents.toggleDevTools();
    }
  });
  // Coming forward: what runs may have changed (a tool closed, Studio's sessions).
  w.on("focus", () => void platform.refresh());
  void w.loadURL(PAGE);
  return w;
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    win = createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (testMode) win.showInactive();
  else {
    win.show();
    win.focus();
  }
}

// ---- the tray

function trayItems(): Array<{ label: string; click: () => void } | { type: "separator" }> {
  const tools = platform.installedTools();
  return [
    { label: "打开 AMO 平台", click: showWindow },
    ...(tools.length ? [{ type: "separator" as const }] : []),
    ...tools.map((t) => ({
      label: `打开 ${t.name}`,
      click: () =>
        void platform.open(t.id).then((r) => {
          // Studio without its data dir: the window, on the page where it is set.
          if (!r.ok) {
            showWindow();
            win?.webContents.send("platform:notice", { tool: t.id, ...r });
          }
        }),
    })),
    { type: "separator" },
    { label: "退出", click: quit },
  ];
}

function updateTray(): void {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayItems()));
}

/** The tray icon at each scale Windows may ask for: assets/icon-16…32.png (scripts/make-icons.mjs; 16–24 px are the
 *  simplified cut, 2026-10-28), else the window icon shrunk. */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [
    [16, 1],
    [20, 1.25],
    [24, 1.5],
    [32, 2],
  ] as const) {
    const file = join(here, "..", "assets", `icon-${size}.png`);
    if (existsSync(file)) image.addRepresentation({ scaleFactor, buffer: readFileSync(file) });
  }
  if (!image.isEmpty()) return image;
  return ICON ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip("AMO 平台");
  tray.on("click", showWindow);
  updateTray();
}

function quit(): void {
  quitting = true;
  app.quit();
}

// ---- the page's calls

const CALLS = new Set<keyof PlatformCalls>(["login", "logout", "refresh", "install", "rollback", "uninstall", "open", "setChannel", "setOpenAtLogin", "pickStudioDataDir", "openPath", "dismiss"]);

function wire(): void {
  ipcMain.handle("platform:view", () => platform.view());
  ipcMain.handle("platform:call", async (_event, method: unknown, args: unknown) => {
    if (typeof method !== "string" || !CALLS.has(method as keyof PlatformCalls)) throw new Error(`unknown call ${String(method)}`);
    const fn = platform[method as keyof PlatformCalls] as (...a: unknown[]) => Promise<unknown>;
    return fn.apply(platform, Array.isArray(args) ? args : []);
  });
  ipcMain.on("platform:window", (event, action: unknown) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    if (action === "minimize") w.minimize();
    else if (action === "close") w.close();
  });
  let lastTools = "";
  platform.onChange((view: PlatformView) => {
    if (win && !win.isDestroyed()) win.webContents.send("platform:view", view);
    // The tray's 打开 items follow what is installed.
    const tools = view.tools.filter((t) => t.installed).map((t) => t.id).join(",");
    if (tools !== lastTools) {
      lastTools = tools;
      updateTray();
    }
  });
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  serveUi();
  wire();
  if (!testMode) createTray();
  if (testMode)
    Object.assign(g, {
      __platformTray: () => trayItems().map((i) => ("label" in i ? i.label : "—")),
      __platformTrayClick: (label: string) => {
        const item = trayItems().find((i) => "label" in i && i.label === label);
        if (item && "click" in item) item.click();
      },
      __platformShow: showWindow,
    });
  if (!startHidden) showWindow();
  await platform.init();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!argv.includes("--hidden")) showWindow();
  });
  // Every window closed is not the end: it lives in the tray.
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  void app.whenReady().then(start);
}
