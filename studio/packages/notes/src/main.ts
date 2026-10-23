import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { centreAt, PAD_MIN, placePad, type Rect } from "./placement.js";
import { startNotesServer, type NotesServer, type NotesShell } from "./server.js";
import { NotesStore } from "./store.js";

// AMO 便签 (2026-10-23): the scratchpad as a program of its own, so restarting Studio never closes it. One instance
// (a second start shows the running one), a tray icon (显示便签 / 设置… / 退出便签), the global shortcut, and a small
// server for its windows and for Studio (running.json says where it is).
// Env:
//   AMO_NOTES_HOME     its home (default %APPDATA%\AMO Notes): settings.json, running.json, the default work folder
//   AMO_NOTES_UI_DIR   the UI build (default packages/ui/dist)
//   AMO_NOTES_TEST=1   test mode: windows off-screen and never focused, no tray, no real global shortcut
// Args: --hidden  start in the tray only (how Windows starts it at login)

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.AMO_NOTES_TEST === "1";
const home = resolve(process.env.AMO_NOTES_HOME ?? join(app.getPath("appData"), "AMO Notes"));
const uiDir = resolve(process.env.AMO_NOTES_UI_DIR ?? join(here, "..", "..", "ui", "dist"));
const ASSETS = join(here, "..", "assets");
/** The 便签's own mark (assets/, drawn from the window title's icon). */
const ICON = [join(ASSETS, "icon.png"), join(here, "..", "..", "app", "assets", "icon.png")].find((p) => existsSync(p));
const startHidden = process.argv.includes("--hidden");

// Chromium's profile and the single-instance lock live with its home, never in the shared %APPDATA%\Electron.
app.setPath("userData", join(home, "electron"));
// Its own taskbar group and login entry, also when it runs from AMO Studio.exe.
if (process.platform === "win32") app.setAppUserModelId("AMO.Notes");

interface ShortcutStatus {
  wanted: string;
  active: string;
  error: string | null;
}

/** Tests never take real global keys: they record what would be registered. */
const shortcuts = testMode
  ? (() => {
      const g = globalThis as { __notesTakenShortcuts?: string[]; __notesShortcut?: string };
      return {
        register(accelerator: string): boolean {
          if (g.__notesTakenShortcuts?.includes(accelerator)) return false;
          g.__notesShortcut = accelerator;
          return true;
        },
        unregister(accelerator: string): void {
          if (g.__notesShortcut === accelerator) g.__notesShortcut = "";
        },
      };
    })()
  : { register: (a: string, cb: () => void) => globalShortcut.register(a, cb), unregister: (a: string) => globalShortcut.unregister(a) };

let store: NotesStore;
let server: NotesServer | null = null;
let pad: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
/** The 便签 window has drawn its page: showing it is instant from then on. */
let padReady = false;
/** 便签启动中 (2026-10-23): a small bar where the window will appear, only while it is not ready yet. */
let splash: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The tray's menu (2026-10-23): a small window in AMO's look, not Windows' rounded one. Made once, then shown. */
let trayMenu: BrowserWindow | null = null;
const TRAY_MENU = { width: 184, height: 124 };
let quitting = false;
let status: ShortcutStatus = { wanted: "", active: "", error: null };
const preload = join(here, "preload.cjs");
const windowFile = () => join(home, "window.json");
const runningFile = () => join(home, "running.json");

function displays() {
  return screen.getAllDisplays().map((d) => ({ workArea: d.workArea }));
}

function savedBounds(): Rect | null {
  try {
    return existsSync(windowFile()) ? ((JSON.parse(readFileSync(windowFile(), "utf8")) as { bounds?: Rect }).bounds ?? null) : null;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function rememberBounds(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!pad || pad.isDestroyed()) return;
    writeFileSync(windowFile(), JSON.stringify({ bounds: pad.getNormalBounds() }, null, 2));
  }, 300);
}

/** The zoom in the settings (Studio's 界面大小), on every window of the program. */
function applyLook(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.setZoomFactor(store.settings().uiScale);
}

