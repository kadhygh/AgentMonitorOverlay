import { BrowserWindow, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EatenClicks } from "./focus-clicks.js";
import { HTCLIENT, onWindowMessage, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE } from "./window-messages.js";
import { placeFocus, placeMain, refitFocus, type DisplayInfo, type Point, type Rect, type Size } from "./placement.js";

// The Focus window: a small frameless, transparent, always-on-top panel in a corner of the screen that answers one
// question, "what needs me right now". It never takes focus. The window's shape is only what the page draws (panel,
// robot, settings — the page reports them); clicks anywhere else go to the windows below (2026-10-15: before, the
// whole window ignored the mouse until the page saw the pointer enter, which the title row's drag area never let it).

export const FOCUS_W = 380;
export const FOCUS_H = 560;

/** 界面大小 (2026-10-15): the zoom of every Studio page. Chromium zooms by origin, so Focus is zoomed too. */
export const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.4] as const;
export function uiScaleOk(v: unknown): v is number {
  return typeof v === "number" && UI_SCALES.some((s) => Math.abs(s - v) < 0.001);
}

export interface FocusOptions {
  url: string;
  preload: string;
  testMode: boolean;
  /** 界面大小: the window grows with its zoomed page. */
  scale: number;
  /** Where the person last left it, if anywhere. */
  saved: Point | null;
  onMoved(pos: Point): void;
}

export function displays(): DisplayInfo[] {
  return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, scaleFactor: d.scaleFactor }));
}

export function createFocusWindow({ url, preload, testMode, scale, saved, onMoved }: FocusOptions): BrowserWindow {
  const size = focusSize(scale);
  const pos = testMode ? { x: -32000, y: -32000 } : placeFocus(saved, size, displays(), screen.getPrimaryDisplay().id);
  const win = new BrowserWindow({
    ...pos,
    ...size,
    title: "AMO Focus",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Clicking its buttons must not pull focus away from whatever the person is typing in.
    focusable: false,
    show: false,
    paintWhenInitiallyHidden: true,
    // Never throttled (stage 13): it is never focused, and its whole job is to change the moment something needs the
    // person. Its own work is a few small renders per Host event.
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "floating");
  // Until the page reports its parts: only a strip at the bottom, where the panel's head will be.
  win.setShape([{ x: 10, y: size.height - 60 * scale, width: size.width - 20 * scale, height: 50 * scale }].map(roundRect));
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  win.once("ready-to-show", () => win.showInactive());
  // A right-click on the title row (a drag area) would open the system window menu and never reach the page; the
  // page shows its own menu instead (S14-J).
  win.on("system-context-menu", (event, point) => {
    event.preventDefault();
    const b = win.getContentBounds();
    const z = win.webContents.getZoomFactor() || 1;
    win.webContents.send("amo:focus-context-menu", { x: Math.round((point.x - b.x) / z), y: Math.round((point.y - b.y) / z) });
  });
  if (!testMode) {
    // Dragged by its title row: remember where it was left.
    win.on("moved", () => {
      const [x = 0, y = 0] = win.getPosition();
      onMoved({ x, y });
    });
  }
  void win.loadURL(`${url}#focus`);
  return win;
}

/** The Focus window's size at a 界面大小: its page keeps the same layout, only bigger. */
export function focusSize(scale: number): Size {
  return { width: Math.round(FOCUS_W * scale), height: Math.round(FOCUS_H * scale) };
}

const roundRect = (r: { x: number; y: number; width: number; height: number }) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });

/** A new 界面大小 for an open Focus window: resized with its bottom edge where it was (the panel sits at the bottom). */
export function rescaleFocusWindow(win: BrowserWindow, scale: number): void {
  const b = win.getBounds();
  const size = focusSize(scale);
  win.setBounds({ x: b.x, y: b.y + b.height - size.height, ...size });
  refitFocusWindow(win);
}

