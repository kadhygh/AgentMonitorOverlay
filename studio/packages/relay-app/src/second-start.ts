import { appendFileSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseOpenArg, runningTakesOpen } from "./open-arg.js";

// A second start of the client while one runs (single instance), and the log of what brought the window up.
//
// 2026-11-23 (the user: 「有时候中转点 × 会关不上，然后马上又弹出来，多数情况是中转里有任务时」), reproduced with the real
// shell and its own home (studio/out/repro, not kept): another start of the same exe — AMO 平台's 打开中转, which is
// also its tray icon's click while something waits in 中转, a shortcut, an older Studio's 在中转里打开 — could not take
// the lock and tried again every 500 ms for 8 s; each try reached the running client as a second-instance, which showed
// its window: × at 1 s, shown again 290 ms later and every 500 ms till 9 s. And the same program by another path (the
// platform starts the real version folder, Studio `current`) counted as another copy: the running one quit (400 ms)
// for it, and it came up anew. Now:
// - the second start waits for the lock only when the running one will give way (another program — a newer version
//   the platform installed); the same program shows itself and stays, so one knock is enough;
// - the running one gives way only to another program, never to itself by another path (realpath), nor to a start
//   asking it to open something (2026-11-23, open-arg.ts);
// - a knock repeated by the same start (an older client's tries) shows the window once.

/** running.json's `knock`: the running client keeps to the rules above (another path to it is itself; one show a start). */
export const KNOCK = 1;

/** Whether two exe paths are the same program: the same file, by any path (a junction like `current`, case). */
export function sameProgram(a: string, b: string, real: (p: string) => string = realOr): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return real(a).toLowerCase() === real(b).toLowerCase();
}
function realOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * What the running client does with a second start's argv: quit (退出中转, or another program takes over) or show
 * (itself, by whatever path; anything asked to open).
 */
export function knockAction(argv: readonly string[], other: string | undefined, me: string, real?: (p: string) => string): "quit" | "show" {
  if (argv.includes("--amo-quit")) return "quit";
  if (other && !sameProgram(other, me, real) && !parseOpenArg(argv)) return "quit";
  return "show";
}

/**
 * What a second start does once its lock call has knocked: "done" (the running one took it and stays — quit now), or
 * "wait" for the lock (the running one gives way to this one, or nothing says which one runs).
 */
export function secondStartPlan(argv: readonly string[], me: string, running: unknown, alive: (pid: number) => boolean, real?: (p: string) => string): { plan: "done" | "wait"; why: string } {
  const r = running as { pid?: unknown; exe?: unknown; knock?: unknown } | null;
  if (!r || typeof r.pid !== "number" || !alive(r.pid)) return { plan: "wait", why: "no running.json of a live client" };
  // The same path: every client stays for it. Another path to the same program: only one that says knock 1 (this
  // one's rule) — an older one compares the paths as text and gives way, so then wait and take over as before.
  if (typeof r.exe === "string" && (r.exe.toLowerCase() === me.toLowerCase() || (r.knock === KNOCK && sameProgram(r.exe, me, real)))) return { plan: "done", why: `the running one (pid ${r.pid}) is this program: it shows itself` };
  if (parseOpenArg(argv) && runningTakesOpen(running, alive)) return { plan: "done", why: `the running one (pid ${r.pid}) opens it` };
  return { plan: "wait", why: `the running one (pid ${r.pid}, ${String(r.exe)}) gives way to this one` };
}

/** A knock repeated by the same start (an older client tries the lock every 500 ms): within REPEAT_MS of the last. */
export class Knocks {
  static REPEAT_MS = 3000;
  private last: { key: string; at: number } | null = null;
  /** true: the same knock again — the window is not brought up again. */
  repeat(argv: readonly string[], other: string | undefined, now = Date.now()): boolean {
    const key = `${other ?? ""}\n${argv.join("\n")}`;
    const again = !!this.last && this.last.key === key && now - this.last.at < Knocks.REPEAT_MS;
    this.last = { key, at: now };
    return again;
  }
}

/**
 * window.log in the client's home: each time the window came up and why (a second start with its arguments and exe,
 * a notification, the tray), hidden with ×, given way. Kept small: past LOG_MAX it moves to window.log.1.
 */
export class WindowLog {
  static LOG_MAX = 256 * 1024;
  constructor(private readonly file: string) {}
  write(what: string): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      try {
        if (statSync(this.file).size > WindowLog.LOG_MAX) renameSync(this.file, `${this.file}.1`);
      } catch {
        // not there yet
      }
      appendFileSync(this.file, `${new Date().toISOString()} [${process.pid}] ${what.replace(/\s*\n\s*/g, " ")}\n`);
    } catch {
      // a log is never worth failing for
    }
  }
}

/** A second start's argv for the log: Chromium's own switches left out, at most 400 characters. */
export function argvText(argv: readonly string[]): string {
  const ours = argv.slice(1).filter((a) => !/^--(allow-file-access-from-files|original-process-start-time|enable-features|disable-features|js-flags|inspect)/.test(a));
  const text = JSON.stringify(ours);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
