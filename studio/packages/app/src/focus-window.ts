import { BrowserWindow, screen, type WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CaptionDrag, EatenClicks } from "./focus-clicks.js";
import { HTCAPTION, HTCLIENT, onWindowMessage, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE } from "./window-messages.js";
import { displayFor, placeFocus, placeMain, refitFocus, resizeFocus, type DisplayInfo, type Point, type Rect, type Size } from "./placement.js";

// The Focus window: a small frameless, transparent, always-on-top panel in a corner of the screen that answers one
// question, "what needs me right now". It never takes focus. The window's shape is only what the page draws (panel,
// robot, settings — the page reports them); clicks anywhere else go to the windows below (2026-10-15: before, the
// whole window ignored the mouse until the page saw the pointer enter, which the title row's drag area never let it).

export const FOCUS_W = 380;
export const FOCUS_H = 560;
/** 拖拽调整大小 (2026-11-06): the least size Focus can be dragged to, at 界面大小 100%. */
export const FOCUS_MIN = { width: 300, height: 200 } as const;

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
  /** The size the person dragged it to (at 界面大小 100%), if they did. */
  base: Size | null;
  onMoved(pos: Point): void;
}

export function displays(): DisplayInfo[] {
  return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, scaleFactor: d.scaleFactor }));
}

export function createFocusWindow({ url, preload, testMode, scale, saved, base, onMoved }: FocusOptions): BrowserWindow {
  const size = focusSize(scale, base);
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

/** The Focus window's size at a 界面大小 (its page keeps the same layout, only bigger): the size dragged to, or the default. */
export function focusSize(scale: number, base: Size | null = null): Size {
  const b = base ?? { width: FOCUS_W, height: FOCUS_H };
  return { width: Math.round(Math.max(FOCUS_MIN.width, b.width) * scale), height: Math.round(Math.max(FOCUS_MIN.height, b.height) * scale) };
}

const roundRect = (r: { x: number; y: number; width: number; height: number }) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });

