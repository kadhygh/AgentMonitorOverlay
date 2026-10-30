import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, screen, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { amoLocalHome } from "@amo-studio/account";
import { badgedImage, TrayMenu, type MenuEntry } from "@amo-studio/traymenu";
import { RelayAttentionReader, trayLook, type RelayAttention, type TrayLook } from "./relay-attention.js";
import { startDetached, startEnv, type LaunchSpec } from "./launch.js";
import { Platform, type PlatformShell } from "./platform.js";
import { afterPid, forwardArgs, forwardTarget } from "./self-update.js";
import type { OpenResult, PlatformCalls, PlatformView } from "./view.js";
import { trayClickAction, trayMenu, type TrayAction, type TrayItem, type TrayState } from "./tray.js";

// AMO 平台 (plans/amo-lan-platform.md, step 2): a tray program that installs, updates and starts the AMO tools from the
// team server. One instance; the window is made when shown and destroyed when closed — the program stays in the tray
// with only its main process (user, 10-28). The page is packages/ui's platform.html, served on amo-platform://.
// Env:
//   AMO_HOME            %APPDATA%\AMO: account.json, platform.json, programs.json
//   AMO_LOCAL_HOME      the platform's folder (apps\<tool>\…) in place of the one it was unpacked to (self-update.ts:
//                       tests, and development, where it defaults to %LOCALAPPDATA%\AMO); also moves the Chromium profile
//   AMO_PLATFORM_UI_DIR the UI build (default packages/ui/dist)
//   AMO_PLATFORM_TEST=1 test mode (e2e): window off-screen and never focused, no tray, dialogs, starting with Windows,
//                       重启平台 and the entry's forwarding recorded instead of done
//   AMO_PLATFORM_TEST_EXE, AMO_PLATFORM_TEST_VERSION  test mode only: run as if packaged, as this program and version
//                       (the self-update tests; a real build is that from app.isPackaged and its package.json)
// Args: --channel test|stable  overrides the 更新通道 setting for this run (start-platform.cmd uses test)
//       --hidden               start in the tray only (how Windows starts it at login)
//       --after=<pid>          a restart or a forward (self-update.ts): wait for that platform to be gone first

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.AMO_PLATFORM_TEST === "1";
/** The running program for self-updates; null from the sources (development never updates itself). */
const selfExe = testMode ? process.env.AMO_PLATFORM_TEST_EXE || null : app.isPackaged ? process.execPath : null;
const uiDir = resolve(process.env.AMO_PLATFORM_UI_DIR ?? join(here, "..", "..", "ui", "dist"));
const ICON = [join(here, "..", "assets", "icon.png"), join(here, "..", "..", "app", "assets", "icon.png")].find((p) => existsSync(p)) ?? "";
const SCHEME = "amo-platform";
const PAGE = `${SCHEME}://app/platform.html`;
const startHidden = process.argv.includes("--hidden");
const VERSION = (() => {
  if (testMode && process.env.AMO_PLATFORM_TEST_VERSION) return process.env.AMO_PLATFORM_TEST_VERSION;
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

type TestGlobals = { __platformTrayLook?: () => TrayLook & { blinking: boolean }; __platformForward?: LaunchSpec; __platformPicks?: string[]; __platformOpened?: string[]; __platformExternal?: string[]; __platformCopied?: string; __platformOpenAtLogin?: boolean; __platformOpenAtLoginExe?: string | null; __platformRestart?: LaunchSpec; __platformTray?: () => string[]; __platformTrayClick?: (label: string) => void; __platformTrayIconClick?: () => void; __platformShow?: () => void };
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
  setOpenAtLogin(on, exe) {
    if (testMode) {
      g.__platformOpenAtLogin = on;
      g.__platformOpenAtLoginExe = exe;
      return;
    }
    // Packaged: the program the platform names (the entry, <root>\AMO Platform.exe, which forwards to a newer version
    // by itself); in development: electron with this package. The same registry value either way (named after the
    // AppUserModelID), so a new path replaces the old one.
    if (exe) app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ["--hidden"] });
    else app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"] });
  },
  // 环境: the official pages (environment.ts's list) in the system browser, and Claude Code's install command copied.
  async openExternal(url) {
    if (!/^https:\/\//.test(url)) return;
    if (testMode) {
      g.__platformExternal = [...(g.__platformExternal ?? []), url];
      return;
    }
    await shell.openExternal(url);
  },
  copyText(text) {
    if (testMode) {
      g.__platformCopied = text;
      return;
    }
    clipboard.writeText(text);
  },
};

/**
 * 重启平台: the installed platform starts on its own and this one quits. The single-instance lock is let go first, and
 * the new one (--after=<this pid>) waits until this process is gone, so it never finds itself the second instance or
 * shares the Chromium profile with a platform on its way out. Tests record what would start instead.
 */
