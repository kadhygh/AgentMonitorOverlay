import { app, type BrowserWindow } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

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
}

export class ResizeTrace {
  private readonly file: string;
  private readonly bursts = new Map<string, Burst>();

  constructor(dataDir: string, private readonly enabled: boolean) {
    const dir = join(dataDir, "logs");
    this.file = join(dir, "resize-trace.log");
    if (!enabled) return;
    mkdirSync(dir, { recursive: true });
    this.write(`--- start ${new Date().toISOString()} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome} · ${process.platform} ${process.getSystemVersion()}`);
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
    void app
      .getGPUInfo("basic")
      .then((info) => {
        const devices = (info as { gpuDevice?: Array<{ vendorId: number; deviceId: number; active: boolean; driverVersion?: string }> }).gpuDevice ?? [];
        this.write(`${stamp()} gpu devices: ${devices.map((d) => `${d.vendorId.toString(16)}:${d.deviceId.toString(16)}${d.active ? " active" : ""}${d.driverVersion ? ` driver ${d.driverVersion}` : ""}`).join("; ") || "none"}`);
      })
      .catch((err: unknown) => this.write(`${stamp()} gpu info failed: ${String(err)}`));
  }

  get on(): boolean {
    return this.enabled;
  }

  /** Watches one window's resizes under its name ("main", "focus", "review"…, asked when it happens). */
  attach(win: BrowserWindow, name: () => string): void {
    if (!this.enabled) return;
    win.on("will-resize", (_e, bounds, details) => this.event(win, name(), "will", bounds, (details as { edge?: string } | undefined)?.edge));
    win.on("resize", () => this.event(win, name(), "resize", win.getBounds()));
    win.on("maximize", () => this.note(name(), "maximize"));
    win.on("unmaximize", () => this.note(name(), "unmaximize"));
  }

  /** Something that may move or repaint a window, counted into any running burst (or logged alone). */
  note(window: string, what: string): void {
    if (!this.enabled) return;
    const running = [...this.bursts.values()];
    if (!running.length) {
      if (!what.startsWith("focus-shape")) this.write(`${stamp()} ${window} ${what}`);
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

  private event(win: BrowserWindow, name: string, kind: "will" | "resize", bounds: Electron.Rectangle, edge?: string): void {
    const now = performance.now();
    let b = this.bursts.get(name);
    if (!b) {
      b = { window: name, startedAt: now, last: now, willResize: 0, resize: 0, edges: new Set(), from: win.getBounds(), to: bounds, slowGaps: [], maxGap: 0, other: new Map(), timer: null };
      this.bursts.set(name, b);
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
      `${stamp()} ${name} burst ${ms}ms edges=${[...b.edges].join("/") || "?"} will-resize=${b.willResize} resize=${b.resize} (${rate}/s) maxGap=${Math.round(b.maxGap)}ms slowGaps=[${b.slowGaps.join(",")}] ${r(b.from)} → ${r(b.to)}${extra} other: ${other}`,
    );
  }

  private write(line: string): void {
    try {
      try {
        if (statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      } catch {
        // no file yet
      }
      appendFileSync(this.file, `${line}\n`);
    } catch {
      // tracing never breaks the app
    }
  }
}

const stamp = () => new Date().toISOString().slice(11, 23);
