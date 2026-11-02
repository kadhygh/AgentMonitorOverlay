import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DownloadError, fileSha256, resumeDownload, unpackZstd } from "@amo-studio/locate/download";

// 环境 → 安装 / 更新 Claude Code (plans/claude-code-mirror.md; the user, 2026-11-02/03): from the team server's mirror
// (packages/relay/src/mirror.ts) when it has a version ready, else from Anthropic; either way the .zst (122 MB, not the
// 335 MB exe), going on after a break (Range), unpacked and checked against Anthropic's own manifest (asked directly, so a
// server that went wrong cannot slip in another file; the server's copy only when Anthropic cannot be reached).
//
// Then the exe is put where Claude Code keeps its versions (%USERPROFILE%\.local\share\claude\versions\<version>) and
// `<that exe> install <version>` sets up the launcher and the shell integration. Tried 2026-11-02 with Claude Code 2.1.316:
// with the file already there, install takes 7 s and downloads nothing (also offline); without it, install downloads the
// .zst from Anthropic itself — so if Claude Code ever keeps its versions elsewhere, this still installs, only slower.

export const CLAUDE_OFFICIAL = "https://downloads.claude.ai/claude-code-releases";
export type ClaudePlatform = "win32-x64" | "win32-arm64";
type Env = Record<string, string | undefined>;

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]+)?$/;

/** Which Windows build this machine takes: ARM64 also when an x64 program runs emulated there (PROCESSOR_ARCHITEW6432). */
export function claudePlatform(env: Env): ClaudePlatform {
  return [env.PROCESSOR_ARCHITEW6432, env.PROCESSOR_ARCHITECTURE].some((a) => a?.toUpperCase() === "ARM64") ? "win32-arm64" : "win32-x64";
}

/** Where Claude Code's own installer keeps its versions. */
export const claudeVersionsDir = (env: Env) => join(env.USERPROFILE || homedir(), ".local", "share", "claude", "versions");

export interface MirrorFile {
  file: string;
  size: number;
  sha256: string;
  exeSize: number;
}

/** GET /api/platform/mirror/claude-code (relay mirror.ts's MirrorPlatformView). */
export interface MirrorInfo {
  official: string | null;
  versions: Array<{ version: string; platforms: Partial<Record<ClaudePlatform, MirrorFile>> }>;
  preparing: { version: string; platform: ClaudePlatform; done: number; total: number | null } | null;
}

export interface ServerAccount {
  server: string;
  key: string;
}