/** Keeps a Focus window on screen when displays are unplugged, rearranged or rescaled. */
export function refitFocusWindow(win: BrowserWindow): void {
  const { x, y } = refitFocus(win.getBounds(), displays(), screen.getPrimaryDisplay().id);
  const [cx, cy] = win.getPosition();
  if (x !== cx || y !== cy) win.setPosition(x, y);
}

/** Bounds for the workbench window from what was remembered, pulled back on screen if needed. */
export function mainBounds(saved: Rect | null, defaultSize: Size): Rect {
  return placeMain(saved, defaultSize, displays(), screen.getPrimaryDisplay().id);
}

interface PrefsData {
  focus?: boolean;
  focusPos?: Point;
  main?: { bounds: Rect; maximized: boolean };
  /** 置顶 (stage 14): the workbench window stays above other windows. */
  pinned?: boolean;
  /** 界面大小 (2026-10-15): the zoom of every Studio page. */
  uiScale?: number;
}

/** Shell preferences that belong to this machine's windows rather than to the Host: Focus on/off and window places. */
export class ShellPrefs {
  private readonly file: string;
  private data: PrefsData;

  constructor(dataDir: string) {
    this.file = join(dataDir, "shell-prefs.json");
    try {
      this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as PrefsData) : {};
    } catch {
      this.data = {};
    }
  }

  focus(defaultValue: boolean): boolean {
    return this.data.focus ?? defaultValue;
  }

  setFocus(on: boolean): void {
    this.save({ focus: on });
  }

  focusPos(): Point | null {
    return this.data.focusPos ?? null;
  }

  setFocusPos(pos: Point): void {
    this.save({ focusPos: pos });
  }

  main(): PrefsData["main"] | null {
    return this.data.main ?? null;
  }

  setMain(main: NonNullable<PrefsData["main"]>): void {
    this.save({ main });
  }

  pinned(): boolean {
    return this.data.pinned ?? false;
  }

  setPinned(on: boolean): void {
    this.save({ pinned: on });
  }

  uiScale(): number {
    return uiScaleOk(this.data.uiScale) ? this.data.uiScale : 1;
  }

  setUiScale(scale: number): void {
    this.save({ uiScale: scale });
  }

  private save(patch: PrefsData): void {
    this.data = { ...this.data, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

/**
 * Gives back the clicks Chromium drops on Focus (focus-clicks.ts): a left press that came with WM_MOUSEACTIVATE and
 * that the page did not see is clicked into the page where it was pressed. `note` hears each one given back.
 */
export function recoverLostClicks(win: BrowserWindow, { testMode, note }: { testMode: boolean; note(at: Point): void }): EatenClicks {
  const clicks = new EatenClicks({
    replay: (at) => {
      if (win.isDestroyed()) return;
      const wc = win.webContents;
      wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
      wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
      note(at);
    },
  });
  // Where the pointer is in the window's content, in DIP (sendInputEvent's units; the page's zoom applies after).
  const pointer = (): Point => {
    const cursor = (testMode && (globalThis as { __amoTestCursor?: Point }).__amoTestCursor) || screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    return { x: Math.round(cursor.x - b.x), y: Math.round(cursor.y - b.y) };
  };
  onWindowMessage(win, WM_MOUSEACTIVATE, (_w, l) => {
    const hit = l.readUInt16LE(0);
    const message = l.readUInt16LE(2);
    clicks.activated(hit === HTCLIENT && message === WM_LBUTTONDOWN ? pointer() : null);
  });
  onWindowMessage(win, WM_LBUTTONUP, () => clicks.released());
  // Tests cannot make Windows send WM_MOUSEACTIVATE; they drive the recovery itself.
  if (testMode) (globalThis as { __amoFocusClicks?: { activated(at: Point | null): void; released(): void; pointer(): Point } }).__amoFocusClicks = { activated: (at) => clicks.activated(at), released: () => clicks.released(), pointer };
  return clicks;
}
