import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { compareVersions } from "./manifest.js";
import type { SelfStanding } from "./view.js";

// The platform updating itself (the user, 2026-10-28: people download the platform once from the server's page, and from
// then on it updates itself). It is a tool like the others on the server (`platform`), installed by the same engine
// into <apps>\platform\<version> with `current` pointing at the one in use — so the shared Electron files are linked,
// not downloaded. The running platform is never changed in place: after an update it says 重启平台 and only restarts
// when that is clicked (AGENTS.md, constraint 6), from <apps>\platform\current. The tools it started are detached and
// keep running.
// Where it runs from:
//   dev        from the sources (electron + this package): never updates itself
//   installed  from <apps>\platform\… (current or a version folder)
//   loose      anywhere else: the folder the download page's zip was unpacked to. Its first update installs into
//              <apps>\platform and restarts from there; the unpacked folder is then no longer needed (the page says so).
// Starting with Windows points at <apps>\platform\current\<exe> once that exists, so it follows every update.

export type SelfPlace = { kind: "dev" } | { kind: "installed" | "loose"; exe: string; dir: string };

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

/** Where the running platform is: `exe` is its program (null when it runs from the sources). */
export function selfPlace(exe: string | null, appsDir: string): SelfPlace {
  if (!exe) return { kind: "dev" };
  const home = join(appsDir, SELF);
  // Through `current` (a junction) or straight from a version folder: both are the installed platform.
  const installed = inside(home, exe) || inside(real(home), real(exe));
  return { kind: installed ? "installed" : "loose", exe, dir: dirname(exe) };
}

/** <apps>\platform\current\<exe>: how the installed platform is started (a restart, starting with Windows). */
export function currentExe(appsDir: string, exe: string): string {
  return join(appsDir, SELF, "current", ...exe.split("/"));
}

/**
 * What starting with Windows registers: the installed platform's `current` exe once there is one (it follows every
 * update), else the program running now; null in development (main.ts then registers electron with this package).
 */
export function loginItemExe(place: SelfPlace, installedExe: string | null): string | null {
  if (place.kind === "dev") return null;
  return installedExe ?? place.exe;
}

/**
 * How the running platform stands:
 *   dev         from the sources, no updates
 *   restart     this run installed a newer version: 重启平台
 *   newer-here  <apps>\platform already has a newer version than this one (an old zip opened again): 打开那个
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

/** The unpacked zip folder recorded at the first update, while it is still there and is not the running one. */
export function oldFolder(recorded: string | null, place: SelfPlace): string | null {
  if (!recorded || place.kind !== "installed" || !existsSync(recorded)) return null;
  return real(recorded).toLowerCase() === real(place.dir).toLowerCase() ? null : recorded;
}
