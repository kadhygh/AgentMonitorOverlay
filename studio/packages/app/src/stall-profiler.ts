import { contentTracing } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";

// Stall profiler (2026-10-20: opening a big file in the viewer held the main process up for 22 s, and every window
// with it; it did not happen under tests). A sampling CPU profile of this process runs all the time, restarted every
// two minutes; when the event loop was held up, what ran during the hold-up is summed into the trace and the profile
// is kept as <data>/logs/main-stall-<time>.cpuprofile (open it in Chrome DevTools → Performance).

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

const SAMPLE_US = 5000;
const ROUND_MS = 120_000;

export class StallProfiler {
  private readonly session = new Session();
  private busy = false;

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    try {
      this.session.connect();
    } catch (err) {
      this.log(`stall profiler off: ${String(err)}`);
      return;
    }
    void this.post("Profiler.enable")
      .then(() => this.post("Profiler.setSamplingInterval", { interval: SAMPLE_US }))
      .then(() => this.post("Profiler.start"))
      .catch((err: unknown) => this.log(`stall profiler off: ${String(err)}`));
    // A fresh profile every round keeps it small; a stall keeps the one it happened in.
    setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.post("Profiler.stop")
        .then(() => this.post("Profiler.start"))
        .catch(() => undefined)
        .finally(() => (this.busy = false));
    }, ROUND_MS).unref();
  }

  /** The event loop was just held up for `lateMs`: what ran meanwhile, into the trace, and the profile kept. */
  stalled(lateMs: number, label: string): void {
    if (this.busy) return;
    this.busy = true;
    void this.chromiumTrace(lateMs, label);
    void this.post<{ profile: Profile }>("Profiler.stop")
      .then(({ profile }) => {
        const file = join(this.dir, `main-stall-${label.replace(/[:.]/g, "")}.cpuprofile`);
        try {
          writeFileSync(file, JSON.stringify(profile));
        } catch {
          // the summary still goes to the trace
        }
        this.log(`  during it: ${summarize(profile, lateMs)} · profile ${file}`);
      })
      .catch((err: unknown) => this.log(`  stall profile failed: ${String(err)}`))
      .then(() => this.post("Profiler.start"))
      .catch(() => undefined)
      .finally(() => (this.busy = false));
  }

  /**
   * 2026-10-20 (the 20 s hold-up was "(idle)" to the JS profiler: the main thread was in Chromium's own code): a
   * Chromium trace kept in a ring buffer all the time; on a stall it is saved, and its longest main-process tasks named.
   */
  startChromiumTrace(): void {
    void contentTracing
      .startRecording({
        included_categories: ["toplevel", "ui", "views", "gpu", "viz", "ipc", "mojom", "browser", "navigation", "loading", "disabled-by-default-toplevel.flow"],
        recording_mode: "record-continuously",
        trace_buffer_size_in_kb: 64 * 1024,
      } as Electron.TraceConfig)
      .then(() => (this.tracing = true))
      .catch((err: unknown) => this.log(`chromium trace off: ${String(err)}`));
  }

  private tracing = false;

  private async chromiumTrace(lateMs: number, label: string): Promise<void> {
    if (!this.tracing) return;
    this.tracing = false;
    try {
      const file = await contentTracing.stopRecording(join(this.dir, `main-stall-${label.replace(/[:.]/g, "")}.trace.json`));
      this.log(`  chromium: ${longestTasks(readFileSync(file, "utf8"), lateMs)} · trace ${file}`);
    } catch (err) {
      this.log(`  chromium trace failed: ${String(err)}`);
    }
    this.startChromiumTrace();
  }

  private post<T = unknown>(method: string, params: object = {}): Promise<T> {
    return new Promise((resolve, reject) => this.session.post(method, params, (err, res) => (err ? reject(err) : resolve(res as T))));
  }
}

const frameName = (f: CallFrame) => `${f.functionName || "(anonymous)"}${f.url ? ` ${f.url.replace(/^.*[\\/]/, "")}:${f.lineNumber + 1}` : ""}`;

/** The samples of the last `lateMs` (+ a margin): the frames they were in most, and the stack of the busiest one. */
export function summarize(profile: Profile, lateMs: number): string {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const times: number[] = [];
  let t = profile.startTime;
  for (const d of profile.timeDeltas) times.push((t += d));
  const from = profile.endTime - (lateMs + 300) * 1000;
  const counts = new Map<number, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    if (times[i]! < from) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    total++;
  });
  if (!total) return "no samples (the profiler itself was held up)";
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 5).map(([id, n]) => `${frameName(byId.get(id)!.callFrame)} ${Math.round((n * 100) / total)}%`);
  const stack: string[] = [];
  for (let id: number | undefined = ranked[0]![0]; id !== undefined && stack.length < 14; id = parent.get(id)) {
    const f = byId.get(id)!.callFrame;
    if (f.functionName !== "(root)") stack.push(frameName(f));
  }
  return `${total} samples; most: ${top.join(", ")}; stack of the first: ${stack.join(" < ")}`;
}

interface TraceEvent {
  ph: string;
  name: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: Record<string, unknown>;
}

/** The longest complete tasks in a Chromium trace (any process), with the process and thread they ran on. */
export function longestTasks(json: string, lateMs: number): string {
  let events: TraceEvent[];
  try {
    const parsed = JSON.parse(json) as { traceEvents?: TraceEvent[] } | TraceEvent[];
    events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
  } catch {
    return "trace unreadable";
  }
  const procs = new Map<number, string>();
  const threads = new Map<string, string>();
  for (const e of events) {
    if (e.ph !== "M") continue;
    const name = String((e.args as { name?: unknown } | undefined)?.name ?? "");
    if (e.name === "process_name") procs.set(e.pid, name);
    if (e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, name);
  }
  const min = Math.max(300, lateMs * 0.25) * 1000;
  const long = events.filter((e) => e.ph === "X" && (e.dur ?? 0) >= min).sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0));
  if (!long.length) return `no task of ${Math.round(min / 1000)}ms or more in the trace (${events.length} events)`;
  const args = (a: Record<string, unknown> | undefined) => {
    if (!a) return "";
    const s = JSON.stringify(a);
    return s === "{}" ? "" : ` ${s.slice(0, 220)}`;
  };
  return long
    .slice(0, 8)
    .map((e) => `[${procs.get(e.pid) ?? e.pid}/${threads.get(`${e.pid}:${e.tid}`) ?? e.tid}] ${e.name} ${Math.round((e.dur ?? 0) / 1000)}ms${args(e.args)}`)
    .join(" | ");
}
