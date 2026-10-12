import { BrowserWindow, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The Focus window: a small frameless, transparent, always-on-top panel in a corner of the screen that answers one
// question, "what needs me right now". It never takes focus and lets clicks through everywhere except its panel.

export const FOCUS_W = 380;
export const FOCUS_H = 560;
const MARGIN = 12;

export interface FocusOptions {
  url: string;
  preload: string;
  testMode: boolean;
}

/** Bottom-right corner of the primary display's work area (S3-08 adds per-display placement and memory). */
function cornerPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - FOCUS_W - MARGIN, y: area.y + area.height - FOCUS_H - MARGIN };
}

export function createFocusWindow({ url, preload, testMode }: FocusOptions): BrowserWindow {
  const pos = testMode ? { x: -32000, y: -32000 } : cornerPosition();
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
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !testMode },
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
  void win.loadURL(`${url}#focus`);
  return win;
}

/** Shell preferences that belong to this machine's windows rather than to the Host (Focus on/off). */
export class ShellPrefs {
  private readonly file: string;
  private data: { focus?: boolean };

  constructor(dataDir: string) {
    this.file = join(dataDir, "shell-prefs.json");
    try {
      this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as { focus?: boolean }) : {};
    } catch {
      this.data = {};
    }
  }

  focus(defaultValue: boolean): boolean {
    return this.data.focus ?? defaultValue;
  }

  setFocus(on: boolean): void {
    this.data.focus = on;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
