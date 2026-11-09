import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DSH_DESKTOP_ARGS, dshDesktopDir, locateDshDesktop, type DshDesktopFound } from "@amo-studio/locate";
import type { DshCheck, DshStatus } from "@amo-studio/protocol";

// Everything Studio relies on in DeepSeek Harness (stage 17, plans/done/stage-17-dsh.md; spikes s17-00/01): the desktop app
// (2026-10-26: the default when it is installed; it updates itself) or a source clone the person builds and pulls.
// When a new DSH stops working with Studio, these are the places to look.
// 设置 → 模型 →「检查」 runs `checkDsh` (dsh-runtime.ts): start, initialize, open a session — no model call.

/** kv: the clone's folder (设置 → 模型 → DeepSeek Harness). */
export const DSH_PATH_KEY = "settings:dsh-path";
/** kv: the desktop app's folder the person chose (2026-11-02: installed somewhere else than usual); "" = look for it. */
export const DSH_DESKTOP_PATH_KEY = "settings:dsh-desktop-path";
/** kv: where DSH comes from — "auto" (the desktop app when installed, else the clone) or "clone" (always the clone). */
export const DSH_SOURCE_KEY = "settings:dsh-source";
export type DshSource = "auto" | "clone";
/**
 * kv: how the built-in DeepSeek signs in (2026-11-03, the user: a computer that never had old AMO has no key to reuse, and
 * the desktop app works once signed in without one) — "account": the DeepSeek account signed in in the DSH desktop app;
 * "key": the API key saved in Studio. Unset: "key" when one is saved (what it always was), else "account".
 */
export const DSH_AUTH_KEY = "settings:dsh-auth";
export type DshAuth = "account" | "key";
/** The built-in DeepSeek's key (Windows Credential Manager, old AMO's entry; Studio writes it since 2026-11-03). */
export const DSH_KEY_CREDENTIAL = "deepseek-v4";
/** kv: the last 「检查」. */
export const DSH_CHECK_KEY = "dsh:check";
/** kv: the session config options (models, efforts) DSH last offered, for the pickers. */
export const DSH_OPTIONS_KEY = "dsh:config-options";
/** kv: the same, offered on the desktop app's account (2026-11-03: other models than with a key). */
export const DSH_ACCOUNT_OPTIONS_KEY = "dsh:config-options:account";

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
/** DSH's tools that start a subagent in the background (subagents.ts). */
export const DSH_SUBAGENT_TOOLS = new Set(["subagent", "subagent_fork"]);
/** DSH's tool an agent sends another (its parent, its subagent) a message with. */
export const DSH_SEND_MESSAGE = "send_message";

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

export function readDshDesktopPath(kv: KvStore): string | null {
  return kv.getKv(DSH_DESKTOP_PATH_KEY)?.value || null;
}

export function readDshSource(kv: KvStore): DshSource {
  return kv.getKv(DSH_SOURCE_KEY)?.value === "clone" ? "clone" : "auto";
}

export function readDshAuth(kv: KvStore, keySaved: boolean): DshAuth {
  const v = kv.getKv(DSH_AUTH_KEY)?.value;
  return v === "account" || v === "key" ? v : keySaved ? "key" : "account";
}

// ---- the desktop app's sign-in ----------------------------------------------------------------------------------

// Studio's DSH keeps its own home (its sessions stay out of the desktop app's list), so it does not see the app's
// sign-in by itself: in "account" mode its processes get a patch that points DSH's credential store
// (`@deepseek-ai/dsh-credentials-local`, plugin id `credentials`) at the app's `.credentials.yaml`, and start their ACP
// agent on the account's route (`deepseek-account`, which takes no API key). Checked 2026-11-03 on the desktop app:
// from a fresh home with the patch, DSH lists `deepseek-account/*` and answers on it.

/** DSH's credential store plugin, its account route and the model the ACP agent starts on there. */
export const DSH_CREDENTIALS_PLUGIN = "credentials";
export const DSH_ACCOUNT_PROVIDER = "deepseek-account";
export const DSH_ACCOUNT_DEFAULT_MODEL = "deepseek-flash";
/** The desktop app's sign-in record in its credentials file. */
const ACCOUNT_RECORD = /^\s+deepseek-account-platform\/default:\s*$/m;

/** The desktop app's credentials file: in the person's own DSH home (DSH_HOME, else ~/.dsh). */
export function dshAccountFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
}

/** Whether the desktop app is signed in to a DeepSeek account (its credentials file holds the sign-in; never read out). */
export function dshAccountSignedIn(file: string): boolean {
  try {
    return ACCOUNT_RECORD.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** DeepSeek Platform, where the desktop app's account signs in; its token goes nowhere else. */
export const DSH_ACCOUNT_ORIGIN = "https://platform.deepseek.com";

/**
 * The desktop app's account sign-in (its token and the site that issued it), for the balance (2026-11-09: 选了 DS
 * 登录就用 DS 登录的方式去查). Read when it is asked, kept nowhere, never logged. DSH writes the record as
 * `records: / deepseek-account-platform/default: / kind: grant / payload: { version, token, issuer }`
 * (`@deepseek-ai/dsh-credentials-local`); null when the file or the record is missing or not like that.
 */
export function readDshAccountGrant(file: string): { token: string; issuer: string } | null {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
  const at = lines.findIndex((l) => ACCOUNT_RECORD.test(l));
  if (at < 0) return null;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const own = indentOf(lines[at]!);
  const fields = new Map<string, string>();
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && indentOf(line) <= own) break;
    const m = /^\s+(kind|token|issuer):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[2]!;
    fields.set(m[1]!, /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw);
  }
  const token = fields.get("token") ?? "";
  const issuer = (fields.get("issuer") ?? "").replace(/\/+$/, "");
  if (fields.get("kind") !== "grant" || !/^[\x21-\x7e]+$/.test(token) || !issuer) return null;
  return { token, issuer };
}

