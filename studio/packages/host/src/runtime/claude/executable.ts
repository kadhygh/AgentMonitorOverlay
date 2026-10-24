import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeCodeStatus } from "@amo-studio/protocol";
import { bundledClaudeExe, installedClaudeExe } from "./transcripts.js";

// Which Claude Code the Claude sessions run on (2026-10-24). The portable build leaves Claude Code out (it is
// Anthropic's, not Studio's to hand out, and it is half the download): there the sessions use the person's own install,
// and without one every channel on Claude Code (Claude 订阅, GLM, the person's Claude 方案 channels) is unavailable. A
// source checkout still has the SDK's copy, the same version as the SDK.

/** Why a Claude channel cannot start sessions, as the pickers and 设置 → 模型 show it. */
export const CLAUDE_CODE_MISSING = "没有找到 Claude Code 客户端：装好后在 设置 → 模型 点「重新检测」";

export interface ClaudeCode {
  path: string;
  source: ClaudeCodeStatus["source"] & string;
}

/** The SDK's own copy; absent in the portable build. */
function bundled(): string | null {
  try {
    const exe = bundledClaudeExe();
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

const versions = new Map<string, { mtimeMs: number; version: string | null }>();

/** `claude --version` of the exe as it is now ("2.1.309"), null when it does not start; remembered until it changes. */
function versionNow(path: string): string | null {
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
    version = /\d+\.\d+\.\d+/.exec(execFileSync(path, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true }))?.[0] ?? null;
  } catch {
    version = null;
  }
  versions.set(path, { mtimeMs, version });
  return version;
}

/** Whether the exe starts and says its version (after dsh-TUI: a broken install on PATH must not hide a good one). */
const starts = (path: string) => versionNow(path) !== null;

/**
 * The person's install: `claude` on PATH, else where its installers put it (Studio's PATH is the one it started with,
 * so a Claude Code installed since is found there too); the first that starts. npm's `claude.cmd` cannot be started
 * without a shell; the native exe it wraps is used instead.
 */
function installed(env: NodeJS.ProcessEnv, works: (path: string) => boolean): string | null {
  const home = env.USERPROFILE ?? homedir();
  const npm = env.APPDATA ? join(env.APPDATA, "npm") : null;
  const candidates = [installedClaudeExe(env), join(home, ".local", "bin", "claude.exe"), npm && join(npm, "claude.cmd")];
  for (const exe of candidates) {
    if (!exe || !existsSync(exe)) continue;
    const native = exe.toLowerCase().endsWith(".cmd") ? join(dirname(exe), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : exe;
    if (existsSync(native) && works(native)) return native;
  }
  return null;
}

/**
 * AMO_STUDIO_CLAUDE (an exe, taken as it is; one that does not exist means none, as tests use it), the SDK's copy, then
 * the person's install that starts; null when there is none. `works` is for tests.
 */
export function findClaudeCode(env: NodeJS.ProcessEnv = process.env, sdk: string | null = bundled(), works: (path: string) => boolean = starts): ClaudeCode | null {
  const explicit = env.AMO_STUDIO_CLAUDE;
  if (explicit) return existsSync(explicit) ? { path: explicit, source: "env" } : null;
  if (sdk) return { path: sdk, source: "bundled" };
  const own = installed(env, works);
  return own ? { path: own, source: "installed" } : null;
}

/** The exe Claude sessions start, or the error the person sees. */
export function requireClaudeCode(env: NodeJS.ProcessEnv = process.env): string {
  const found = findClaudeCode(env);
  if (!found) throw Object.assign(new Error(CLAUDE_CODE_MISSING), { code: "bad_request" });
  return found.path;
}

/** The Claude Code version the SDK was built with ("2.1.304"). */
export function sdkClaudeCodeVersion(): string | null {
  try {
    const main = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const pkg = JSON.parse(readFileSync(join(dirname(main), "package.json"), "utf8")) as { claudeCodeVersion?: string };
    return pkg.claudeCodeVersion ?? null;
  } catch {
    return null;
  }
}

/** `claude --version` ("2.1.309"), remembered until the exe changes (it updates itself). */
export async function claudeCodeVersion(path: string): Promise<string | null> {
  return versionNow(path);
}

/** Whether `a` is an older version than `b` (dotted numbers). */
export function olderVersion(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** 设置 → 模型: the Claude Code sessions run on, its version, and the SDK's. */
export async function claudeCodeStatus(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCodeStatus> {
  const found = findClaudeCode(env);
  const sdkVersion = sdkClaudeCodeVersion();
  const version = found ? await claudeCodeVersion(found.path) : null;
  return { path: found?.path ?? null, source: found?.source ?? null, version, sdkVersion, outdated: !!(version && sdkVersion && olderVersion(version, sdkVersion)) };
}