/** The server's mirror, or null: not signed in, no mirror there (404), not reached in 5 s. */
export async function mirrorInfo(account: ServerAccount | null, fetchFn: typeof fetch = fetch): Promise<MirrorInfo | null> {
  if (!account) return null;
  try {
    const res = await fetchFn(`${account.server}/api/platform/mirror/claude-code`, { headers: { authorization: `Bearer ${account.key}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const v = (await res.json()) as MirrorInfo;
    return Array.isArray(v?.versions) ? v : null;
  } catch {
    return null;
  }
}

/** Anthropic's latest, or null (no network, a blocked region answering a page: 8 s). */
export async function officialLatest(fetchFn: typeof fetch = fetch, base = CLAUDE_OFFICIAL): Promise<string | null> {
  try {
    const res = await fetchFn(`${base}/latest`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const v = (await res.text()).trim();
    return VERSION.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** What 安装 / 更新 would fetch. */
export interface ClaudeSource {
  version: string;
  from: "server" | "official";
  platform: ClaudePlatform;
  /** The .zst's size when the server says (Anthropic's is learnt when it starts). */
  size: number | null;
  /** The server is getting a newer one ready: 「团队服务器正在准备 2.1.317（45%）」. */
  preparing: string | null;
}

export interface SourceOptions {
  env: Env;
  account: ServerAccount | null;
  fetch?: typeof fetch;
  /** Anthropic's base (tests: a fake). */
  base?: string;
}

/**
 * The version to install and where from (the user, 2026-11-03): the newest the team server has ready for this machine;
 * when it has none (or cannot be reached), Anthropic's latest. Null: neither answered.
 */
export async function pickClaudeSource(o: SourceOptions): Promise<ClaudeSource | null> {
  const platform = claudePlatform(o.env);
  const fetchFn = o.fetch ?? fetch;
  const [info, official] = await Promise.all([mirrorInfo(o.account, fetchFn), officialLatest(fetchFn, o.base)]);
  const ready = info?.versions.find((v) => VERSION.test(v.version) && v.platforms[platform]);
  const p = info?.preparing;
  const preparingFor = (version: string) =>
    p && p.platform === platform && p.version !== version ? `团队服务器正在准备 ${p.version}${p.total ? `（${Math.floor((p.done / p.total) * 100)}%）` : ""}，下好之后从这里装会更快。` : null;
  if (ready) return { version: ready.version, from: "server", platform, size: ready.platforms[platform]!.size, preparing: preparingFor(ready.version) };
  if (official) return { version: official, from: "official", platform, size: null, preparing: preparingFor(official) };
  return null;
}

export const SOURCE_NAME: Record<ClaudeSource["from"], string> = { server: "团队服务器", official: "官方" };

export interface InstallProgress {
  phase: "manifest" | "downloading" | "unpacking" | "installing";
  from: ClaudeSource["from"];
  done: number;
  total: number | null;
}

export type InstallRunner = (exe: string, args: string[], env: Env) => Promise<{ ok: boolean; out: string; reason?: "timeout" | "error" }>;

export interface InstallOptions extends SourceOptions {
  /** Where the .zst.part is kept between tries (the platform's folder, downloads\claude-code). */
  downloadsDir: string;
  onProgress?: (p: InstallProgress) => void;
  /** Runs `<exe> install <version>` (tests stand in for it). */
  run?: InstallRunner;
  /** The environment the installer runs with (the platform's, without what a program it starts must not inherit). */
  runEnv?: Env;
  stallMs?: number;
  /** Pauses between tries of the download (default 2, 5, 10 s). */
  retryDelaysMs?: number[];
  signal?: AbortSignal;
}

export class ClaudeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeInstallError";
  }
}

interface ManifestEntry {
  sha256: string;
  size: number;
}

async function manifestEntry(url: string, version: string, platform: ClaudePlatform, fetchFn: typeof fetch, headers: Record<string, string> = {}): Promise<ManifestEntry | null> {
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const m = (await res.json()) as { version?: unknown; platforms?: Record<string, { checksum?: unknown; size?: unknown } | undefined> };
    const e = m?.platforms?.[platform];
    if (m?.version !== version || typeof e?.checksum !== "string" || !/^[0-9a-f]{64}$/.test(e.checksum) || typeof e.size !== "number") return null;
    return { sha256: e.checksum, size: e.size };
  } catch {
    return null;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });

/** Runs the installer, its output (stdout and stderr, the last 4 KB) kept; 5 minutes at most. */
export const runClaudeInstall: InstallRunner = (exe, args, env) =>
  new Promise((done) => {
    let out = "";
    const keep = (d: string) => (out = (out + d).slice(-4096));
    const childEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { env: childEnv, windowsHide: true });
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

/**
 * Installs (or updates to) `source.version`: manifest, download, check, versions\<version>, `install`. Throws
 * ClaudeInstallError with what went wrong in words; the .part stays when the download broke, so 再试一次 goes on.
 */
export async function installClaude(source: ClaudeSource, o: InstallOptions): Promise<{ version: string; from: ClaudeSource["from"]; out: string }> {
  const fetchFn = o.fetch ?? fetch;
  const base = (o.base ?? CLAUDE_OFFICIAL).replace(/\/+$/, "");
  const { version, platform } = source;
  if (!VERSION.test(version)) throw new ClaudeInstallError(`版本号不对：${version}`);
  const auth: Record<string, string> = o.account ? { authorization: `Bearer ${o.account.key}` } : {};
  const serverBase = o.account ? `${o.account.server}/platform/mirror/claude-code/${version}` : null;
  let from = source.from;
  const progress = (phase: InstallProgress["phase"], done = 0, total: number | null = null) => o.onProgress?.({ phase, from, done, total });

  // 1. What the file must be: Anthropic's manifest first; the server's copy only when Anthropic cannot be reached.
  progress("manifest");
  const entry = (await manifestEntry(`${base}/${version}/manifest.json`, version, platform, fetchFn)) ?? (serverBase && from === "server" ? await manifestEntry(`${serverBase}/manifest.json`, version, platform, fetchFn, auth) : null);
  if (!entry) throw new ClaudeInstallError(`拿不到 ${version} 的清单（官方${from === "server" ? "和团队服务器" : ""}都没连上），没法校验，先不装。`);

  const versionsDir = claudeVersionsDir(o.env);
  const final = join(versionsDir, version);
  const already = existsSync(final) && statSync(final).isFile() && statSync(final).size === entry.size && (await fileSha256(final)) === entry.sha256;
  if (!already) {
    // 2. The .zst, going on from what an earlier try left; other versions' leftovers go.
    mkdirSync(o.downloadsDir, { recursive: true });
    const partName = `claude-${version}-${platform}.exe.zst.part`;
    for (const name of readdirSync(o.downloadsDir)) if (name !== partName && name.endsWith(".part")) rmSync(join(o.downloadsDir, name), { force: true });
    const part = join(o.downloadsDir, partName);
    const officialUrl = `${base}/${version}/${platform}/claude.exe.zst`;
    const delays = o.retryDelaysMs ?? [2000, 5000, 10_000];
    for (let attempt = 0; ; attempt++) {
      // The server keeps Anthropic's .zst as it came, so a part begun from one goes on from the other.
      const [url, headers] = from === "server" && serverBase ? [`${serverBase}/${platform}/claude.exe.zst`, auth] : [officialUrl, {}];
      try {
        await resumeDownload(url, part, { fetch: fetchFn, headers, ...(o.stallMs ? { stallMs: o.stallMs } : {}), ...(o.signal ? { signal: o.signal } : {}), onProgress: (done, total) => progress("downloading", done, total) });
        break;
      } catch (err) {
        if (o.signal?.aborted) throw new ClaudeInstallError("取消了");
        const status = err instanceof DownloadError ? err.status : null;
        // The server lost it, the login went, or it broke twice: on from Anthropic (slower, but there).
        if (from === "server" && (status === 401 || status === 403 || status === 404 || attempt >= 1)) {
          from = "official";
          attempt = -1;
          continue;
        }
        if (attempt >= delays.length || status === 404) throw new ClaudeInstallError(`下载没成功（${err instanceof Error ? err.message : String(err)}）。下了的部分留着，再点一次会接着下。`);
        await sleep(delays[attempt]!, o.signal);
      }
    }

    // 3. Unpacked beside its place and checked; only a good one takes the version's name.
    progress("unpacking", 0, entry.size);
    mkdirSync(versionsDir, { recursive: true });
    const tmp = `${final}.amo-tmp`;
    let got: { sha256: string; size: number };
    try {
      got = await unpackZstd(part, tmp);
    } catch (err) {
      rmSync(tmp, { force: true });
      rmSync(part, { force: true });
      throw new ClaudeInstallError(`下好的文件解压不了，已经删掉（${err instanceof Error ? err.message : String(err)}）。再点一次会重新下。`);
    }
    if (got.sha256 !== entry.sha256 || got.size !== entry.size) {
      rmSync(tmp, { force: true });
      rmSync(part, { force: true });
      throw new ClaudeInstallError(`下好的文件和官方清单对不上（sha256 或大小），已经删掉，没有装。再点一次会重新下${from === "server" ? "；还是不对的话，告诉管理团队服务器的人" : ""}。`);
    }
    try {
      // A failed `claude install` can leave an empty placeholder under the name.
      rmSync(final, { force: true });
      renameSync(tmp, final);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new ClaudeInstallError(`没能放进 ${versionsDir}（${err instanceof Error ? err.message : String(err)}）：这一版的 Claude Code 可能正开着。`);
    }
    rmSync(part, { force: true });
  }

  // 4. Claude Code sets itself up (launcher, PATH, shell integration) from the file in place.
  progress("installing");
  const run = await (o.run ?? runClaudeInstall)(final, ["install", version], o.runEnv ?? o.env);
  if (!run.ok) {
    const tail = run.out.trim().split(/\r?\n/).slice(-4).join("\n");
    throw new ClaudeInstallError(`文件已经下好、校验过了，但 claude install 没成功（${run.reason === "timeout" ? "等了 5 分钟还没做完" : "出错"}）${tail ? "：\n" + tail : ""}`);
  }
  return { version, from, out: run.out };
}
