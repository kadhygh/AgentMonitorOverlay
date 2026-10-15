import { BrowserWindow, screen, type Rectangle } from "electron";
import { fly, takeOff, type Flight } from "./bot-flight.js";
import { recoverLostClicks } from "./focus-window.js";

// The angry robot (2026-10-15 evening): when something has waited for the person too long, Focus's robot leaves the
// panel and flies about the screen in a window of its own, just big enough for it and its bubble, so the rest of the
// screen keeps working. A click on it lands it (Focus then opens what needs the person); so does dealing with it.
// Like Focus it never takes focus, and its clicks get the same lost-click recovery.

const BOT_W = 420;
const BOT_H = 160;
const FRAME_MS = 16;

export interface BotFlightOptions {
  url(): string | null;
  preload: string;
  testMode: boolean;
  /** 界面大小: the page is zoomed like every Studio page, the window grows with it. */
  scale(): number;
  /** Clicked: tell Focus. */
  onCaught(): void;
  note(what: string): void;
}

export interface BotFlightControl {
  /** Takes off near `from` (Focus's window), or only changes what it says while flying. */
  fly(message: string, from: Rectangle | null): void;
  land(): void;
  /** The page's parts that take clicks (its own pixels, zoomed); the rest of the window lets clicks through. */
  setShape(sender: Electron.WebContents, rects: Array<{ x: number; y: number; width: number; height: number }>): void;
  /** What it says now (the page asks when it loads). */
  message(): string;
  caught(sender: Electron.WebContents): void;
  /** The workbench closed: the robot goes with it. */
  destroy(): void;
}

export function setupBotFlight(options: BotFlightOptions): BotFlightControl {
  let win: BrowserWindow | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let flight: Flight | null = null;
  let said = "";

  const record = () => {
    if (options.testMode) (globalThis as { __amoBotFlight?: unknown }).__amoBotFlight = { flying: timer !== null || (win?.isVisible() ?? false), message: said };
  };

  const open = (): BrowserWindow | null => {
    if (win && !win.isDestroyed()) return win;
    const url = options.url();
    if (!url) return null;
    const scale = options.scale();
    win = new BrowserWindow({
      x: -32000,
      y: -32000,
      width: Math.round(BOT_W * scale),
      height: Math.round(BOT_H * scale),
      title: "AMO 机器人",
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
      focusable: false,
      show: false,
      webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("closed", () => {
      win = null;
      stop();
    });
    recoverLostClicks(win, { testMode: options.testMode, note: (at) => options.note(`bot click given back at ${at.x},${at.y}`), testHook: "__amoBotClicks" });
    void win.loadURL(`${url.replace(/#.*$/, "")}#bot`);
    return win;
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    flight = null;
  };

  return {
    fly(message, from) {
      said = message;
      const w = open();
      if (!w) return;
      w.webContents.send("amo:bot-say", message);
      if (!w.isVisible()) {
        if (options.testMode) w.showInactive();
        else {
          const size = { width: w.getBounds().width, height: w.getBounds().height };
          const start = from ? { x: from.x + from.width - size.width, y: from.y + Math.max(0, from.height - 260) } : screen.getCursorScreenPoint();
          const area = screen.getDisplayNearestPoint({ x: start.x + size.width / 2, y: start.y + size.height / 2 }).workArea;
          flight = takeOff(start, size, area);
          w.setPosition(Math.round(flight.x), Math.round(flight.y));
          w.showInactive();
          let last = Date.now();
          timer = setInterval(() => {
            if (!win || win.isDestroyed() || !flight) return stop();
            const now = Date.now();
            // A stalled frame (the machine was busy, or asleep) does not become one long jump.
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            flight = fly(flight, dt, size, area);
            win.setPosition(Math.round(flight.x), Math.round(flight.y));
          }, FRAME_MS);
        }
        options.note(`bot flies: ${message}`);
      }
      record();
    },
    land() {
      stop();
      if (win && !win.isDestroyed() && win.isVisible()) {
        win.hide();
        options.note("bot lands");
      }
      record();
    },
    setShape(sender, rects) {
      if (!win || win.isDestroyed() || sender !== win.webContents) return;
      const z = sender.getZoomFactor() || 1;
      const ok = rects.slice(0, 4).filter((r) => [r.x, r.y, r.width, r.height].every(Number.isFinite));
      if (ok.length) win.setShape(ok.map((r) => ({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.max(1, Math.round(r.width * z)), height: Math.max(1, Math.round(r.height * z)) })));
    },
    message: () => said,
    caught(sender) {
      if (!win || sender !== win.webContents) return;
      this.land();
      options.onCaught();
    },
    destroy() {
      stop();
      win?.destroy();
      win = null;
    },
  };
}
