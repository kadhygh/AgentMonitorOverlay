import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DownloadError, resumeDownload } from "@amo-studio/locate/download";

// What 环境's 安装 / 更新 of Claude Code and Codex share (plans/done/claude-code-mirror.md; the user, 2026-11-03): the team
// server's mirror (packages/relay/src/mirror.ts) and the maker's latest, shown side by side — the person picks which one
// to install (「团队服务器」 only when it has a version ready, 「官方」 always) — and the download, going on after a break
// (Range) from a .part in the platform's folder. A download from the server that fails stops and says so; it does not
// turn to the official one by itself (the person clicks that one: the server keeps the maker's file as it came, so the
// same .part goes on).

type Env = Record<string, string | undefined>;
export type MirrorTool = "claude-code" | "codex";
export type InstallFrom = "server" | "official";
export type MachinePlatform = "win32-x64" | "win32-arm64";

export const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]+)?$/;

export const SOURCE_NAME: Record<InstallFrom, string> = { server: "团队服务器", official: "官方" };

/** Which Windows build this machine takes: ARM64 also when an x64 program runs emulated there (PROCESSOR_ARCHITEW6432). */
export function machinePlatform(env: Env): MachinePlatform {
  return [env.PROCESSOR_ARCHITEW6432, env.PROCESSOR_ARCHITECTURE].some((a) => a?.toUpperCase() === "ARM64") ? "win32-arm64" : "win32-x64";
}

export interface ServerAccount {
  server: string;
  key: string;
}

/** A ready file on the server (relay mirror.ts's MirrorFile). */
export interface MirrorFile {
  file: string;
  size: number;
  /** Claude Code: the exe's sha256 and size (Anthropic's manifest). */
  sha256?: string;
  exeSize?: number;
  /** Codex: npm's dist.integrity of the .tgz. */
  integrity?: string;
}

/** GET /api/platform/mirror/<tool> (relay mirror.ts's MirrorPlatformView). */
export interface MirrorInfo {
  official: string | null;
  versions: Array<{ version: string; platforms: Partial<Record<MachinePlatform, MirrorFile>> }>;
  preparing: { version: string; platform: MachinePlatform; done: number; total: number | null } | null;
}

