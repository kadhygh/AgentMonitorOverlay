import { app, type BrowserWindow } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StallProfiler } from "./stall-profiler.js";
import { onWindowMessage } from "./window-messages.js";

// Resize trace (2026-10-15, the main window flickers again when dragged by its bottom-right corner): every window's
// resize events, grouped into bursts, plus what the page saw during each burst (frames, long frames and what ran in
// them), written to <data>/logs/resize-trace.log. On by default outside tests; AMO_STUDIO_TRACE_RESIZE=0 turns it off.

const MAX_BYTES = 4 * 1024 * 1024;
/** A drag pauses this long and the burst is written. */
const IDLE_MS = 700;

interface Burst {
  window: string;
  startedAt: number;
  last: number;
  willResize: number;
  resize: number;
  edges: Set<string>;
  from: Electron.Rectangle;
  to: Electron.Rectangle;
  /** Gaps between resize events over 50 ms (the main process stalled, or the drag paused). */
  slowGaps: number[];
  maxGap: number;
  /** Other main-process things that happened during the burst: setBounds from Studio, display changes, Focus shape. */
  other: Map<string, number>;
  timer: NodeJS.Timeout | null;
  /** Smallest window and content size seen at a resize event, and sudden shrinks (did the window itself hit 960×600?). */
  minWin: [number, number];
  minContent: [number, number];
  drops: string[];
  prev: [number, number];
  /** will-resize proposals smaller than the window by over 100 px (does Windows ask for the small size?). */
  willDrops: string[];
}

export class ResizeTrace {
  private readonly file: string;
  private readonly bursts = new Map<string, Burst>();

  constructor(dataDir: string, private readonly enabled: boolean) {
    const dir = join(dataDir, "logs");
    this.file = join(dir, "resize-trace.log");
    if (!enabled) return;
    mkdirSync(dir, { recursive: true });
    // What still waits when the process ends.
    process.once("exit", () => {
      try {
        if (this.queue.length) appendFileSync(this.file, this.queue.splice(0).join(""));
      } catch {
        // tracing never breaks the app
      }
    });
    this.write(`--- start ${new Date().toLocaleString("sv-SE")} (local times from here on) · Electron ${process.versions.electron} · Chrome ${process.versions.chrome} · ${process.platform} ${process.getSystemVersion()}`);
    // Software compositing makes resizing slow and flickery. Whether the GPU is used, again whenever that changes, and
    // why a GPU process went away (a crash falls back to software until the app restarts).
    let last = "";
    const gpu = () => {
      try {
        const s = app.getGPUFeatureStatus();
        const now = `gpu_compositing=${s.gpu_compositing} rasterization=${s.rasterization} 2d_canvas=${s["2d_canvas"]}`;
        if (now !== last) this.write(`${stamp()} gpu: ${now}${last ? ` (was ${last})` : ""}`);
        last = now;
      } catch {
        // not yet known
      }
    };
    gpu();
    setTimeout(gpu, 10_000).unref();
    setInterval(gpu, 60_000).unref();
    app.on("child-process-gone", (_e, d) => this.write(`${stamp()} child-process-gone type=${d.type} reason=${d.reason} exitCode=${d.exitCode}${d.name ? ` name=${d.name}` : ""}`));
    app.on("gpu-info-update", () => gpu());
    this.write(`${stamp()} switches: ignore-gpu-blocklist=${app.commandLine.hasSwitch("ignore-gpu-blocklist")} native-frame=${process.env.AMO_STUDIO_NATIVE_FRAME === "1"}`);
    // What chrome://gpu shows: why the GPU is or is not used (blocklist entries, workarounds), once it is known.
    setTimeout(() => {
      void app
        .getGPUInfo("complete")
        .then((info) => {
          const i = info as Record<string, unknown>;
          const pick = (k: string) => (i[k] === undefined ? undefined : i[k]);
          const aux = (i.auxAttributes ?? {}) as Record<string, unknown>;
          this.write(
            `${stamp()} gpu complete: ${JSON.stringify({
              devices: pick("gpuDevice"),
              aux: Object.fromEntries(Object.entries(aux).filter(([k]) => /software|inProcess|direct|overlay|vendor|device|driver|gl|d3d|dx|machine|sandbox|passthrough|skia/i.test(k))),
              blocklist: pick("blocklistReasons") ?? pick("blacklistReasons") ?? pick("disabledFeatures"),
              workarounds: pick("driverBugWorkarounds"),
              problems: pick("problems") ?? pick("featureStatusProblems"),
              keys: Object.keys(i),
            }).slice(0, 5000)}`,
          );
        })
        .catch((err: unknown) => this.write(`${stamp()} gpu complete failed: ${String(err)}`));
    }, 8_000).unref();
    void app
      .getGPUInfo("basic")
      .then((info) => {
        const devices = (info as { gpuDevice?: Array<{ vendorId: number; deviceId: number; active: boolean; driverVersion?: string }> }).gpuDevice ?? [];
        this.write(`${stamp()} gpu devices: ${devices.map((d) => `${d.vendorId.toString(16)}:${d.deviceId.toString(16)}${d.active ? " active" : ""}${d.driverVersion ? ` driver ${d.driverVersion}` : ""}`).join("; ") || "none"}`);
      })
      .catch((err: unknown) => this.write(`${stamp()} gpu info failed: ${String(err)}`));
  }

