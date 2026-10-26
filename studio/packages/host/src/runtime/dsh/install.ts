import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DshCheck, DshStatus } from "@amo-studio/protocol";

// Everything Studio relies on in DeepSeek Harness (stage 17, plans/stage-17-dsh.md; spikes s17-00/01): the desktop app
// (2026-10-26: the default when it is installed; it updates itself) or a source clone the person builds and pulls.
// When a new DSH stops working with Studio, these are the places to look.
// 设置 → 模型 →「检查」 runs `checkDsh` (dsh-runtime.ts): start, initialize, open a session — no model call.

/** kv: the clone's folder (设置 → 模型 → DeepSeek Harness). */
export const DSH_PATH_KEY = "settings:dsh-path";
/** kv: where DSH comes from — "auto" (the desktop app when installed, else the clone) or "clone" (always the clone). */
export const DSH_SOURCE_KEY = "settings:dsh-source";
export type DshSource = "auto" | "clone";
/** kv: the last 「检查」. */
export const DSH_CHECK_KEY = "dsh:check";
/** kv: the session config options (models, efforts) DSH last offered, for the pickers. */
export const DSH_OPTIONS_KEY = "dsh:config-options";

/** The built CLI inside the clone (`pnpm run build:artifacts`). */
export const DSH_BIN = ["apps", "cli", "lib", "bin.js"] as const;
/** The clone's CLI package, for its version. */
export const DSH_CLI_PACKAGE = ["apps", "cli", "package.json"] as const;
/** DSH's ACP stdio server (`dsh --profile acp`). */
export const DSH_ACP_ARGS = ["--profile", "acp"] as const;
/** ACP protocol version Studio speaks. */
export const ACP_VERSION = 1;

/** DSH's home (profiles, sessions, its own settings and key file); Studio gives it a folder of its own. */
export const DSH_HOME_ENV = "DSH_HOME";
/** The sandbox a DSH process runs commands in; approval is "ask" except under danger-full-access. */
export const DSH_PERMISSION_ENV = "DSH_PERMISSION_MODE";
/** The DeepSeek key, read from the launch environment when DSH's own key file has none. */
export const DSH_KEY_ENV = "DEEPSEEK_API_KEY";
/** The DeepSeek route's address (an Anthropic Messages endpoint); a third-party DeepSeek channel sets it (2026-10-19). */
export const DSH_BASE_URL_ENV = "DEEPSEEK_BASE_URL";

/** Session config options DSH offers over ACP (`session/set_config_option`). */
export const DSH_MODEL_OPTION = "model";
export const DSH_EFFORT_OPTION = "reasoning_effort";
/** Permission request options. */
export const DSH_ALLOW = "allow_once";
export const DSH_REJECT = "reject_once";

export type DshPermissionMode = "read-only" | "workspace-write" | "danger-full-access";

/** Shell tools whose calls show as commands. */
export const DSH_SHELL_TOOLS = new Set(["pwsh", "bash", "powershell", "shell"]);
/** DSH names an MCP tool `mcp__<server>__<tool>`. */
export const DSH_MCP_PREFIX = "mcp__";

/** The settings store, as far as DSH needs it. */
export interface KvStore {
  getKv(key: string): { value: string } | undefined;
  setKv(key: string, value: string): unknown;
}

// ---- the clone --------------------------------------------------------------------------------------------------

export interface DshInstall {
  path: string;
  bin: string;
  built: boolean;
  version: string | null;
  commit: string | null;
  commitDate: string | null;
}

/** What is in the folder: is it a DSH clone, is it built, which version and commit. Null when it is not a clone. */
export function describeDsh(path: string): DshInstall | null {
  const pkg = join(path, ...DSH_CLI_PACKAGE);
  if (!existsSync(pkg)) return null;
  let version: string | null = null;
  try {
    version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? null;
  } catch {
    version = null;
  }
  let commit: string | null = null;
  let commitDate: string | null = null;
  try {
    const out = execFileSync("git", ["-C", path, "log", "-1", "--format=%h %cs"], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    [commit = null, commitDate = null] = out.split(" ") as [string?, string?];
  } catch {
    // Not a git checkout (a copied folder): no commit to show.
  }
  const bin = join(path, ...DSH_BIN);
  return { path, bin, built: existsSync(bin), version, commit, commitDate };
}

export function readDshPath(kv: KvStore): string | null {
  return kv.getKv(DSH_PATH_KEY)?.value || null;
}

export function readDshSource(kv: KvStore): DshSource {
  return kv.getKv(DSH_SOURCE_KEY)?.value === "clone" ? "clone" : "auto";
}

// ---- the desktop app --------------------------------------------------------------------------------------------

/** Where the desktop app installs (per user); AMO_STUDIO_DSH_DESKTOP points elsewhere ("" = none). */
export function desktopDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AMO_STUDIO_DSH_DESKTOP !== undefined) return env.AMO_STUDIO_DSH_DESKTOP || null;
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "DeepSeek Harness") : null;
}
/** The app's own command line, as its resources/runtime/cli/bin/dsh.cmd runs it: the app's Electron as Node. */
const DESKTOP_EXE = "DeepSeek Harness.exe";
const DESKTOP_CLI = ["resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"] as const;
const DESKTOP_ARGS = ["--expose-internals"] as const;

