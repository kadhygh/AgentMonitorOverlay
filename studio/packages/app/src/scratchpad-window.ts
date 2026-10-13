import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { displays } from "./focus-window.js";
import type { Rect } from "./placement.js";
import { placeScratchpad, SCRATCHPAD_MIN } from "./scratchpad-placement.js";

// The scratchpad window (便签, stage 11, after old AMO's ScratchpadApp): a small frameless, always-on-top window that a
// global shortcut shows and hides. Made on first use and then only hidden, so it opens instantly and keeps its page.
// Its content lives in the Host; this file only owns the window, its place on screen and the shortcut.

/** What the shortcut in 设置 → 便签 is doing; `error` when the wanted key could not be registered. */
export interface ShortcutStatus {
  /** The shortcut in the Host settings ("" when turned off). */
  wanted: string;
  /** The shortcut registered now ("" for none); after a failure it can still be the previous one. */
  active: string;
  error: string | null;
}

export interface ScratchpadOptions {
  host: { url: string; token: string };
  /** The UI's address (the Host, or the dev server); the window loads it with #scratchpad. */
  url: string;
  preload: string;
  icon: string;
  testMode: boolean;
  dataDir: string;
  /** The window goes away with the workbench. */
  mainWindow: BrowserWindow;
}

interface Shortcuts {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Tests never register real global keys (they would take the person's keys away, and parallel runs would collide):
 * they record what would be registered, and `__amoTakenShortcuts` plays keys other programs hold.
 */
function testShortcuts(): Shortcuts {
  const g = globalThis as { __amoTakenShortcuts?: string[]; __amoScratchpadShortcut?: string };
  return {
    register(accelerator) {
      if (g.__amoTakenShortcuts?.includes(accelerator)) return false;
      g.__amoScratchpadShortcut = accelerator;
      return true;
    },
    unregister(accelerator) {
      if (g.__amoScratchpadShortcut === accelerator) g.__amoScratchpadShortcut = "";
    },
  };
}

/** Sets up the window's IPC and shortcut; call once, after the workbench window exists. */
export function installScratchpad(o: ScratchpadOptions): void {
  const prefsFile = join(o.dataDir, "scratchpad-window.json");
  const shortcuts: Shortcuts = o.testMode ? testShortcuts() : { register: (a, cb) => globalShortcut.register(a, cb), unregister: (a) => globalShortcut.unregister(a) };
  let win: BrowserWindow | null = null;
  let closing = false;
  let status: ShortcutStatus = { wanted: "", active: "", error: null };
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const savedBounds = (): Rect | null => {
    try {
      return existsSync(prefsFile) ? ((JSON.parse(readFileSync(prefsFile, "utf8")) as { bounds?: Rect }).bounds ?? null) : null;
    } catch {
      return null;
    }
  };
  const rememberBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      mkdirSync(dirname(prefsFile), { recursive: true });
      writeFileSync(prefsFile, JSON.stringify({ bounds: win.getNormalBounds() }, null, 2));
    }, 300);
  };

  function create(): BrowserWindow {
    const bounds = o.testMode ? { x: -32000, y: -32000, width: 480, height: 320 } : placeScratchpad(savedBounds(), screen.getCursorScreenPoint(), displays());
    const w = new BrowserWindow({
      ...bounds,
      minWidth: SCRATCHPAD_MIN.width,
      minHeight: SCRATCHPAD_MIN.height,
      title: "AMO 便签",
      icon: o.icon,
      frame: false,
      backgroundColor: "#efede8",
      alwaysOnTop: true,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      paintWhenInitiallyHidden: true,
      // Test windows sit off-screen and never take focus (LOOP_RULES red line 7).
      ...(o.testMode ? { focusable: false } : {}),
      webPreferences: { preload: o.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !o.testMode },
    });
    w.setAlwaysOnTop(true, "floating");
    const origin = new URL(o.url).origin;
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin !== origin) event.preventDefault();
    });
    w.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F12") {
        event.preventDefault();
        w.webContents.toggleDevTools();
      }
    });
    // Closing (Alt+F4) only hides it; it is destroyed with the workbench.
    w.on("close", (event) => {
      if (closing) return;
      event.preventDefault();
      w.hide();
    });
    if (!o.testMode) {
      w.on("moved", rememberBounds);
      w.on("resized", rememberBounds);
    }
    w.on("closed", () => (win = null));
    void w.loadURL(`${o.url}#scratchpad`);
    return w;
  }

  function show(): void {
    const fresh = !win;
    win ??= create();
    const w = win;
    // Displays may have changed while it was hidden: keep it reachable.
    if (!fresh && !o.testMode && !w.isVisible()) w.setBounds(placeScratchpad(w.getNormalBounds(), screen.getCursorScreenPoint(), displays()));
    const reveal = () => {
      if (o.testMode) w.showInactive();
      else {
        w.show();
        w.focus();
      }
    };
    if (fresh) w.once("ready-to-show", reveal);
    else reveal();
  }

  /** The shortcut: shows it (and brings it forward), or hides it when it is already in front. */
  function toggle(): void {
    if (win && win.isVisible() && (win.isFocused() || o.testMode)) win.hide();
    else show();
  }

  async function readWanted(): Promise<string | null> {
    try {
      const res = await fetch(`${o.host.url}/api/settings`, { headers: { authorization: `Bearer ${o.host.token}` } });
      if (!res.ok) return null;
      return ((await res.json()) as { scratchpadShortcut?: string }).scratchpadShortcut ?? "";
    } catch {
      return null;
    }
  }

  /** Registers the shortcut the Host settings name. A key another program holds leaves the previous one in place. */
  async function applyShortcut(): Promise<ShortcutStatus> {
    const wanted = await readWanted();
    if (wanted === null) return (status = { ...status, error: "读不到 Host 的设置，快捷键没有变" });
    const current = status.active;
    if (wanted === current) return (status = { wanted, active: current, error: null });
    if (!wanted) {
      if (current) shortcuts.unregister(current);
      return (status = { wanted, active: "", error: null });
    }
    let ok = false;
    try {
      ok = shortcuts.register(wanted, toggle);
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

  // One change at a time: a quick second change waits for the first.
  let applying: Promise<ShortcutStatus> = Promise.resolve(status);
  const apply = () => (applying = applying.then(applyShortcut, applyShortcut));

  ipcMain.handle("amo:scratchpad-open", () => show());
  ipcMain.on("amo:scratchpad-hide", (event) => {
    if (win && event.sender === win.webContents) win.hide();
  });
  ipcMain.handle("amo:scratchpad-shortcut-apply", () => apply());
  ipcMain.handle("amo:scratchpad-shortcut-status", () => applying.then(() => status));

  o.mainWindow.on("closed", () => {
    closing = true;
    win?.destroy();
  });
  app.on("before-quit", () => (closing = true));
  app.on("will-quit", () => {
    if (status.active) shortcuts.unregister(status.active);
  });
  // Tests press the shortcut through this.
  if (o.testMode) (globalThis as { __amoScratchpadToggle?: () => void }).__amoScratchpadToggle = toggle;
  void apply();
}