  /**
   * Stalls of this process's event loop, which freeze every window (2026-10-21, "it has felt slow these ten minutes"),
   * and whether accessibility is on. With AMO_STUDIO_TRACE_STALLS=1 a stall of a second or more also says what ran (JS
   * profile, Chromium trace): 2026-10-21's stalls of 1-3 s spent almost no CPU in this process.
   */
  watchStalls(): void {
    if (!this.enabled) return;
    const a11y = () => (app.isAccessibilitySupportEnabled() ? "on" : "off");
    this.write(`${stamp()} accessibility: ${a11y()} (pages: ${process.env.AMO_STUDIO_A11Y === "1" ? "on, AMO_STUDIO_A11Y=1" : "off"})`);
    app.on("accessibility-support-changed", (_e, on) => this.write(`${stamp()} accessibility: ${on ? "on" : "off"} (changed)`));
    const profiler = process.env.AMO_STUDIO_TRACE_STALLS === "1" ? new StallProfiler(dirname(this.file), (line) => this.write(line)) : null;
    profiler?.start();
    profiler?.startChromiumTrace();
    const TICK = 100;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const late = now - last - TICK;
      if (late >= 500) {
        const at = stamp();
        this.write(`${at} main process stalled ${Math.round(late)}ms (event loop)`);
        if (late >= 1000) profiler?.stalled(late, at);
      }
      last = now;
    }, TICK).unref();
  }

  get on(): boolean {
    return this.enabled;
  }

  /** Watches one window's resizes under its name ("main", "focus", "review"…, asked when it happens). */
  attach(win: BrowserWindow, name: () => string): void {
    if (!this.enabled) return;
    win.on("will-resize", (_e, bounds, details) => this.event(win, name(), "will", bounds, (details as { edge?: string } | undefined)?.edge));
    win.on("resize", () => this.event(win, name(), "resize", win.getBounds(), undefined, win.getContentBounds()));
    win.on("maximize", () => this.note(name(), "maximize"));
    win.on("unmaximize", () => this.note(name(), "unmaximize"));
    // 2026-10-15 (a flicker when a conversation started, with no resize behind it): page crashes, reloads and hangs.
    const wc = win.webContents;
    let loads = 0;
    wc.on("did-finish-load", () => {
      if (loads++ > 0) this.write(`${stamp()} ${name()} page loaded again (${loads})`);
    });
    wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => {
      if (isMainFrame) this.write(`${stamp()} ${name()} page failed to load: ${code} ${description}`);
    });
    wc.on("render-process-gone", (_e, d) => this.write(`${stamp()} ${name()} page process gone reason=${d.reason} exitCode=${d.exitCode}`));
    win.on("unresponsive", () => this.write(`${stamp()} ${name()} unresponsive`));
    win.on("responsive", () => this.write(`${stamp()} ${name()} responsive again`));
  }

  /**
   * The window's own mouse messages from Windows (2026-10-15: Focus's buttons ignore real clicks while a posted click
   * works). Clicks, activation and pointer messages; moves at most once every 2 seconds.
   */
  watchInput(win: BrowserWindow, name: string): void {
    if (!this.enabled || process.platform !== "win32") return;
    const xy = (l: Buffer) => `${l.readInt16LE(0)},${l.readInt16LE(2)}`;
    const MESSAGES: Array<[number, string, (w: Buffer, l: Buffer) => string]> = [
      [0x0021, "WM_MOUSEACTIVATE", (_w, l) => `hit=${l.readUInt16LE(0)} msg=0x${l.readUInt16LE(2).toString(16)}`],
      [0x00a1, "WM_NCLBUTTONDOWN", (w, l) => `hit=${w.readUInt32LE(0)} at ${xy(l)}`],
      [0x0201, "WM_LBUTTONDOWN", (_w, l) => `at ${xy(l)}`],
      [0x0202, "WM_LBUTTONUP", (_w, l) => `at ${xy(l)}`],
      [0x0204, "WM_RBUTTONDOWN", (_w, l) => `at ${xy(l)}`],
      [0x0215, "WM_CAPTURECHANGED", () => ""],
      [0x0246, "WM_POINTERDOWN", (_w, l) => `screen ${xy(l)}`],
      [0x0247, "WM_POINTERUP", (_w, l) => `screen ${xy(l)}`],
      [0x024b, "WM_POINTERACTIVATE", () => ""],
      [0x0200, "WM_MOUSEMOVE", (_w, l) => `at ${xy(l)}`],
    ];
    let lastMove = 0;
    for (const [msg, label, detail] of MESSAGES) {
      onWindowMessage(win, msg, (w: Buffer, l: Buffer) => {
        if (msg === 0x0200) {
          const now = Date.now();
          if (now - lastMove < 2000) return;
          lastMove = now;
        }
        let text = "";
        try {
          text = detail(w, l);
        } catch {
          // a short buffer
        }
        this.write(`${stamp()} ${name} ${label} ${text}`.trimEnd());
      });
    }
  }

  /** Something that may move or repaint a window, counted into any running burst (or logged alone, with its detail). */
  note(window: string, what: string, detail?: string): void {
    if (!this.enabled) return;
    const running = [...this.bursts.values()];
    if (!running.length) {
      this.write(`${stamp()} ${window} ${what}${detail ? ` ${detail}` : ""}`);
      return;
    }
    for (const b of running) b.other.set(`${window}:${what}`, (b.other.get(`${window}:${what}`) ?? 0) + 1);
  }

  /** The page's own summary of a burst (lib/resizeTrace.ts), as one line. */
  page(window: string, summary: unknown): void {
    if (!this.enabled) return;
    let text = "";
    try {
      text = JSON.stringify(summary).slice(0, 6000);
    } catch {
      text = String(summary);
    }
    this.write(`${stamp()} ${window} page ${text}`);
  }

  private event(win: BrowserWindow, name: string, kind: "will" | "resize", bounds: Electron.Rectangle, edge?: string, content?: Electron.Rectangle): void {
    const now = performance.now();
    let b = this.bursts.get(name);
    if (!b) {
      const start = win.getBounds();
      b = { window: name, startedAt: now, last: now, willResize: 0, resize: 0, edges: new Set(), from: start, to: bounds, slowGaps: [], maxGap: 0, other: new Map(), timer: null, minWin: [start.width, start.height], minContent: [Infinity, Infinity], drops: [], prev: [start.width, start.height], willDrops: [] };
      this.bursts.set(name, b);
    }
    if (kind === "will" && (b.prev[0] - bounds.width > 100 || b.prev[1] - bounds.height > 100) && b.willDrops.length < 10)
      b.willDrops.push(`+${Math.round(now - b.startedAt)}ms ${b.prev[0]}×${b.prev[1]}→${bounds.width}×${bounds.height}`);
    if (kind === "resize") {
      b.minWin = [Math.min(b.minWin[0], bounds.width), Math.min(b.minWin[1], bounds.height)];
      if (content) b.minContent = [Math.min(b.minContent[0], content.width), Math.min(b.minContent[1], content.height)];
      if ((b.prev[0] - bounds.width > 100 || b.prev[1] - bounds.height > 100) && b.drops.length < 10) b.drops.push(`+${Math.round(now - b.startedAt)}ms ${b.prev[0]}×${b.prev[1]}→${bounds.width}×${bounds.height}`);
      b.prev = [bounds.width, bounds.height];
    }
    const gap = now - b.last;
    if (kind === "resize" && b.resize > 0) {
      b.maxGap = Math.max(b.maxGap, gap);
      if (gap > 50 && b.slowGaps.length < 20) b.slowGaps.push(Math.round(gap));
    }
    b.last = now;
    if (kind === "will") b.willResize++;
    else b.resize++;
    if (edge) b.edges.add(edge);
    b.to = bounds;
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => this.flush(name, win), IDLE_MS);
  }

  private flush(name: string, win: BrowserWindow): void {
    const b = this.bursts.get(name);
    if (!b) return;
    this.bursts.delete(name);
    const ms = Math.round(b.last - b.startedAt);
    const rate = ms > 0 ? Math.round((b.resize * 1000) / ms) : 0;
    const other = [...b.other].map(([k, n]) => `${k}×${n}`).join(", ") || "none";
    const r = (x: Electron.Rectangle) => `${x.width}×${x.height}@${x.x},${x.y}`;
    let extra = "";
    try {
      extra = ` maximized=${win.isMaximized()} onTop=${win.isAlwaysOnTop()}`;
    } catch {
      // closed meanwhile
    }
    this.write(
      `${stamp()} ${name} burst ${ms}ms edges=${[...b.edges].join("/") || "?"} will-resize=${b.willResize} resize=${b.resize} (${rate}/s) maxGap=${Math.round(b.maxGap)}ms slowGaps=[${b.slowGaps.join(",")}] ${r(b.from)} → ${r(b.to)} min=${b.minWin.join("×")} minContent=${b.minContent.join("×")} drops=[${b.drops.join(", ")}] willDrops=[${b.willDrops.join(", ")}]${extra} other: ${other}`,
    );
  }

  /**
   * Lines wait in memory and go to the file together, off the main thread (2026-10-20: each line was a stat and an
   * append that held the main thread, and every window with it, as long as the disk took); what is left when the
   * process ends is written then.
   */
  private readonly queue: string[] = [];
  private flushing = false;

  private write(line: string): void {
    this.queue.push(`${line}\n`);
    if (!this.flushing) {
      this.flushing = true;
      setImmediate(() => void this.drain());
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const chunk = this.queue.splice(0).join("");
        try {
          if ((await stat(this.file)).size > MAX_BYTES) await rename(this.file, `${this.file}.1`);
        } catch {
          // no file yet
        }
        await appendFile(this.file, chunk);
      }
    } catch {
      // tracing never breaks the app
    } finally {
      this.flushing = false;
    }
  }
}

/** Local time of day with milliseconds (before 2026-10-15 evening the log used UTC). */
const stamp = () => {
  const d = new Date();
  return `${d.toLocaleTimeString("sv-SE")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
