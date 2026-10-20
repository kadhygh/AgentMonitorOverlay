import { BrowserWindow, screen, type Rectangle } from "electron";
import { fly, takeOff, type Flight } from "./bot-flight.js";
import { recoverLostClicks } from "./focus-window.js";

// The angry robot (2026-10-15 evening): when something has waited for the person too long, Focus's robot leaves the
// panel and flies about the screen in a window of its own, just big enough for it and its bubble, so the rest of the
// screen keeps working. A click on it lands it (Focus then opens what needs the person); so does dealing with it.
// Like Focus it never takes focus, and its clicks get the same lost-click recovery.
// 2026-10-16: it looked cut off while flying. Its shape (the part of the window Windows draws) was set while the window
// still sat off screen, in that place's pixels; on a screen with another scale the robot then outgrew it. The shape is
// now kept in DIPs and set again once the window is on the screen it flies over (and again a moment later, after
// Chromium has taken the new scale).

const BOT_W = 420;
const BOT_H = 160;
/** A move every 33 ms (it was 16): each one is a window move on the main thread, as long as the robot flies. */
const FRAME_MS = 33;

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
  /** The page's shape in DIPs, set again whenever the window may have changed screens. */
  let shape: Rectangle[] = [];
  let reshape: ReturnType<typeof setTimeout> | null = null;

  const applyShape = () => {
    if (!win || win.isDestroyed() || !shape.length) return;
    win.setShape(shape);
    if (options.testMode) (globalThis as { __amoBotShape?: unknown }).__amoBotShape = shape;
  };

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
    if (reshape) clearTimeout(reshape);
    timer = null;
    reshape = null;
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
          applyShape();
          w.showInactive();
          if (reshape) clearTimeout(reshape);
          reshape = setTimeout(applyShape, 120);
          let last = Date.now();
          timer = setInterval(() => {
            if (!win || win.isDestroyed() || !flight) return stop();
            const now = Date.now();
            // A stalled frame (the machine was busy, or asleep) does not become one long jump.
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            const before = [Math.round(flight.x), Math.round(flight.y)];
            flight = fly(flight, dt, size, area);
            const x = Math.round(flight.x);
            const y = Math.round(flight.y);
            if (x !== before[0] || y !== before[1]) win.setPosition(x, y);
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
      if (!ok.length) return;
      shape = ok.map((r) => ({ x: Math.floor(r.x * z), y: Math.floor(r.y * z), width: Math.max(1, Math.ceil(r.width * z) + 1), height: Math.max(1, Math.ceil(r.height * z) + 1) }));
      applyShape();
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