async function restart(spec: LaunchSpec): Promise<void> {
  if (testMode) {
    g.__platformRestart = spec;
    return;
  }
  app.releaseSingleInstanceLock();
  try {
    await startDetached(spec);
  } catch (err) {
    // Not started: this one stays, as the only instance.
    app.requestSingleInstanceLock();
    throw err;
  }
  quit();
}

const platform = new Platform({ env: process.env, argv: process.argv, version: VERSION, testMode, shell: platformShell, selfExe, restart });

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
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111316" : "#fbfaf7",
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
  // Coming forward: what runs may have changed (a tool closed, Studio's sessions); the server only now and then.
  w.on("focus", () => void platform.refresh({ focus: true }));
  // Studio's card (2026-10-29: its Host's state, and whether 重启 Studio can be clicked): asked again every 10 s while the
  // window is shown — only the Host's /api/health, not the server or Windows' process list.
  const studioTimer = setInterval(() => {
    if (!w.isDestroyed() && w.isVisible() && !w.isMinimized()) void platform.refreshStudio().catch(() => undefined);
  }, 10_000);
  w.on("closed", () => clearInterval(studioTimer));
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

/** What waits in AMO 中转 started by the platform (relay-attention.ts: the file it writes), looked at every second. */
const relayReader = RelayAttentionReader.forEnv(process.env);
let relayNow: RelayAttention | null = null;

/** The tray's state: the platform's, and what waits in 中转. */
function trayState(): TrayState {
  return { ...platform.trayState(), relayCount: relayNow?.count ?? 0 };
}

/** The tray menu (tray.ts, 2026-10-29): every tool's items, one part each, not folded. */
function trayItems(): TrayItem[] {
  return trayMenu(trayState());
}

/** Runs what a tray item (or a click on the icon) stands for. */
function runTray(action: TrayAction): void {
  const said = (tool: string) => (r: OpenResult) => {
    // Studio without its data dir, a tool gone: the window, saying why.
    if (!r.ok) {
      showWindow();
      win?.webContents.send("platform:notice", { tool, ...r });
    }
  };
  switch (action.kind) {
    case "open":
      void platform.open(action.tool).then(said(action.tool));
      return;
    case "toggle-notes":
      void platform.toggleNotes().then(said("notes"));
      return;
    case "quit":
      void platform.close(action.tool).then(said(action.tool));
      return;
    case "restart-studio":
      void platform.restartStudio();
      return;
    case "show-platform":
      showWindow();
      return;
    case "set-click":
      void platform.setTrayClick(action.to);
      return;
    case "quit-platform":
      quit();
      return;
  }
}

/** The menu on a right-click (2026-10-29, the user: like 便签's, not Windows' own), made from the state as it is then;
 *  what a click on the icon does is in bold. */
