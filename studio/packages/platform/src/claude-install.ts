import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileSha256, unpackZstd } from "@amo-studio/locate/download";
import { fetchPart, InstallError, machinePlatform, mirrorInfo, outputTail, runInstaller, toolSources, VERSION, type InstallFrom, type InstallProgress, type InstallRunner, type MachinePlatform, type ServerAccount, type ToolSources } from "./tool-mirror.js";

// 环境 → 安装 / 更新 Claude Code (plans/claude-code-mirror.md; the user, 2026-11-02/03): from the team server's mirror
// (packages/relay/src/mirror.ts) or from Anthropic, whichever the person clicks; either way the .zst (122 MB, not the
// 335 MB exe), going on after a break (Range), unpacked and checked against Anthropic's own manifest (asked directly, so a
// server that went wrong cannot slip in another file; the server's copy only when Anthropic cannot be reached).
//
// Then the exe is put where Claude Code keeps its versions (%USERPROFILE%\.local\share\claude\versions\<version>) and
// `<that exe> install <version>` sets up the launcher and the shell integration. Tried 2026-11-02 with Claude Code 2.1.316:
// with the file already there, install takes 7 s and downloads nothing (also offline); without it, install downloads the
// .zst from Anthropic itself — so if Claude Code ever keeps its versions elsewhere, this still installs, only slower.

export const CLAUDE_OFFICIAL = "https://downloads.claude.ai/claude-code-releases";
type Env = Record<string, string | undefined>;

/** Claude Code's launcher, what `claude` on PATH runs: a copy of the version in use. */
export const claudeLauncher = (env: Env) => join(env.USERPROFILE || homedir(), ".local", "bin", "claude.exe");
/** A launcher moved aside while it ran (installClaude, step 5): claude.exe.amo-old-<time>. */
const ASIDE = ".amo-old-";

/** Where Claude Code's own installer keeps its versions. */
export const claudeVersionsDir = (env: Env) => join(env.USERPROFILE || homedir(), ".local", "share", "claude", "versions");

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

export interface SourceOptions {
  env: Env;
  account: ServerAccount | null;
  fetch?: typeof fetch;
  /** Anthropic's base (tests: a fake). */
  base?: string;
}

/** The team server's newest ready version for this machine and Anthropic's latest, both asked at once. */
export async function claudeSources(o: SourceOptions): Promise<ToolSources> {
  const fetchFn = o.fetch ?? fetch;
  const [info, official] = await Promise.all([mirrorInfo("claude-code", o.account, fetchFn), officialLatest(fetchFn, o.base)]);
  return toolSources(info, official, machinePlatform(o.env));
}

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
  /** The exe paths of the running programs (system.ts runningExePaths): a launcher moved aside is removed only when none runs from the launcher. */
  runningPaths?: () => Promise<string[]>;
  signal?: AbortSignal;
}

interface ManifestEntry {
  sha256: string;
  size: number;
}