// DSH's DeepSeek routes: the API key's (`deepseek-official`) and the account's. Neither has config of its own in the
// acp profile (checked 2026-11-07 with --dump-default-config), so a patch that gives one config loses nothing — but a
// patch's config replaces the whole entry, so each of Studio's patches says everything Studio sets on a route.
export const DSH_KEY_PLUGIN = "llm-deepseek";
export const DSH_ACCOUNT_PLUGIN = "llm-deepseek-account";

// A stream that ends cleanly before its last event (`STREAM_CLOSED`: "DeepSeek Messages stream ended before
// message_stop") is asked again too (2026-11-07: a channel cut a subagent's turn there after 12 minutes, and the work
// stopped; DSH's default policy leaves this code out until it decides on it). DSH keeps the cut answer out of the
// conversation and sends the same request again, so no tool runs twice; the cost is the answer generated again. The
// other codes are DSH's defaults (packages/llm/llm/src/retry-policy.ts), restated because a list replaces them; the
// number of tries and the waits stay DSH's.
export const DSH_RETRY_CODES = ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "STREAM_CLOSED"] as const;

/** A route's retry policy as the lines under its `config:`. */
export function retryPolicyYaml(): string[] {
  return ["    retryPolicy:", "      mode: normal", `      retryableCodes: [${DSH_RETRY_CODES.join(", ")}]`];
}

/** The patch with only the retry policy, on both routes (a process that needs no other patch). */
export function retryPatchYaml(): string {
  return [
    "# Written by AMO Studio: a cut-off answer is asked again (DSH_RETRY_CODES).",
    `- id: ${DSH_KEY_PLUGIN}`,
    "  config:",
    ...retryPolicyYaml(),
    `- id: ${DSH_ACCOUNT_PLUGIN}`,
    "  config:",
    ...retryPolicyYaml(),
    "",
  ].join("\n");
}

/** The patch for "account" mode: DSH's credentials from the desktop app's file, the ACP agent on the account's `model`. */
export function accountPatchYaml(file: string, model: string): string {
  return [
    "# Written by AMO Studio: the DeepSeek account signed in in the DSH desktop app (设置 → 模型 → DeepSeek).",
    `- id: ${DSH_ACCOUNT_PLUGIN}`,
    "  config:",
    ...retryPolicyYaml(),
    `- id: ${DSH_CREDENTIALS_PLUGIN}`,
    "  config:",
    `    path: ${JSON.stringify(file)}`,
    "- id: acp",
    "  config:",
    `    provider: ${DSH_ACCOUNT_PROVIDER}`,
    `    model: ${JSON.stringify(model)}`,
    "",
  ].join("\n");
}

// ---- the desktop app --------------------------------------------------------------------------------------------

// Where the app installs, its exe and its own command line: in @amo-studio/locate since 2026-10-28 (AMO 平台's 环境 page
// looks for the app the same way).
export { dshDesktopDir as desktopDir };
const DESKTOP_ARGS = DSH_DESKTOP_ARGS;

export interface DshDesktop {
  dir: string;
  exe: string;
  cli: string;
  version: string | null;
  /** Where it was found (locateDshDesktop). */
  from: DshDesktopFound["from"];
}

/** The version the app last said, by its exe's time (an update replaces the exe). */
const desktopVersions = new Map<string, { mtime: number; version: string | null }>();

/**
 * The installed desktop app, or null: in the folder the person chose (`chosen`), the usual one, or where the registry
 * says (2026-11-02). Its version is asked once per installed build (a second or two).
 */
export function findDesktopDsh(env: NodeJS.ProcessEnv = process.env, chosen: string | null = null): DshDesktop | null {
  const app = locateDshDesktop(env, chosen);
  if (!app) return null;
  const { dir, exe, cli, from } = app;
  let mtime: number;
  try {
    mtime = statSync(exe).mtimeMs;
  } catch {
    return null;
  }
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
  return { dir, exe, cli, version, from };
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
    const desktop = findDesktopDsh(env, readDshDesktopPath(kv));
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

/** `keySaved`: whether the built-in DeepSeek's API key is saved (DSH_KEY_CREDENTIAL). */
export function dshStatus(kv: KvStore, env: NodeJS.ProcessEnv = process.env, keySaved = false): DshStatus {
  const path = readDshPath(kv);
  const accountFile = dshAccountFile(env);
  const install = path ? describeDsh(path) : null;
  const node = resolveNode(env);
  const desktopChosen = readDshDesktopPath(kv);
  const desktop = findDesktopDsh(env, desktopChosen);
  const launch = resolveDsh(kv, env);
  return {
    source: readDshSource(kv),
    desktop: desktop ? { path: desktop.dir, version: desktop.version, from: desktop.from } : null,
    desktopDir: dshDesktopDir(env),
    desktopChosen,
    active: "error" in launch ? null : { kind: launch.kind, version: launch.version },
    unavailable: "error" in launch ? launch.error : null,
    path,
    version: install?.version ?? null,
    commit: install?.commit ?? null,
    commitDate: install?.commitDate ?? null,
    built: !!install?.built,
    node: node ? { path: node, version: nodeVersion(node) } : null,
    check: readDshCheck(kv),
    auth: readDshAuth(kv, keySaved),
    account: { file: accountFile, signedIn: dshAccountSignedIn(accountFile) },
    keySaved,
  };
}
