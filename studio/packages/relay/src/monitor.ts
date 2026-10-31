import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { cpus, loadavg, totalmem, freemem, uptime as machineUptime } from "node:os";
import { join } from "node:path";

// 服务器状态 on the admin page (2026-10-31, the user: worried the relay might take too much of the Mac mini, wanted to see
// it on a page, with a 24-hour curve). Cheap by design: one point every 5 minutes (machine CPU and memory, the relay's own
// CPU and memory, who is connected), the last 24 hours kept in a small JSON file beside the database so a restart keeps
// the curve; the rest (folder sizes, disk, the biggest processes) is only worked out when the page asks, and cached.

export interface MonitorPoint {
  t: number;
  /** The whole machine's CPU, % busy since the point before. */
  cpu: number;
  /** The relay's own CPU, as % of the whole machine (so it reads on the same axis as cpu). */
  relayCpu: number;
  load: number;
  memUsed: number;
  memTotal: number;
  /** The relay process's resident memory. */
  rss: number;
  /** Accounts with the client open, and devices on the device channel. */
  people: number;
  devices: number;
}

export interface MonitorProcess {
  name: string;
  count: number;
  rss: number;
  cpu: number;
}

export interface MonitorNow {
  point: MonitorPoint;
  startedAt: number;
  machineUptime: number;
  cores: number;
  node: string;
  disk: { free: number; total: number } | null;
  dirs: Array<{ label: string; path: string; bytes: number | null }>;
  /** The machines' biggest processes by memory, an app's helpers counted with it; empty where ps isn't there. */
  top: MonitorProcess[];
}

export interface MonitorOptions {
  /** Where the 24 hours are kept; none = only in memory. */
  file?: string;
  /** Folders whose size is shown (data, platform…); missing ones are left out. */
  dirs?: Array<{ label: string; path: string | undefined }>;
  counts: () => { people: number; devices: number };
  everyMs?: number;
  keepMs?: number;
}

interface Mark {
  cpu: { busy: number; total: number };
  relay: NodeJS.CpuUsage;
  at: number;
}

const EVERY_MS = 5 * 60_000;
const KEEP_MS = 24 * 3600_000;
const DIRS_TTL = 5 * 60_000;
const TOP_TTL = 10_000;

const run = (cmd: string, args: string[]) =>
  new Promise<string>((ok) => execFile(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, out) => ok(err ? "" : String(out))));

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of cpus()) {
    const { user, nice, sys, irq, idle } = c.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

/** Memory in use. On macOS os.freemem() leaves out the inactive and speculative pages the system hands back at once, so
 *  "used" would look far worse than Activity Monitor shows; vm_stat counts them as free. */
async function memUsed(): Promise<number> {
  const total = totalmem();
  if (process.platform === "darwin") {
    const out = await run("vm_stat", []);
    const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 0);
    const pages = (k: string) => Number(new RegExp(`Pages ${k}:\\s+(\\d+)`).exec(out)?.[1] ?? NaN);
    const free = (pages("free") + pages("inactive") + pages("speculative")) * page;
    if (page && Number.isFinite(free)) return Math.max(0, total - free);
  }
  return total - freemem();
}

async function dirBytes(path: string): Promise<number> {
  let sum = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else
        try {
          sum += (await lstat(p)).size;
        } catch {
          /* gone meanwhile */
        }
    }
  }
  return sum;
}

/** `ps` lines grouped by app: everything under one X.app counts as X (ChatGPT's helpers, a browser's renderers). */
export function topProcesses(psOut: string, limit = 8): MonitorProcess[] {
  const groups = new Map<string, MonitorProcess>();
  for (const line of psOut.split("\n")) {
    const m = /^\s*\d+\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const command = m[3]!;
    const app = /([^/]+)\.app\//.exec(command)?.[1];
    let name = app ?? command.split(" ")[0]!.split("/").pop()!;
    if (!app && /jenkins/i.test(command)) name += "（Jenkins）";
    if (!app && /amo-relay/.test(command)) name += "（AMO 中转）";
    const g = groups.get(name) ?? { name, count: 0, rss: 0, cpu: 0 };
    g.count++;
    g.rss += Number(m[1]) * 1024;
    g.cpu += Number(m[2]);
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.rss - a.rss).slice(0, limit);
}

