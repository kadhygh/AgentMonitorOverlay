import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agyCandidates, olderVersion, versionIn } from "@amo-studio/locate";
import type { AgyCheck } from "@amo-studio/protocol";

// Where the Gemini sessions' agy comes from and what Studio keeps about it (plans/agy.md, 2026-11-24). agy is the
// person's own install (AMO 平台's 环境 page, Google's installer or winget); Studio never installs or updates it, and
// starts it with its own updater off (AGY_CLI_DISABLE_AUTO_UPDATE: updates are the platform's, AGENTS.md 第 3 条).

export const AGY_CHECK_KEY = "agy:check";
/** The model, thinking level and mode options agy offered last (session/new, 「检查」), for the pickers. */
export const AGY_OPTIONS_KEY = "agy:config-options";
/** Models besides Gemini the person turned on in 设置 (2026-11-24: off by default). */
export const AGY_MODELS_KEY = "settings:agy-models";

/** ACP's ids of agy's session options (seen at session/new, spikes/gemini/a02). */
export const AGY_MODEL_OPTION = "model";
export const AGY_THOUGHT_OPTION = "thought_level";
export const AGY_MODE_OPTION = "mode";
export const AGY_ALLOW = "allow_once";
export const AGY_REJECT = "reject_once";

/**
 * The oldest agy Studio runs on: t3code's driver needs 1.5 (1.5.0 steers a running turn with the next prompt, 1.5.1
 * offers non-Gemini models to any ACP client). 1.5.16 is what was tried here.
 */
export const AGY_MIN_VERSION = "1.5.0";

export const AGY_MISSING = "没有找到 Antigravity CLI（agy）：在 AMO 平台的环境页安装，或者运行 winget install Google.AntigravityCLI，装好后在 设置 → 模型 → Antigravity 点「检查」";

/**
 * The environment agy runs in: its updater off, and what the Host's own environment says about Google accounts left
 * out (a GEMINI_API_KEY or GOOGLE_* there would switch agy from the person's sign-in to that key; t3code clears them
 * too). Windows names are case-insensitive, so they are matched that way.
 */
export function agyEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const u = k.toUpperCase();
    if (u.startsWith("GEMINI_") || u.startsWith("GOOGLE_")) continue;
    env[k] = v;
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return env;
}

const versions = new Map<string, { mtimeMs: number; version: string | null }>();

/** `agy --version` ("1.5.16"), null when it does not start; remembered until the exe changes. */
export function agyVersion(path: string): string | null {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const known = versions.get(path);
  if (known && known.mtimeMs === mtimeMs) return known.version;
  let version: string | null = null;
  try {
    version = versionIn(execFileSync(path, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: agyEnv(process.env) }));
  } catch {
    version = null;
  }
  versions.set(path, { mtimeMs, version });
  return version;
}

/** The agy sessions run on: the first candidate that says its version. */
export function resolveAgy(env: NodeJS.ProcessEnv = process.env): { path: string; version: string } | { error: string } {
  const candidates = agyCandidates(env);
  for (const path of candidates) {
    const version = agyVersion(path);
    if (!version) continue;
    if (olderVersion(version, AGY_MIN_VERSION)) return { error: `agy ${version} 太旧了（要 ${AGY_MIN_VERSION} 以上）：在 AMO 平台的环境页更新` };
    return { path, version };
  }
  return { error: candidates.length ? `找到了 agy（${candidates[0]}），但它运行不起来` : AGY_MISSING };
}

/** Why the Gemini profile cannot start sessions now, or null. Passive: nothing but `--version` is started. */
export function agyUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  const r = resolveAgy(env);
  return "error" in r ? r.error : null;
}

/** agy's own data folder (its sign-in, sessions and logs): `~/.gemini/antigravity-cli`. */
export function agyDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.USERPROFILE ?? homedir(), ".gemini", "antigravity-cli");
}

/** How agy last signed in through ACP (its cache file), or null. A hint only: the sign-in may have expired since. */
export function agySignIn(env: NodeJS.ProcessEnv = process.env): { method: string } | null {
  const file = join(agyDataDir(env), "cache", "acp-auth-state.json");
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { methodId?: unknown };
    return typeof v.methodId === "string" && v.methodId ? { method: v.methodId } : null;
  } catch {
    return null;
  }
}

export function readAgyCheck(kv: { getKv(key: string): { value: string } | undefined }): AgyCheck | null {
  try {
    return JSON.parse(kv.getKv(AGY_CHECK_KEY)?.value ?? "null") as AgyCheck | null;
  } catch {
    return null;
  }
}

export function readAgyModels(kv: { getKv(key: string): { value: string } | undefined }): string[] {
  try {
    const v = JSON.parse(kv.getKv(AGY_MODELS_KEY)?.value ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The sign-in methods agy offers (initialize), in Studio's words. */
export const AGY_SIGN_IN_LABEL: Record<string, string> = {
  "oauth-personal": "Google 账号",
  "oauth-business": "Gemini Enterprise",
  "gemini-api-key": "Gemini API Key",
  "agent-platform": "Gemini Enterprise Agent Platform",
};