/** Keeps a window on its own pages: links never navigate it away, F12 opens the developer tools. */
function guard(w: BrowserWindow): void {
  w.webContents.on("did-finish-load", () => w.webContents.setZoomFactor(store.settings().uiScale));
  const origin = new URL(server!.url).origin;
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  w.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      event.preventDefault();
      w.webContents.toggleDevTools();
    }
  });
}

function createPad(): BrowserWindow {
  const bounds = testMode ? { x: -32000, y: -32000, width: 480, height: 320 } : placePad(savedBounds(), screen.getCursorScreenPoint(), displays());
  const w = new BrowserWindow({
    ...bounds,
    minWidth: PAD_MIN.width,
    minHeight: PAD_MIN.height,
    title: "AMO 便签",
    ...(ICON ? { icon: ICON } : {}),
    frame: false,
    backgroundColor: "#fbfaf7",
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    paintWhenInitiallyHidden: true,
    ...(testMode ? { focusable: false } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !testMode },
  });
  w.setAlwaysOnTop(true, "floating");
  guard(w);
  // Closing (Alt+F4) only hides it; 退出便签 in the tray ends the program.
  w.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    w.hide();
  });
  if (!testMode) {
    w.on("moved", rememberBounds);
    w.on("resized", rememberBounds);
  }
  w.once("ready-to-show", () => (padReady = true));
  w.on("closed", () => {
    pad = null;
    padReady = false;
  });
  void w.loadURL(`${server!.url}/notes.html#scratchpad`);
  return w;
}

