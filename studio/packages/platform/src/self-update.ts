import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { amoLocalHome, type Env } from "@amo-studio/account";
import { compareVersions, isVersion } from "./manifest.js";
import type { SelfStanding } from "./view.js";

// The platform updating itself (the user, 2026-10-28: people download the platform once from the server's page, and from
// then on it updates itself), and where it keeps what it installs.
//
// The root (the user, 2026-10-28: "I unpack it somewhere and expect the platform and the tools it downloads to be in the
// place I chose"): the folder the platform's zip was unpacked to. Everything lives there, nothing moves to AppData:
//   <root>\AMO Platform.exe        the entry the person double-clicks (the unpacked files, kept on the version in use)
//   <root>\apps\platform\<version> the platform's own updates, installed like the tools (current → the one in use)
//   <root>\apps\<tool>\<version>   the tools
// Run from <x>\apps\platform\<version>\ (after 重启平台) the root is <x>; run from anywhere else it is the exe's folder.
// From the sources (development) and in the tests: AMO_LOCAL_HOME, else %LOCALAPPDATA%\AMO; AMO_LOCAL_HOME always wins,
// so a test can point any run at a temp folder. The Chromium profile and the single-instance lock stay in
// %LOCALAPPDATA%\AMO (data, AGENTS.md constraint 2).
//
// Where it runs from:
//   dev        from the sources (electron + this package): never updates itself
//   installed  from <root>\apps\platform\… (current or a version folder): after 重启平台, or forwarded by the entry
//   outer      anywhere else: the entry, <root>\AMO Platform.exe
// The entry forwards before it shows anything (main.ts): when <root>\apps\platform\current is newer than itself, it
// starts that one and quits. The platform run from apps\platform then brings the entry's files up to its own version
// (entry.ts), so the next double-click is the new version straight away. Starting with Windows points at the entry.
// The running platform is never changed in place: after an update it says 重启平台 and only restarts when that is
// clicked (AGENTS.md, constraint 6). The tools it started are detached and keep running.

export type SelfPlace = { kind: "dev"; root: string } | { kind: "installed" | "outer"; exe: string; dir: string; root: string };

/** The tool id the platform publishes itself under (scripts/amo-tools.mjs). */
export const SELF = "platform";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The folder the platform and its tools live in: AMO_LOCAL_HOME when set; from the sources %LOCALAPPDATA%\AMO; run from
 * <x>\apps\platform\<version>\ it is <x>; anywhere else the exe's own folder (where the zip was unpacked).
 */
export function platformRoot(exe: string | null, env: Env): string {
  if (env.AMO_LOCAL_HOME) return resolve(env.AMO_LOCAL_HOME);
  if (!exe) return amoLocalHome(env);
  const dir = dirname(resolve(exe));
  const tool = dirname(dir);
  if (basename(tool).toLowerCase() === SELF && basename(dirname(tool)).toLowerCase() === "apps") return dirname(dirname(tool));
  return dir;
}

/** Where the running platform is: `exe` is its program (null when it runs from the sources). */
export function selfPlace(exe: string | null, env: Env): SelfPlace {
  const root = platformRoot(exe, env);
  if (!exe) return { kind: "dev", root };
  const home = join(root, "apps", SELF);
  // Through `current` (a junction) or straight from a version folder: both are the installed platform.
  const installed = inside(home, exe) || inside(real(home), real(exe));
  return { kind: installed ? "installed" : "outer", exe, dir: dirname(exe), root };
}

/** <apps>\platform\current\<exe>: the installed platform through `current`. */
export function currentExe(appsDir: string, exe: string): string {
  return join(appsDir, SELF, "current", ...exe.split("/"));
}

/** The entry the person double-clicks, <root>\AMO Platform.exe (named as the running program); null in development. */
export function entryExe(place: SelfPlace): string | null {
  if (place.kind === "dev") return null;
  return place.kind === "outer" ? place.exe : join(place.root, basename(place.exe));
}

/**
 * What starting with Windows registers: the entry (it forwards to a newer apps\platform version by itself), or, when
 * there is no entry beside apps\ (a test folder), the installed platform through `current`, else the program running
 * now; null in development (main.ts then registers electron with this package).
 */
export function loginItemExe(place: SelfPlace, installedExe: string | null): string | null {
  if (place.kind === "dev") return null;
  if (place.kind === "outer") return place.exe;
  const entry = entryExe(place)!;
  return existsSync(entry) ? entry : (installedExe ?? place.exe);
}

/**
 * The entry's forwarding (main.ts, before any window): the program in <root>\apps\platform\current's real folder when
 * that version is newer than the running one, else null. Kept to the layout alone — a folder named after its version
 * holding a program of the entry's name — since an old entry may have to forward to a much newer platform.
 */
export function forwardTarget(root: string, exe: string, running: string): string | null {
  try {
    const dir = realpathSync(join(root, "apps", SELF, "current"));
    const version = basename(dir);
    if (!isVersion(version) || compareVersions(version, running) <= 0) return null;
    const file = join(dir, basename(exe));
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** The forwarded platform's arguments: the entry's own (--channel, --hidden…) and `--after=<entry pid>` (it waits for the entry to be gone). */
export function forwardArgs(args: readonly string[], pid: number): string[] {
  return [...args.filter((a) => !a.startsWith("--after=")), `--after=${pid}`];
}

/**
 * How the running platform stands:
 *   dev         from the sources, no updates
 *   restart     this run installed a newer version: 重启平台
 *   newer-here  apps\platform already has a newer version than this one (the entry could not forward to it): 打开那个
 *   update      the channel has a newer version: 更新平台
 *   latest      nothing to do
 */
export function selfStanding(o: { place: SelfPlace["kind"]; running: string; installed: string | null; available: string | null; installedThisRun: boolean }): SelfStanding {
  if (o.place === "dev") return "dev";
  if (o.installed && compareVersions(o.installed, o.running) > 0) return o.installedThisRun ? "restart" : "newer-here";
  if (o.available && compareVersions(o.available, o.running) > 0) return "update";
  return "latest";
}

/** `--after=<pid>`: a restart's new platform waits for the old one to be gone before it takes over. */
export function afterPid(argv: readonly string[]): number | null {
  const a = argv.find((x) => x.startsWith("--after="));
  const pid = a ? Number.parseInt(a.slice(8), 10) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The arguments the restarted platform gets: this run's `--channel` (start-platform.cmd's test channel stays), and
 * `--after=<this pid>`. Not --hidden: the person clicked 重启平台 and expects the window back.
 */
export function restartArgs(argv: readonly string[], pid: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--channel" && argv[i + 1]) out.push(a, argv[++i]!);
    else if (a.startsWith("--channel=")) out.push(a);
  }
  return [...out, `--after=${pid}`];
}
