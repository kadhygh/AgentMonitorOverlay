import { appendFileSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { amoFile, readJsonFile, updateJsonFile, type Env } from "@amo-studio/account";

// Which of the platform's tools run, without asking Windows for every process (2026-11-04, the user: 关闭 and 重启 on
// the cards were slow — each look at what runs started PowerShell for Get-CimInstance, 1.8 s here, and 关闭 then waited
// a fixed 4 s before looking again). Three layers, the user's idea:
//   1. the tool says so itself: Studio's shell.json in its data dir, running.json in 便签's, 中转's and the Reviewer's
//      home — { pid, exe, version }, written by the running instance, removed when it quits (read only here: AGENTS.md
//      constraint 1, the tool's own files);
//   2. the platform remembers what it started (launched.json beside platform.json), for a tool too old to say;
//   3. what neither knows: every process's exe, as before (system.ts's runningExePaths).
// A record counts only while its pid lives and its exe is in the tool's own folder: a Studio run from the sources on the
// same data dir is not the installed one. Layers 1 and 2 only ever say "runs"; "does not run" still comes from layer 3,
// in the background, except right after 关闭, when the processes known to be it have ended.

export interface RunningRecord {
  pid: number;
  exe: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `exe` is inside `folder` (case-insensitive, as Windows paths are). */
export function inFolder(exe: string, folder: string): boolean {
  return exe.toLowerCase().startsWith((resolve(folder) + sep).toLowerCase());
}

function appData(env: Env): string | null {
  return env.APPDATA ?? null;
}

/** Layer 1: where a tool writes its own record, or null when it writes none the platform knows of. */
export function ownRunningFile(tool: string, env: Env, studioDataDir: string | null): string | null {
  const home = (variable: string, folder: string) => {
    const set = env[variable];
    if (set) return resolve(set);
    const roaming = appData(env);
    return roaming ? join(roaming, folder) : null;
  };
  let dir: string | null;
  if (tool === "studio") return studioDataDir ? join(studioDataDir, "shell.json") : null;
  else if (tool === "notes") dir = home("AMO_NOTES_HOME", "AMO Notes");
  else if (tool === "relay") dir = home("AMO_RELAY_HOME", "AMO Relay");
  else if (tool === "reviewer") dir = home("AMO_REVIEWER_HOME", "AMO Reviewer");
  else return null;
  return dir ? join(dir, "running.json") : null;
}

/** A record with a pid and an exe (older tools wrote no exe: not used, layer 2 or 3 then). */
export function readOwnRunning(file: string | null): RunningRecord | null {
  if (!file) return null;
  let raw: { pid?: unknown; exe?: unknown };
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; exe?: unknown };
  } catch {
    return null;
  }
  const pid = raw.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof raw.exe !== "string" || !raw.exe) return null;
  return { pid, exe: raw.exe };
}

type LaunchedFile = Record<string, RunningRecord[]>;

/** Layer 2: the processes the platform started, per tool (%APPDATA%\AMO\launched.json, the platform's own). */
export class Launched {
  constructor(private readonly env: Env) {}

  private file(): string {
    return amoFile("launched.json", this.env);
  }

  /** Remembers a start; the tool's dead records go at the same time. */
  record(tool: string, rec: RunningRecord): void {
    try {
      updateJsonFile<LaunchedFile>(this.file(), (all) => ({ ...all, [tool]: [...(all[tool] ?? []).filter((r) => pidAlive(r.pid) && r.pid !== rec.pid), rec] }));
    } catch {
      // only a shortcut: without it the next look asks Windows
    }
  }

  /** The tool's started processes still alive (a started one that only handed its arguments over has ended). */
  alive(tool: string): RunningRecord[] {
    const list = readJsonFile<LaunchedFile>(this.file())?.[tool];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.pid === "number" && typeof r.exe === "string" && pidAlive(r.pid)) : [];
  }
}

/** The platform's timings (2026-11-04: to see which step of 关闭 / 重启 is slow), %APPDATA%\AMO\platform.log, kept small. */
export function logTiming(env: Env, line: string): void {
  const file = amoFile("platform.log", env);
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 256 * 1024) truncateSync(file, 0);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // a log only
  }
}
