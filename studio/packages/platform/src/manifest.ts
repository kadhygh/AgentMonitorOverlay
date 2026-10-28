// The server's data as the contract has it (plans/amo-lan-platform.md, 「第一版的接口约定」):
//   channels.json  { "stable": { "studio": "0.9.0", … }, "test": { … } }
//   a manifest     { tool, name, version, builtAt, exe, runtime?, notes, files: [{ path, size, sha256 }] }
// Checked here before anything is written to disk: a path that leaves the program folder, or a bad sha256, never
// reaches the installer.

import type { Channel } from "./view.js";

export interface ManifestFile {
  /** `/`-separated, relative to the program folder. */
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  tool: string;
  name: string;
  version: string;
  /** When it was built, in ms since 1970 (the server writes a number; 10-28). */
  builtAt: number;
  /** The main program, relative to the program folder (`AMO Studio.exe`). */
  exe: string;
  /** The Electron version it was built with (2026-10-29; absent in manifests published before). */
  runtime?: string;
  notes: string;
  files: ManifestFile[];
}

export type Channels = Record<Channel, Record<string, string>>;

export class PlatformError extends Error {
  constructor(
    readonly code: "unreachable" | "unauthorized" | "not_found" | "server" | "bad_data" | "checksum" | "running" | "busy" | "nothing" | "io",
    message: string,
  ) {
    super(message);
  }
}

const SHA = /^[0-9a-f]{64}$/;
const TOOL = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export const isToolId = (s: string) => TOOL.test(s);
export const isVersion = (s: string) => VERSION.test(s) && !s.includes("..");

/** The path's parts when it stays inside the program folder; null when it would not. */
export function safeParts(path: string): string[] | null {
  if (!path || path.startsWith("/") || /[\\:*?"<>|\0]/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p))) return null;
  return parts;
}

export function checkManifest(value: unknown, tool: string, version: string): Manifest {
  const bad = (why: string) => new PlatformError("bad_data", `服务器上 ${tool} ${version} 的清单不对：${why}`);
  if (!value || typeof value !== "object") throw bad("不是 JSON 对象");
  const m = value as Record<string, unknown>;
  if (m.tool !== tool || m.version !== version) throw bad(`写的是 ${String(m.tool)} ${String(m.version)}`);
  if (typeof m.exe !== "string" || !safeParts(m.exe)) throw bad("主程序路径不对");
  if (!Array.isArray(m.files) || m.files.length === 0) throw bad("没有文件");
  const seen = new Set<string>();
  const files: ManifestFile[] = m.files.map((f: unknown) => {
    const x = (f ?? {}) as Record<string, unknown>;
    if (typeof x.path !== "string" || !safeParts(x.path)) throw bad(`文件路径不对：${String(x.path)}`);
    if (typeof x.sha256 !== "string" || !SHA.test(x.sha256)) throw bad(`${x.path} 的 sha256 不对`);
    if (typeof x.size !== "number" || !Number.isInteger(x.size) || x.size < 0) throw bad(`${x.path} 的大小不对`);
    const key = x.path.toLowerCase();
    if (seen.has(key)) throw bad(`${x.path} 出现了两次`);
    seen.add(key);
    return { path: x.path, size: x.size, sha256: x.sha256 };
  });
  if (!seen.has(m.exe.toLowerCase())) throw bad(`主程序 ${m.exe} 不在文件里`);
  return {
    tool,
    version,
    name: typeof m.name === "string" && m.name ? m.name : tool,
    builtAt: typeof m.builtAt === "number" ? m.builtAt : typeof m.builtAt === "string" ? Date.parse(m.builtAt) || 0 : 0,
    exe: m.exe,
    ...(typeof m.runtime === "string" && m.runtime ? { runtime: m.runtime } : {}),
    notes: typeof m.notes === "string" ? m.notes : "",
    files,
  };
}

export function checkChannels(value: unknown): Channels {
  const out: Channels = { stable: {}, test: {} };
  if (!value || typeof value !== "object") throw new PlatformError("bad_data", "服务器上的通道信息不对");
  for (const ch of ["stable", "test"] as const) {
    const c = (value as Record<string, unknown>)[ch];
    if (!c || typeof c !== "object") continue;
    for (const [tool, version] of Object.entries(c as Record<string, unknown>)) if (isToolId(tool) && typeof version === "string" && isVersion(version)) out[ch][tool] = version;
  }
  return out;
}

/** 0.9.10 > 0.9.9; a pre-release (0.9.1-beta) sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre = ""] = v.split(/-(.*)/s, 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The version a channel offers. The test channel is "the newest there is": a tool published to stable only (or
 * promoted past what test has) is offered at that newer stable version, not hidden from testers.
 */
export function channelVersion(channels: Channels, channel: Channel, tool: string): string | null {
  const stable = channels.stable[tool] ?? null;
  if (channel === "stable") return stable;
  const test = channels.test[tool] ?? null;
  if (!test) return stable;
  if (!stable) return test;
  return compareVersions(test, stable) >= 0 ? test : stable;
}