/** A new 界面大小 for an open Focus window: resized with its bottom edge where it was (the panel sits at the bottom). */
export function rescaleFocusWindow(win: BrowserWindow, scale: number, base: Size | null = null): void {
  const b = win.getBounds();
  const size = focusSize(scale, base);
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
  /** 界面大小 (2026-10-15): the zoom of every Studio page. */
  uiScale?: number;
  /** 拖拽调整大小 (2026-11-06): Focus's size, at 界面大小 100%. */
  focusSize?: Size;
  /** 崩溃转储 (2026-11-10, 设置 → 维护): on or off; absent, the platform's channel decides (@amo-studio/account). */
  crashDumps?: boolean;
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

  focusSize(): Size | null {
    const s = this.data.focusSize;
    return s && Number.isFinite(s.width) && Number.isFinite(s.height) ? s : null;
  }

  setFocusSize(size: Size): void {
    this.save({ focusSize: size });
  }

  main(): PrefsData["main"] | null {
    return this.data.main ?? null;
  }

  setMain(main: NonNullable<PrefsData["main"]>): void {
    this.save({ main });
  }

  uiScale(): number {
    return uiScaleOk(this.data.uiScale) ? this.data.uiScale : 1;
  }

  setUiScale(scale: number): void {
    this.save({ uiScale: scale });
  }

  /** null: not chosen, the channel decides. */
  crashDumps(): boolean | null {
    return typeof this.data.crashDumps === "boolean" ? this.data.crashDumps : null;
  }

  setCrashDumps(on: boolean | null): void {
    // undefined drops the key when written.
    this.save({ crashDumps: on ?? undefined });
  }

  private save(patch: PrefsData): void {
    this.data = { ...this.data, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

/** Each page's lost-click recovery, by its webContents: the page's pointerdowns reach it here. */
const lostClicks = new WeakMap<WebContents, EatenClicks>();

/** The page in `sender` saw a press (IPC amo:focus-pointer). */
export function pagePressed(sender: WebContents): void {
  lostClicks.get(sender)?.pagePressed();
}

/**
 * Gives back the clicks Chromium drops on a window that never activates (Focus, the flying robot; focus-clicks.ts):
 * a left press that came with WM_MOUSEACTIVATE and that the page did not see is clicked into the page where it was
 * pressed. `note` hears each one given back. Tests drive it through `globalThis[testHook]`.
 */
export function recoverLostClicks(win: BrowserWindow, { testMode, note, testHook = "__amoFocusClicks" }: { testMode: boolean; note(at: Point): void; testHook?: string }): EatenClicks {
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
  lostClicks.set(win.webContents, clicks);
  // Tests cannot make Windows send WM_MOUSEACTIVATE; they drive the recovery itself.
  if (testMode) (globalThis as Record<string, unknown>)[testHook] = { activated: (at: Point | null) => clicks.activated(at), released: () => clicks.released(), pointer };
  return clicks;
}

/**
 * Lets Focus activate (true) or never again (false): 移动位置 and a drag of the title row. Ending, focus goes on to the
 * window below and Focus stays off the taskbar (setFocusable shows it there).
 */
export function setFocusActivatable(win: BrowserWindow, on: boolean): void {
  if (win.isDestroyed()) return;
  win.setFocusable(on);
  win.setSkipTaskbar(true);
  if (!on && win.isFocused()) win.blur();
}

/**
 * Makes a drag of Focus's title row move it even when Chromium would drop the press (focus-clicks.ts, CaptionDrag).
 * `note` hears each drag let through and its end. Tests drive it through `globalThis.__amoFocusCaption`.
 */
export function letTitleDragsMove(win: BrowserWindow, { testMode, note }: { testMode: boolean; note(what: string): void }): CaptionDrag {
  const drag = new CaptionDrag({
    allow: (on) => {
      setFocusActivatable(win, on);
      note(on ? "title drag: may activate" : "title drag: done");
    },
    allowed: () => !win.isDestroyed() && win.isFocusable(),
  });
  onWindowMessage(win, WM_MOUSEACTIVATE, (_w, l) => {
    if (l.readUInt16LE(0) === HTCAPTION && l.readUInt16LE(2) === WM_LBUTTONDOWN) drag.pressed();
  });
  onWindowMessage(win, WM_ENTERSIZEMOVE, () => drag.entered());
  onWindowMessage(win, WM_EXITSIZEMOVE, () => drag.exited());
  // Tests cannot make Windows send these messages; they drive the drag itself.
  if (testMode) (globalThis as Record<string, unknown>).__amoFocusCaption = { pressed: () => drag.pressed(), entered: () => drag.entered(), exited: () => drag.exited() };
  return drag;
}

/**
 * 拖拽调整大小 (2026-11-06): Focus resized by the grip at its panel's top-left corner. The page says when a drag
 * starts, moves and ends; where to is read here from the pointer (screen points, as the window's bounds), so the page's
 * zoom and the window moving under the pointer do not matter. `done` hears the size at 界面大小 100% and the place.
 */
export function focusResizer(win: BrowserWindow, { testMode, scale, done }: { testMode: boolean; scale(): number; done(base: Size, at: Point): void }) {
  let drag: { start: Rect; from: Point; area: Rect } | null = null;
  const cursor = (): Point => (testMode && (globalThis as { __amoTestCursor?: Point }).__amoTestCursor) || screen.getCursorScreenPoint();
  return (phase: "start" | "move" | "end") => {
    if (win.isDestroyed()) return;
    if (phase === "start") {
      const start = win.getBounds();
      // Tests keep their windows off every screen: no work area to stay in there.
      const area = testMode ? { x: -1e6, y: -1e6, width: 2e6, height: 2e6 } : displayFor(start, displays()).workArea;
      drag = { start, from: cursor(), area };
      return;
    }
    if (!drag) return;
    const z = scale();
    const next = resizeFocus(drag.start, drag.from, cursor(), { width: Math.round(FOCUS_MIN.width * z), height: Math.round(FOCUS_MIN.height * z) }, drag.area);
    const b = win.getBounds();
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) win.setBounds(next);
    if (phase === "end") {
      drag = null;
      done({ width: Math.round(next.width / z), height: Math.round(next.height / z) }, { x: next.x, y: next.y });
    }
  };
}