async function manifestEntry(url: string, version: string, platform: MachinePlatform, fetchFn: typeof fetch, headers: Record<string, string> = {}): Promise<ManifestEntry | null> {
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

/** Whether `file` is the one Anthropic's manifest describes. */
async function isEntry(file: string, entry: ManifestEntry): Promise<boolean> {
  try {
    return statSync(file).size === entry.size && (await fileSha256(file)) === entry.sha256;
  } catch {
    return false;
  }
}

/** Removes the launchers moved aside, when no program runs from the launcher (nor when that cannot be told). */
async function dropAside(launcher: string, runningPaths?: () => Promise<string[]>): Promise<void> {
  const dir = dirname(launcher);
  const name = `${basename(launcher)}${ASIDE}`;
  let old: string[];
  try {
    old = readdirSync(dir).filter((n) => n.startsWith(name));
  } catch {
    return;
  }
  if (!old.length) return;
  const paths = runningPaths ? await runningPaths().catch(() => null) : [];
  if (!paths || paths.some((p) => p.toLowerCase() === launcher.toLowerCase())) return;
  for (const n of old) rmSync(join(dir, n), { force: true });
}

/**
 * Installs (or updates to) `version` from `from`: manifest, download, check, versions\<version>, `install`. Throws
 * InstallError with what went wrong in words; the .part stays when the download broke, so 再点一次 goes on.
 */
export async function installClaude(version: string, from: InstallFrom, o: InstallOptions): Promise<{ version: string; from: InstallFrom; out: string }> {
  const fetchFn = o.fetch ?? fetch;
  const base = (o.base ?? CLAUDE_OFFICIAL).replace(/\/+$/, "");
  const platform = machinePlatform(o.env);
  if (!VERSION.test(version)) throw new InstallError(`版本号不对：${version}`);
  if (from === "server" && !o.account) throw new InstallError("没登录团队服务器，从团队服务器装不了：在「账号」里登录，或者从官方装。");
  const auth: Record<string, string> = o.account ? { authorization: `Bearer ${o.account.key}` } : {};
  const serverBase = o.account ? `${o.account.server}/platform/mirror/claude-code/${version}` : null;
  const progress = (phase: InstallProgress["phase"], done = 0, total: number | null = null) => o.onProgress?.({ phase, from, done, total });

  // 1. What the file must be: Anthropic's manifest first; the server's copy only when Anthropic cannot be reached.
  progress("manifest");
  const entry = (await manifestEntry(`${base}/${version}/manifest.json`, version, platform, fetchFn)) ?? (serverBase && from === "server" ? await manifestEntry(`${serverBase}/manifest.json`, version, platform, fetchFn, auth) : null);
  if (!entry) throw new InstallError(`拿不到 ${version} 的清单（官方${from === "server" ? "和团队服务器" : ""}都没连上），没法校验，先不装。`);

  const versionsDir = claudeVersionsDir(o.env);
  const final = join(versionsDir, version);
  const already = existsSync(final) && statSync(final).isFile() && statSync(final).size === entry.size && (await fileSha256(final)) === entry.sha256;
  if (!already) {
    // 2. The .zst, going on from what an earlier try left (from either place: the server keeps Anthropic's file as it came).
    const part = await fetchPart({
      url: from === "server" ? `${serverBase}/${platform}/claude.exe.zst` : `${base}/${version}/${platform}/claude.exe.zst`,
      headers: from === "server" ? auth : {},
      from,
      downloadsDir: o.downloadsDir,
      partName: `claude-${version}-${platform}.exe.zst.part`,
      fetch: fetchFn,
      ...(o.stallMs ? { stallMs: o.stallMs } : {}),
      ...(o.retryDelaysMs ? { retryDelaysMs: o.retryDelaysMs } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      onProgress: (done, total) => progress("downloading", done, total),
    });

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
      throw new InstallError(`下好的文件解压不了，已经删掉（${err instanceof Error ? err.message : String(err)}）。再点一次会重新下。`);
    }
    if (got.sha256 !== entry.sha256 || got.size !== entry.size) {
      rmSync(tmp, { force: true });
      rmSync(part, { force: true });
      throw new InstallError(`下好的文件和官方清单对不上（sha256 或大小），已经删掉，没有装。再点一次会重新下${from === "server" ? "；还是不对的话，告诉管理团队服务器的人" : ""}。`);
    }
    try {
      // A failed `claude install` can leave an empty placeholder under the name.
      rmSync(final, { force: true });
      renameSync(tmp, final);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new InstallError(`没能放进 ${versionsDir}（${err instanceof Error ? err.message : String(err)}）：这一版的 Claude Code 可能正开着。`);
    }
    rmSync(part, { force: true });
  }

  // 4. Claude Code sets itself up (launcher, PATH, shell integration) from the file in place.
  progress("installing");
  const run = await (o.run ?? runInstaller)(final, ["install", version], o.runEnv ?? o.env);
  if (!run.ok) {
    const tail = outputTail(run.out);
    throw new InstallError(`文件已经下好、校验过了，但 claude install 没成功（${run.reason === "timeout" ? "等了 5 分钟还没做完" : "出错"}）${tail ? "：\n" + tail : ""}`);
  }

  // 5. The launcher really is this version. 2026-11-03: the user's 「更新到 2.1.317」 left 2.1.316, twice — Studio's Claude
  // sessions run %USERPROFILE%\.local\bin\claude.exe, Windows does not let a running exe be overwritten, and `install`
  // said 「successfully installed! Version: 2.1.317」 all the same (tried here). A running exe can be renamed: the old one
  // is moved aside (the sessions go on with it) and the version copied in its place. What was moved aside goes once no
  // program runs from the launcher (a renamed program is still listed under its old name, so it cannot be told apart).
  const launcher = claudeLauncher(o.env);
  if (existsSync(launcher) && !(await isEntry(launcher, entry))) {
    const aside = `${launcher}${ASIDE}${Date.now().toString(36)}`;
    try {
      renameSync(launcher, aside);
    } catch (err) {
      throw new InstallError(`${version} 已经装好，但 Claude Code 的启动程序（${launcher}）换不了（${err instanceof Error ? err.message : String(err)}）：先结束正在开着的 Claude Code（Studio 里的 Claude 会话、终端里的 claude），再点一次，不用重新下载。`);
    }
    try {
      copyFileSync(final, launcher);
    } catch (err) {
      try {
        renameSync(aside, launcher);
      } catch {
        // the old one stays aside; claude is then missing until the next try
      }
      throw new InstallError(`${version} 已经装好，但没能放到 ${launcher}（${err instanceof Error ? err.message : String(err)}）。再点一次试试。`);
    }
  }
  await dropAside(launcher, o.runningPaths);
  return { version, from, out: run.out };
}