const trayWindow = new TrayMenu({ label: "AMO 平台菜单", width: 236 });
function openTrayMenu(): void {
  const click = JSON.stringify(trayClickAction(trayState()));
  trayWindow.open(
    trayItems().map((i): MenuEntry => (i.kind === "separator" ? { kind: "rule" } : i.kind === "heading" ? { kind: "title", label: i.label } : { kind: "item", label: i.label, strong: JSON.stringify(i.action) === click, ...(i.kind === "radio" ? { checked: i.checked } : {}), run: () => runTray(i.action) })),
  );
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

// 中转's icon while something waits there (2026-10-29, the user: 「收起来的托盘则切成 relay 图标来闪，也显示信息数量」):
// with the count, blinking with the plain one while 中转's window is not looked at; the platform's own once nothing
// waits. assets/relay-16…32.png are 中转's tray PNGs (scripts/make-icons.mjs copies them here).
const relayPngs = (() => {
  const out = new Map<number, Buffer>();
  for (const size of [16, 20, 24, 32]) {
    const file = join(here, "..", "assets", `relay-${size}.png`);
    if (existsSync(file)) out.set(size, readFileSync(file));
  }
  return out;
})();
const images: { platform?: Electron.NativeImage; relay?: Electron.NativeImage; badged?: { count: number; image: Electron.NativeImage } } = {};
function relayImage(badge: boolean, count: number): Electron.NativeImage {
  if (!badge) {
    if (!images.relay) {
      const image = nativeImage.createEmpty();
      for (const [size, buffer] of relayPngs) image.addRepresentation({ scaleFactor: size / 16, buffer });
      images.relay = image.isEmpty() ? trayImage() : image;
    }
    return images.relay;
  }
  if (images.badged?.count !== count) images.badged = { count, image: badgedImage(relayPngs, count) };
  return images.badged.image;
}

let look: TrayLook = trayLook(null);
let blink: ReturnType<typeof setInterval> | null = null;
function showLook(next: TrayLook): void {
  if (JSON.stringify(next) === JSON.stringify(look)) return;
  look = next;
  if (blink) clearInterval(blink);
  blink = null;
  tray?.setToolTip(look.tooltip);
  if (look.icon === "platform") {
    tray?.setImage((images.platform ??= trayImage()));
    return;
  }
  let on = true;
  tray?.setImage(relayImage(true, look.count));
  if (look.blink) blink = setInterval(() => tray?.setImage(relayImage((on = !on), look.count)), 500);
}

function watchRelay(): void {
  setInterval(() => {
    relayNow = relayReader.read();
    showLook(trayLook(relayNow));
  }, 1000);
}

function createTray(): void {
  tray = new Tray((images.platform ??= trayImage()));
  tray.setToolTip("AMO 平台");
  // A click opens 便签 or Studio, as chosen in the menu (2026-10-29, the user), or 中转 while its icon shows; the
  // platform's window is in the menu.
  tray.on("click", () => runTray(trayClickAction(trayState())));
  tray.on("right-click", openTrayMenu);
}

function quit(): void {
  quitting = true;
  app.quit();
}

// ---- the page's calls

const CALLS = new Set<keyof PlatformCalls>(["login", "register", "serverInfo", "logout", "loadProfile", "saveProfile", "refresh", "install", "rollback", "uninstall", "open", "close", "setChannel", "setOpenAtLogin", "setTheme", "pickStudioDataDir", "openPath", "dismiss", "environment", "updateEnvironment", "openDownload", "copyInstallCommand", "updateSelf", "restartSelf", "dismissSelf", "restartStudio", "refreshStudio"]);

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
  platform.onChange((view: PlatformView) => {
    if (win && !win.isDestroyed()) win.webContents.send("platform:view", view);
    // 主题 (2026-10-29): the page leaves it to the system's colours (base.css), which this sets for every window here.
    if (nativeTheme.themeSource !== view.theme) nativeTheme.themeSource = view.theme;
  });
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  serveUi();
  wire();
  nativeTheme.themeSource = platform.view().theme;
  if (!testMode) createTray();
  watchRelay();
  if (testMode)
    Object.assign(g, {
      __platformTrayLook: () => ({ ...look, blinking: blink !== null }),
      __platformTray: () => trayItems().map((i) => (i.kind === "separator" ? "—" : i.kind === "heading" ? `# ${i.label}` : i.kind === "radio" ? `${i.checked ? "●" : "○"} ${i.label}` : i.label)),
      __platformTrayClick: (label: string) => {
        const item = trayItems().find((i) => (i.kind === "item" || i.kind === "radio") && i.label === label);
        if (item && (item.kind === "item" || item.kind === "radio")) runTray(item.action);
      },
      __platformTrayIconClick: () => runTray(trayClickAction(trayState())),
      __platformShow: showWindow,
    });
  if (!startHidden) showWindow();
  await platform.init();
}

/** A restart's new platform: until the old one (--after=<pid>) has exited, at most 15 s. */
async function waitForPrevious(): Promise<void> {
  const pid = afterPid(process.argv);
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const until = Date.now() + 15_000; alive() && Date.now() < until; ) await new Promise((r) => setTimeout(r, 100));
}

/** This run's own arguments: after the exe when packaged; after this script when run by electron (the tests add theirs before it). */
function ownArgs(): string[] {
  if (app.isPackaged) return process.argv.slice(1);
  const self = fileURLToPath(import.meta.url).toLowerCase();
  const i = process.argv.findIndex((a, n) => n > 0 && resolve(a).toLowerCase() === self);
  return process.argv.slice(i > 0 ? i + 1 : 2);
}

/**
 * The entry forwarding (self-update.ts): run as <root>\AMO Platform.exe while <root>\apps\platform\current is a newer
 * version, that one starts — with this run's arguments and --after=<this pid>, so it takes over once this process is
 * gone — and this one quits before making anything. Tests record it and go on.
 */
async function forwardToNewer(): Promise<boolean> {
  const place = platform.place;
  if (place.kind !== "outer") return false;
  const file = forwardTarget(place.root, place.exe, VERSION);
  if (!file) return false;
  const spec: LaunchSpec = { file, args: forwardArgs(ownArgs(), process.pid), cwd: dirname(file), env: startEnv(process.env) };
  if (testMode) {
    g.__platformForward = spec;
    return false;
  }
  try {
    await startDetached(spec);
    return true;
  } catch {
    // Not started: this one runs (and offers 打开那个).
    return false;
  }
}

void forwardToNewer().then(async (forwarded) => {
  if (forwarded) return app.exit(0);
  await waitForPrevious();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
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
});