/** The server's mirror of a tool, or null: not signed in, no mirror there (404), not reached in 5 s. */
export async function mirrorInfo(tool: MirrorTool, account: ServerAccount | null, fetchFn: typeof fetch = fetch): Promise<MirrorInfo | null> {
  if (!account) return null;
  try {
    const res = await fetchFn(`${account.server}/api/platform/mirror/${tool}`, { headers: { authorization: `Bearer ${account.key}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const v = (await res.json()) as MirrorInfo;
    return Array.isArray(v?.versions) ? v : null;
  } catch {
    return null;
  }
}

/** The server's newest ready version for this machine, with its file. */
export function serverReady(info: MirrorInfo | null, platform: MachinePlatform): { version: string; file: MirrorFile } | null {
  const v = info?.versions.find((x) => VERSION.test(x.version) && x.platforms[platform]);
  return v ? { version: v.version, file: v.platforms[platform]! } : null;
}

/** 安装 / 更新's two places (the 环境 page shows both; the person picks). */
export interface ToolSources {
  platform: MachinePlatform;
  /** The server's newest ready version for this machine; null: none there (or not signed in, not reached). */
  server: { version: string; size: number } | null;
  /** The maker's latest; null: not reached. */
  official: { version: string } | null;
  /** The server is getting a newer one ready: 「团队服务器正在准备 2.1.317（45%）…」. */
  preparing: string | null;
}

export function toolSources(info: MirrorInfo | null, official: string | null, platform: MachinePlatform): ToolSources {
  const ready = serverReady(info, platform);
  const p = info?.preparing;
  const preparing = p && p.platform === platform && p.version !== ready?.version ? `团队服务器正在准备 ${p.version}${p.total ? `（${Math.floor((p.done / p.total) * 100)}%）` : ""}，下好之后可以从团队服务器装（局域网，更快）。` : null;
  return { platform, server: ready ? { version: ready.version, size: ready.file.size } : null, official: official && VERSION.test(official) ? { version: official } : null, preparing };
}

export interface InstallProgress {
  /** manifest: asking what the file must be; unpacking / verifying: checking it; installing: the tool's own setup. */
  phase: "manifest" | "downloading" | "unpacking" | "verifying" | "installing";
  from: InstallFrom;
  done: number;
  total: number | null;
}

export type InstallRunner = (exe: string, args: string[], env: Env) => Promise<{ ok: boolean; out: string; reason?: "timeout" | "error" }>;

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/**
 * Runs an installer step, its output (stdout and stderr, the last 4 KB) kept; 5 minutes at most. A .cmd (npm) goes
 * through cmd.exe with each argument quoted (the platform's folder may have spaces).
 */
export const runInstaller: InstallRunner = (exe, args, env) =>
  new Promise((done) => {
    let out = "";
    const keep = (d: string) => (out = (out + d).slice(-4096));
    const childEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    let child: ReturnType<typeof spawn>;
    try {
      child = /\.(cmd|bat)$/i.test(exe)
        ? spawn(env.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${exe}" ${args.map((a) => `"${a}"`).join(" ")}"`], { env: childEnv, windowsHide: true, windowsVerbatimArguments: true })
        : spawn(exe, args, { env: childEnv, windowsHide: true });
    } catch (err) {
      return done({ ok: false, out: String(err), reason: "error" });
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, out, reason: "timeout" });
    }, 300_000);
    child.stdout?.setEncoding("utf8").on("data", keep);
    child.stderr?.setEncoding("utf8").on("data", keep);
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, out: out || String(err), reason: "error" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true, out } : { ok: false, out, reason: "error" });
    });
  });

/** The last lines of an installer's output, for the message. */
export const outputTail = (out: string) => out.trim().split(/\r?\n/).slice(-4).join("\n");

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });

export interface FetchPartOptions {
  url: string;
  headers?: Record<string, string>;
  from: InstallFrom;
  downloadsDir: string;
  partName: string;
  fetch?: typeof fetch;
  stallMs?: number;
  /** Pauses between tries (default 2, 5, 10 s). */
  retryDelaysMs?: number[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number | null) => void;
}

/** Downloads to <downloadsDir>/<partName>, going on from what an earlier try left (other .part files there go). */
export async function fetchPart(o: FetchPartOptions): Promise<string> {
  mkdirSync(o.downloadsDir, { recursive: true });
  for (const name of readdirSync(o.downloadsDir)) if (name !== o.partName && name.endsWith(".part")) rmSync(join(o.downloadsDir, name), { force: true });
  const part = join(o.downloadsDir, o.partName);
  const delays = o.retryDelaysMs ?? [2000, 5000, 10_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await resumeDownload(o.url, part, { fetch: o.fetch ?? fetch, headers: o.headers ?? {}, ...(o.stallMs ? { stallMs: o.stallMs } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
      return part;
    } catch (err) {
      if (o.signal?.aborted) throw new InstallError("取消了");
      const status = err instanceof DownloadError ? err.status : null;
      const why = err instanceof Error ? err.message : String(err);
      const other = o.from === "server" ? "也可以点「官方」那一行的按钮从官方下" : "团队服务器上有这一版时，也可以从团队服务器下";
      // The server lost it, or the login went: no use trying again.
      if (o.from === "server" && (status === 401 || status === 403 || status === 404)) throw new InstallError(`团队服务器上拿不到这个文件了（${status === 404 ? "它可能刚删掉了旧版本" : "登录失效了"}）。点「重新检测」看看，${other}。`);
      if (attempt >= delays.length || status === 404) throw new InstallError(`从${SOURCE_NAME[o.from]}下载没成功（${why}）。下了的部分留着，再点一次会接着下；${other}。`);
      await sleep(delays[attempt]!, o.signal);
    }
  }
}