const SPLASH = { width: 240, height: 60 };
const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;user-select:none;cursor:progress}
body{box-sizing:border-box;border:1px solid #2a2723;background:#fbfaf7;color:#22201c;font:13px "Microsoft YaHei UI","Noto Sans SC",sans-serif;display:flex;flex-direction:column;justify-content:center;gap:9px;padding:0 16px}
.t{display:flex;align-items:center;gap:6px}
.track{height:3px;border-radius:2px;background:#e7e3db;overflow:hidden}
.bar{height:100%;width:40%;border-radius:2px;background:#93570a;animation:m 1.1s ease-in-out infinite}
@keyframes m{from{transform:translateX(-100%)}to{transform:translateX(260%)}}
</style></head><body><div class="t"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#23436f" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M3 2.5h10a.5.5 0 0 1 .5.5v6.3L9.3 13.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"/><path d="M13.5 9.3H10a.7.7 0 0 0-.7.7v3.5M5 5.5h6M5 8h3.5"/></svg>便签启动中…</div><div class="track"><div class="bar"></div></div></body></html>`;

/** The bar in the middle of where the 便签 window will appear; never takes focus. */
function openSplash(): void {
  if (splash) return;
  const at = placePad(savedBounds(), screen.getCursorScreenPoint(), displays());
  const bounds = testMode ? { x: -32000, y: -32000, ...SPLASH } : { x: Math.round(at.x + (at.width - SPLASH.width) / 2), y: Math.round(at.y + (at.height - SPLASH.height) / 2), ...SPLASH };
  const w = new BrowserWindow({
    ...bounds,
    title: "便签启动中",
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: "#fbfaf7",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  w.setAlwaysOnTop(true, "floating");
  w.once("ready-to-show", () => {
    if (!w.isDestroyed()) w.showInactive();
  });
  w.on("closed", () => {
    if (splash === w) splash = null;
  });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  splash = w;
  if (testMode) (globalThis as { __notesSplashes?: number }).__notesSplashes = ((globalThis as { __notesSplashes?: number }).__notesSplashes ?? 0) + 1;
  // It never outstays a start that went wrong.
  setTimeout(closeSplash, 20_000);
}

function closeSplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

function showPad(): void {
  pad ??= createPad();
  const w = pad;
  if (padReady && !testMode && !w.isVisible()) w.setBounds(placePad(w.getNormalBounds(), screen.getCursorScreenPoint(), displays()));
  const reveal = () => {
    closeSplash();
    if (testMode) w.showInactive();
    else {
      w.show();
      w.focus();
    }
  };
  // Instant once its page is drawn; until then (the first moments after starting) the bar says it is coming.
  if (padReady) reveal();
  else {
    openSplash();
    w.once("ready-to-show", reveal);
  }
}

/** The shortcut and a click on the tray icon: shows it, or hides it when it is in front already. */
function togglePad(): void {
  if (pad && pad.isVisible() && (pad.isFocused() || testMode)) pad.hide();
  else showPad();
}

function openSettings(): void {
  if (settingsWin) {
    if (testMode) settingsWin.showInactive();
    else {
      settingsWin.show();
      settingsWin.focus();
    }
    return;
  }
  const size = { width: 600, height: 760 };
  const bounds = testMode ? { x: -32000, y: -32000, ...size } : centreAt(size, screen.getCursorScreenPoint(), displays());
  const w = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 420,
    title: "便签设置",
    ...(ICON ? { icon: ICON } : {}),
    frame: false,
    backgroundColor: "#fbfaf7",
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    ...(testMode ? { focusable: false } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guard(w);
  w.on("closed", () => (settingsWin = null));
  w.once("ready-to-show", () => (testMode ? w.showInactive() : w.show()));
  void w.loadURL(`${server!.url}/notes.html#notes-settings`);
  settingsWin = w;
}

/** Registers the shortcut in the settings; a key another program holds leaves the previous one in place. */
function applyShortcut(): ShortcutStatus {
  const wanted = store.settings().shortcut;
  const current = status.active;
  if (wanted === current) return (status = { wanted, active: current, error: null });
  if (!wanted) {
    if (current) shortcuts.unregister(current);
    return (status = { wanted, active: "", error: null });
  }
  let ok = false;
  try {
    ok = shortcuts.register(wanted, togglePad);
  } catch {
    ok = false;
  }
  if (!ok) {
    const error = current ? `「${wanted}」被其他程序占用了，仍在用「${current}」` : `「${wanted}」被其他程序占用了，请换一个`;
    return (status = { wanted, active: current, error });
  }
  if (current) shortcuts.unregister(current);
  return (status = { wanted, active: wanted, error: null });
}

/** Starts with Windows (in the tray only) or not. */
function setOpenAtLogin(on: boolean): void {
  if (testMode) {
    (globalThis as { __notesOpenAtLogin?: boolean }).__notesOpenAtLogin = on;
    return;
  }
  // Portable: AMO Notes.exe, or AMO Studio.exe told which program to run (--amo-app=notes, its launcher).
  const args = app.isPackaged ? [...process.argv.filter((a) => a.startsWith("--amo-app=")), "--hidden"] : [app.getAppPath(), "--hidden"];
  // Before its own name (AMO.Notes, 10-24) the entry was Electron's default one; that one goes when it starts this.
  const legacy = { name: "electron.app.Electron", path: process.execPath, args };
  if (process.platform === "win32" && app.getLoginItemSettings(legacy).openAtLogin) app.setLoginItemSettings({ ...legacy, openAtLogin: false });
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args });
}

function quit(): void {
  quitting = true;
  app.quit();
}

/** The tray icon at each scale Windows may ask for. */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [
    [16, 1],
    [20, 1.25],
    [24, 1.5],
    [32, 2],
  ] as const) {
    const file = join(ASSETS, `icon-${size}.png`);
    if (existsSync(file)) image.addRepresentation({ scaleFactor, buffer: readFileSync(file) });
  }
  return image.isEmpty() && ICON ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : image;
}

function createTrayMenu(): BrowserWindow {
  const w = new BrowserWindow({
    ...TRAY_MENU,
    x: -32000,
    y: -32000,
    title: "便签菜单",
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#fbfaf7",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setAlwaysOnTop(true, "pop-up-menu");
  guard(w);
  // Like a menu: gone as soon as something else is clicked.
  w.on("blur", () => w.hide());
  w.on("closed", () => (trayMenu = null));
  void w.loadURL(`${server!.url}/notes.html#notes-tray-menu`);
  return w;
}

/** Opens the menu above the pointer (the tray is at the screen's edge), kept on the display. */
function openTrayMenu(): void {
  trayMenu ??= createTrayMenu();
  const w = trayMenu;
  const zoom = store.settings().uiScale;
  const size = { width: Math.round(TRAY_MENU.width * zoom), height: Math.round(TRAY_MENU.height * zoom) };
  const at = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(at).workArea;
  const x = Math.min(Math.max(at.x - size.width, area.x), area.x + area.width - size.width);
  const y = at.y - size.height >= area.y ? at.y - size.height : Math.min(at.y, area.y + area.height - size.height);
  // Tests: off-screen and never focused, like every test window.
  if (testMode) {
    w.setBounds({ x: -32000, y: -32000, ...size });
    w.showInactive();
    return;
  }
  w.setBounds({ x, y, ...size });
  w.show();
  w.focus();
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip("AMO 便签");
  tray.on("click", togglePad);
  tray.on("right-click", openTrayMenu);
}

async function start(): Promise<void> {
  mkdirSync(home, { recursive: true });
  // No application menu: Alt+1…9 switch pages, and Alt must not wake a hidden menu.
  Menu.setApplicationMenu(null);
  // Started to be shown (not in the tray only): the bar right away, before anything else loads.
  if (!startHidden) openSplash();
  store = new NotesStore(home);
  const notesShell: NotesShell = {
    show: showPad,
    openSettings,
    applyShortcut,
    shortcutStatus: () => status,
    setOpenAtLogin,
    applyLook,
    openPath: async (p) => {
      mkdirSync(p, { recursive: true });
      if (testMode) {
        (globalThis as { __notesOpened?: string[] }).__notesOpened = [...((globalThis as { __notesOpened?: string[] }).__notesOpened ?? []), p];
        return;
      }
      await shell.openPath(p);
    },
  };
  server = await startNotesServer({ store, shell: notesShell, uiDir });
  writeFileSync(runningFile(), JSON.stringify({ url: server.url, token: server.token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));

  ipcMain.handle("amo:host", () => ({ url: server!.url, token: server!.token }));
  ipcMain.handle("amo:copy", (_event, text: string) => {
    // Tests run side by side: they record what would be copied instead of taking the person's clipboard.
    if (testMode) (globalThis as { __notesCopied?: string[] }).__notesCopied = [...((globalThis as { __notesCopied?: string[] }).__notesCopied ?? []), String(text)];
    else clipboard.writeText(String(text));
  });
  ipcMain.handle("amo:scratchpad-open", () => showPad());
  ipcMain.on("amo:scratchpad-hide", (event) => {
    if (pad && event.sender === pad.webContents) pad.hide();
  });
  ipcMain.handle("amo:scratchpad-shortcut-apply", () => applyShortcut());
  ipcMain.handle("amo:scratchpad-shortcut-status", () => status);
  ipcMain.handle("amo:notes-open-settings", () => openSettings());
  ipcMain.on("amo:notes-tray", (_event, action: unknown) => {
    trayMenu?.hide();
    if (action === "show") showPad();
    else if (action === "settings") openSettings();
    else if (action === "quit") quit();
  });
  ipcMain.on("amo:notes-close-settings", (event) => {
    if (settingsWin && event.sender === settingsWin.webContents) settingsWin.close();
  });
  ipcMain.handle("amo:notes-pick-folder", async (event, start?: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "选择工作文件夹", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">, ...(start ? { defaultPath: start } : {}) };
    const r = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  if (!testMode) {
    createTray();
    // Made now, out of sight, so the first right-click shows it at once.
    trayMenu = createTrayMenu();
  }
  applyShortcut();
  if (store.settings().openAtLogin) setOpenAtLogin(true);
  if (testMode) Object.assign(globalThis, { __notesToggle: togglePad, __notesOpenSettings: openSettings, __notesTrayMenu: openTrayMenu });
  if (!startHidden) showPad();
  // Started in the tray (with Windows, or by Studio): the window is made now, out of sight, so the first time it is
  // asked for it appears at once.
  else pad = createPad();
}

if (!app.requestSingleInstanceLock()) {
  // Another one runs: it shows its window (second-instance) and this one ends.
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!argv.includes("--hidden")) showPad();
  });
  // Every window closed is not the end: it lives in the tray.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    if (status.active) shortcuts.unregister(status.active);
    try {
      const running = JSON.parse(readFileSync(runningFile(), "utf8")) as { pid?: number };
      if (running.pid === process.pid) rmSync(runningFile(), { force: true });
    } catch {
      // nothing to clean
    }
    void server?.close();
  });
  void app.whenReady().then(start);
}