export class ServerMonitor {
  private readonly everyMs: number;
  private readonly keepMs: number;
  private points: MonitorPoint[] = [];
  private last: Mark = { cpu: cpuTimes(), relay: process.cpuUsage(), at: Date.now() };
  private readonly timer: NodeJS.Timeout;
  private readonly startedAt = Date.now();
  private dirsCache: { at: number; value: MonitorNow["dirs"] } | null = null;
  private topCache: { at: number; value: MonitorProcess[] } | null = null;

  constructor(private readonly opts: MonitorOptions) {
    this.everyMs = opts.everyMs ?? EVERY_MS;
    this.keepMs = opts.keepMs ?? KEEP_MS;
    if (opts.file && existsSync(opts.file)) {
      try {
        const kept = JSON.parse(readFileSync(opts.file, "utf8")) as { points?: MonitorPoint[] };
        if (Array.isArray(kept.points)) this.points = kept.points.filter((p) => p && typeof p.t === "number");
      } catch {
        /* a broken file only loses the curve */
      }
    }
    this.trim(Date.now());
    this.timer = setInterval(() => void this.sample(), this.everyMs);
    this.timer.unref();
  }

  get intervalMs(): number {
    return this.everyMs;
  }

  history(): MonitorPoint[] {
    return this.points.slice();
  }

  /** A point measured since the one before, kept. */
  async sample(): Promise<MonitorPoint> {
    const { point, mark } = await this.measure(this.last);
    this.last = mark;
    this.points.push(point);
    this.trim(point.t);
    this.save();
    return point;
  }

  /** What the page shows as "now": CPU over the last half second (not since the last point), folders, disk, processes. */
  async now(): Promise<MonitorNow> {
    const base = { cpu: cpuTimes(), relay: process.cpuUsage(), at: Date.now() };
    await new Promise((r) => setTimeout(r, 500));
    const { point } = await this.measure(base);
    const firstDir = this.opts.dirs?.find((d) => d.path && existsSync(d.path))?.path;
    let disk: MonitorNow["disk"] = null;
    if (firstDir)
      try {
        const s = statfsSync(firstDir);
        disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
      } catch {
        /* no statfs here */
      }
    const [dirs, top] = await Promise.all([this.dirs(), this.top()]);
    return { point, startedAt: this.startedAt, machineUptime: Math.round(machineUptime()), cores: cpus().length, node: process.version, disk, dirs, top };
  }

  private async measure(prev: Mark): Promise<{ point: MonitorPoint; mark: Mark }> {
    const at = Date.now();
    const cpu = cpuTimes();
    const relay = process.cpuUsage();
    const dTotal = cpu.total - prev.cpu.total;
    const relayMs = (relay.user - prev.relay.user + relay.system - prev.relay.system) / 1000;
    const wallMs = Math.max(1, at - prev.at);
    const cores = cpus().length || 1;
    const point: MonitorPoint = {
      t: at,
      cpu: dTotal > 0 ? round1(((cpu.busy - prev.cpu.busy) / dTotal) * 100) : 0,
      relayCpu: round1((relayMs / wallMs / cores) * 100),
      load: round1(loadavg()[0] ?? 0),
      memUsed: await memUsed(),
      memTotal: totalmem(),
      rss: process.memoryUsage.rss(),
      ...this.opts.counts(),
    };
    return { point, mark: { cpu, relay, at } };
  }

  close(): void {
    clearInterval(this.timer);
  }

  private trim(now: number): void {
    const from = now - this.keepMs;
    this.points = this.points.filter((p) => p.t >= from);
  }

  private save(): void {
    if (!this.opts.file) return;
    try {
      const tmp = `${this.opts.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ everyMs: this.everyMs, points: this.points }));
      renameSync(tmp, this.opts.file);
    } catch {
      /* the curve stays in memory */
    }
  }

  private async dirs(): Promise<MonitorNow["dirs"]> {
    if (this.dirsCache && Date.now() - this.dirsCache.at < DIRS_TTL) return this.dirsCache.value;
    const value: MonitorNow["dirs"] = [];
    for (const d of this.opts.dirs ?? []) if (d.path && existsSync(d.path)) value.push({ label: d.label, path: d.path, bytes: await dirBytes(d.path) });
    this.dirsCache = { at: Date.now(), value };
    return value;
  }

  private async top(): Promise<MonitorProcess[]> {
    if (process.platform === "win32") return [];
    if (this.topCache && Date.now() - this.topCache.at < TOP_TTL) return this.topCache.value;
    const value = topProcesses(await run("ps", ["-axo", "pid=,rss=,pcpu=,command="]));
    this.topCache = { at: Date.now(), value };
    return value;
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
