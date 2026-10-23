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
const ICON = [join(here, "..", "assets", "icon.png"), join(here, "..", "..", "app", "assets", "icon.png")].find((p) => existsSync(p));
const startHidden = process.argv.includes("--hidden");

// Chromium's profile and the single-instance lock live with its home, never in the shared %APPDATA%\Electron.
app.setPath("userData", join(home, "electron"));

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
let tray: Tray | null = null;
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

/** Keeps a window on its own pages: links never navigate it away, F12 opens the developer tools. */
function guard(w: BrowserWindow): void {
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
  w.on("closed", () => (pad = null));
  void w.loadURL(`${server!.url}/#scratchpad`);
  return w;
}

function showPad(): void {
  const fresh = !pad;
  pad ??= createPad();
  const w = pad;
  if (!fresh && !testMode && !w.isVisible()) w.setBounds(placePad(w.getNormalBounds(), screen.getCursorScreenPoint(), displays()));
  const reveal = () => {
    if (testMode) w.showInactive();
    else {
      w.show();
      w.focus();
    }
  };
  if (fresh) w.once("ready-to-show", reveal);
  else reveal();
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
  void w.loadURL(`${server!.url}/#notes-settings`);
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
  const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args });
}

function quit(): void {
  quitting = true;
  app.quit();
}

function createTray(): void {
  const image = ICON ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("AMO 便签");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示便签", click: showPad },
      { label: "设置…", click: openSettings },
      { type: "separator" },
      { label: "退出便签", click: quit },
    ]),
  );
  tray.on("click", togglePad);
}

async function start(): Promise<void> {
  mkdirSync(home, { recursive: true });
  store = new NotesStore(home);
  const notesShell: NotesShell = {
    show: showPad,
    openSettings,
    applyShortcut,
    shortcutStatus: () => status,
    setOpenAtLogin,
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
  ipcMain.handle("amo:copy", (_event, text: string) => clipboard.writeText(String(text)));
  ipcMain.handle("amo:scratchpad-open", () => showPad());
  ipcMain.on("amo:scratchpad-hide", (event) => {
    if (pad && event.sender === pad.webContents) pad.hide();
  });
  ipcMain.handle("amo:scratchpad-shortcut-apply", () => applyShortcut());
  ipcMain.handle("amo:scratchpad-shortcut-status", () => status);
  ipcMain.handle("amo:notes-open-settings", () => openSettings());
  ipcMain.on("amo:notes-close-settings", (event) => {
    if (settingsWin && event.sender === settingsWin.webContents) settingsWin.close();
  });
  ipcMain.handle("amo:notes-pick-folder", async (event, start?: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "选择工作文件夹", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">, ...(start ? { defaultPath: start } : {}) };
    const r = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  if (!testMode) createTray();
  applyShortcut();
  if (store.settings().openAtLogin) setOpenAtLogin(true);
  if (testMode) Object.assign(globalThis, { __notesToggle: togglePad, __notesOpenSettings: openSettings });
  if (!startHidden) showPad();
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