export interface DshDesktop {
  dir: string;
  exe: string;
  cli: string;
  version: string | null;
}

/** The version the app last said, by its exe's time (an update replaces the exe). */
const desktopVersions = new Map<string, { mtime: number; version: string | null }>();

/** The installed desktop app, or null. Its version is asked once per installed build (a second or two). */
export function findDesktopDsh(env: NodeJS.ProcessEnv = process.env): DshDesktop | null {
  const dir = desktopDir(env);
  if (!dir) return null;
  const exe = join(dir, DESKTOP_EXE);
  let mtime: number;
  try {
    mtime = statSync(exe).mtimeMs;
  } catch {
    return null;
  }
  // The CLI sits inside app.asar, which only Electron can read: the exe and the archive are what can be checked.
  if (!existsSync(join(dir, "resources", "app.asar"))) return null;
  const cli = join(dir, ...DESKTOP_CLI);
  const known = desktopVersions.get(exe);
  let version = known?.mtime === mtime ? known.version : null;
  if (known?.mtime !== mtime) {
    try {
      version = execFileSync(exe, [...DESKTOP_ARGS, cli, "--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      version = null;
    }
    desktopVersions.set(exe, { mtime, version });
  }
  return { dir, exe, cli, version };
}

// ---- which one runs -----------------------------------------------------------------------------------------------

export interface DshLaunch {
  kind: "desktop" | "clone";
  /** The desktop app's folder or the clone's. */
  path: string;
  command: string;
  /** Before DSH's own arguments (`--profile acp`). */
  args: string[];
  /** Added to the launch environment. */
  env: Record<string, string>;
  version: string | null;
  commit: string | null;
}

/** What DeepSeek · DSH sessions run on, or why they cannot. */
export function resolveDsh(kv: KvStore, env: NodeJS.ProcessEnv = process.env): DshLaunch | { error: string } {
  const source = readDshSource(kv);
  if (source === "auto") {
    const desktop = findDesktopDsh(env);
    if (desktop) return { kind: "desktop", path: desktop.dir, command: desktop.exe, args: [...DESKTOP_ARGS, desktop.cli], env: { ELECTRON_RUN_AS_NODE: "1" }, version: desktop.version, commit: null };
  }
  const path = readDshPath(kv);
  if (!path) {
    return {
      error:
        source === "auto"
          ? "没找到 DeepSeek Harness 桌面版：装好桌面版，或者在 设置 → 模型 → DeepSeek Harness 里改用 DSH 源码克隆"
          : "还没有设置 DSH 源码位置（设置 → 模型 → DeepSeek Harness）",
    };
  }
  const install = describeDsh(path);
  if (!install) return { error: `${path} 不是 DSH 源码克隆（没有 apps/cli）` };
  if (!install.built) return { error: `DSH 还没有构建：在 ${path} 运行 pnpm install 和 pnpm run build:artifacts` };
  const node = resolveNode(env);
  if (!node) return { error: "找不到 Node（DSH 源码克隆要用系统的 node 运行）" };
  return { kind: "clone", path, command: node, args: [install.bin], env: {}, version: install.version, commit: install.commit };
}

/** Why sessions cannot run on DSH right now, or null when they can. */
export function dshUnavailable(kv: KvStore, env: NodeJS.ProcessEnv = process.env): string | null {
  const launch = resolveDsh(kv, env);
  return "error" in launch ? launch.error : null;
}

// ---- Node -------------------------------------------------------------------------------------------------------

/**
 * The Node that runs DSH. Under Electron the Host itself runs on Electron's Node, which DSH's native addons are not
 * built for: use the system's `node` (AMO_STUDIO_NODE overrides). Elsewhere (tests, a plain Host) the Host's own Node.
 */
export function resolveNode(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AMO_STUDIO_NODE) return env.AMO_STUDIO_NODE;
  if (!process.versions.electron) return process.execPath;
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const file = join(dir, name);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function nodeVersion(node: string): string | null {
  if (node === process.execPath && !process.versions.electron) return process.version;
  try {
    return execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

// ---- status -----------------------------------------------------------------------------------------------------

export function readDshCheck(kv: KvStore): DshCheck | null {
  try {
    return JSON.parse(kv.getKv(DSH_CHECK_KEY)?.value ?? "null") as DshCheck | null;
  } catch {
    return null;
  }
}

export function dshStatus(kv: KvStore, env: NodeJS.ProcessEnv = process.env): DshStatus {
  const path = readDshPath(kv);
  const install = path ? describeDsh(path) : null;
  const node = resolveNode(env);
  const desktop = findDesktopDsh(env);
  const launch = resolveDsh(kv, env);
  return {
    source: readDshSource(kv),
    desktop: desktop ? { path: desktop.dir, version: desktop.version } : null,
    desktopDir: desktopDir(env),
    active: "error" in launch ? null : { kind: launch.kind, version: launch.version },
    unavailable: "error" in launch ? launch.error : null,
    path,
    version: install?.version ?? null,
    commit: install?.commit ?? null,
    commitDate: install?.commitDate ?? null,
    built: !!install?.built,
    node: node ? { path: node, version: nodeVersion(node) } : null,
    check: readDshCheck(kv),
  };
}
