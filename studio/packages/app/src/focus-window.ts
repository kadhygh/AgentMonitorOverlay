import { BrowserWindow, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { placeFocus, placeMain, refitFocus, type DisplayInfo, type Point, type Rect, type Size } from "./placement.js";

// The Focus window: a small frameless, transparent, always-on-top panel in a corner of the screen that answers one
// question, "what needs me right now". It never takes focus and lets clicks through everywhere except its panel.

export const FOCUS_W = 380;
export const FOCUS_H = 560;

export interface FocusOptions {
  url: string;
  preload: string;
  testMode: boolean;
  /** Where the person last left it, if anywhere. */
  saved: Point | null;
  onMoved(pos: Point): void;
}

export function displays(): DisplayInfo[] {
  return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, scaleFactor: d.scaleFactor }));
}

export function createFocusWindow({ url, preload, testMode, saved, onMoved }: FocusOptions): BrowserWindow {
  const pos = testMode ? { x: -32000, y: -32000 } : placeFocus(saved, { width: FOCUS_W, height: FOCUS_H }, displays(), screen.getPrimaryDisplay().id);
  const win = new BrowserWindow({
    ...pos,
    width: FOCUS_W,
    height: FOCUS_H,
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
  // Transparent areas let clicks through; the renderer turns this off while the pointer is over the panel.
  win.setIgnoreMouseEvents(true, { forward: true });
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  win.once("ready-to-show", () => win.showInactive());
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

  private save(patch: PrefsData): void {
    this.data = { ...this.data, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
