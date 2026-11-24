import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileSha512 } from "@amo-studio/locate/download";
import { fetchPart, InstallError, machinePlatform, mirrorInfo, outputTail, runInstaller, serverReady, toolSources, VERSION, type InstallFrom, type InstallProgress, type InstallRunner, type MachinePlatform, type ServerAccount, type ToolSources } from "./tool-mirror.js";

// 环境 → 安装 / 更新 the Antigravity CLI (agy: Studio's Gemini channel, 2026-11-24, plans/agy.md): from the team server's
// mirror (packages/relay/src/mirror.ts, AGY_SOURCE) or from Google, whichever the person clicks, as Google's own install.ps1
// does it: the manifest (manifests/windows_<arch>.json: version, url, sha512), the exe (about 240 MB, not packed) checked
// against the sha512, put at %LOCALAPPDATA%\agy\bin\agy.exe, then `agy install` (PATH and the shell profile; install.ps1
// lets it fail without failing the install, and so does this, saying so).
//
// Google's manifest names only the newest version: a server version that is older is checked against the sha512 the
// server recorded when it checked the file against Google's manifest (the server cannot be asked to prove more).

export const AGY_OFFICIAL = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
type Env = Record<string, string | undefined>;

const ARCH: Record<MachinePlatform, string> = { "win32-x64": "windows_amd64", "win32-arm64": "windows_arm64" };

/** Where Google's install.ps1 puts agy, and where this does. */
export const agyBinDir = (env: Env) => join(env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), "AppData", "Local"), "agy", "bin");
export const agyExe = (env: Env) => join(agyBinDir(env), "agy.exe");
/** An exe moved aside while it ran (a Studio Gemini session): agy.exe.amo-old-<time>. */
const ASIDE = ".amo-old-";

interface Manifest {
  version: string;
  url: string;
  sha512: string;
}

/** Google's manifest for this machine, or null (no network, a page instead of JSON: 8 s). */
export async function officialManifest(platform: MachinePlatform, fetchFn: typeof fetch = fetch, base = AGY_OFFICIAL): Promise<Manifest | null> {
  try {
    const res = await fetchFn(`${base.replace(/\/+$/, "")}/manifests/${ARCH[platform]}.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const m = (await res.json()) as { version?: unknown; url?: unknown; sha512?: unknown };
    if (typeof m.version !== "string" || !VERSION.test(m.version) || typeof m.url !== "string" || !/^https?:\/\//.test(m.url) || typeof m.sha512 !== "string" || !/^[0-9a-fA-F]{128}$/.test(m.sha512)) return null;
    return { version: m.version, url: m.url, sha512: m.sha512.toLowerCase() };
  } catch {
    return null;
  }
}

export interface AgySourceOptions {
  env: Env;
  account: ServerAccount | null;
  fetch?: typeof fetch;
  /** Google's updater base (tests: a fake). */
  base?: string;
}

/** The team server's newest ready version for this machine and Google's latest, both asked at once. */
export async function agySources(o: AgySourceOptions): Promise<ToolSources> {
  const fetchFn = o.fetch ?? fetch;
  const platform = machinePlatform(o.env);
  const [info, official] = await Promise.all([mirrorInfo("antigravity-cli", o.account, fetchFn), officialManifest(platform, fetchFn, o.base)]);
  return toolSources(info, official?.version ?? null, platform);
}

export interface AgyInstallOptions extends AgySourceOptions {
  /** Where the .part is kept between tries (the platform's folder, downloads\antigravity-cli). */
  downloadsDir: string;
  onProgress?: (p: InstallProgress) => void;
  /** Runs `agy install` (tests stand in for it). */
  run?: InstallRunner;
  runEnv?: Env;
  stallMs?: number;
  retryDelaysMs?: number[];
  /** The exe paths of the running programs: an agy moved aside is removed only when none runs from agy.exe. */
  runningPaths?: () => Promise<string[]>;
  signal?: AbortSignal;
}

/** Removes the exes moved aside, when no program runs from agy.exe (nor when that cannot be told). */
async function dropAside(exe: string, runningPaths?: () => Promise<string[]>): Promise<void> {
  const dir = dirname(exe);
  const name = `${basename(exe)}${ASIDE}`;
  let old: string[];
  try {
    old = readdirSync(dir).filter((n) => n.startsWith(name));
  } catch {
    return;
  }
  if (!old.length) return;
  const paths = runningPaths ? await runningPaths().catch(() => null) : [];
  if (!paths || paths.some((p) => p.toLowerCase() === exe.toLowerCase())) return;
  for (const n of old) rmSync(join(dir, n), { force: true });
}

/**
 * Installs (or updates to) `version` from `from`. Throws InstallError with what went wrong in words; the .part stays
 * when the download broke, so 再点一次 goes on. `setup` says how `agy install` went (null: it went through).
 */
export async function installAgy(version: string, from: InstallFrom, o: AgyInstallOptions): Promise<{ version: string; from: InstallFrom; setup: string | null }> {
  const fetchFn = o.fetch ?? fetch;
  const platform = machinePlatform(o.env);
  if (!VERSION.test(version)) throw new InstallError(`版本号不对：${version}`);
  if (from === "server" && !o.account) throw new InstallError("没登录团队服务器，从团队服务器装不了：在「账号」里登录，或者从官方装。");
  const progress = (phase: InstallProgress["phase"], done = 0, total: number | null = null) => o.onProgress?.({ phase, from, done, total });

  // 1. What the file must be: Google's manifest when it names this version; else what the server checked it against.
  progress("manifest");
  const official = await officialManifest(platform, fetchFn, o.base);
  let sha512: string | null = official?.version === version ? official.sha512 : null;
  if (!sha512 && from === "server") {
    const ready = serverReady(await mirrorInfo("antigravity-cli", o.account, fetchFn), platform);
    sha512 = ready?.version === version && typeof ready.file.sha512 === "string" && /^[0-9a-f]{128}$/.test(ready.file.sha512) ? ready.file.sha512 : null;
  }
  if (!sha512) throw new InstallError(from === "official" ? `Google 的清单${official ? `现在是 ${official.version}，不是 ${version}` : "拿不到"}，没法校验，先不装：点「重新检测」看看。` : `拿不到 ${version} 的 sha512（Google 和团队服务器都没给），没法校验，先不装。`);

  // 2. The exe, going on from what an earlier try left (from either place: the server keeps Google's file as it came).
  const part = await fetchPart({
    url: from === "server" ? `${o.account!.server}/platform/mirror/antigravity-cli/${version}/${platform}/agy.exe` : official!.url,
    headers: from === "server" ? { authorization: `Bearer ${o.account!.key}` } : {},
    from,
    downloadsDir: o.downloadsDir,
    partName: `agy-${version}-${platform}.exe.part`,
    fetch: fetchFn,
    ...(o.stallMs ? { stallMs: o.stallMs } : {}),
    ...(o.retryDelaysMs ? { retryDelaysMs: o.retryDelaysMs } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    onProgress: (done, total) => progress("downloading", done, total),
  });

  // 3. Checked before it goes anywhere.
  progress("verifying");
  if ((await fileSha512(part)) !== sha512) {
    rmSync(part, { force: true });
    throw new InstallError(`下好的文件和 ${from === "official" ? "Google 清单" : "团队服务器记的"}的 sha512 对不上，已经删掉，没有装。再点一次会重新下${from === "server" ? "；还是不对的话，告诉管理团队服务器的人" : ""}。`);
  }

  // 4. In place. A running agy.exe (a Studio Gemini session) cannot be overwritten but can be renamed: it is moved aside
  // and goes on; the new one takes its name (as Claude Code's launcher, claude-install.ts).
  const exe = agyExe(o.env);
  mkdirSync(dirname(exe), { recursive: true });
  let aside: string | null = null;
  if (existsSync(exe)) {
    aside = `${exe}${ASIDE}${Date.now().toString(36)}`;
    try {
      renameSync(exe, aside);
    } catch (err) {
      throw new InstallError(`${version} 已经下好、校验过了，但 ${exe} 换不了（${err instanceof Error ? err.message : String(err)}）：先结束 Studio 里正在跑的 Gemini 会话和终端里的 agy，再点一次，不用重新下载。`);
    }
  }
  try {
    copyFileSync(part, exe);
  } catch (err) {
    if (aside)
      try {
        renameSync(aside, exe);
      } catch {
        // the old one stays aside; agy is then missing until the next try
      }
    throw new InstallError(`${version} 已经下好，但没能放到 ${exe}（${err instanceof Error ? err.message : String(err)}）。再点一次试试。`);
  }
  rmSync(part, { force: true });

  // 5. agy sets up PATH and the shell profile itself. Google's install.ps1 lets this fail (the exe works without it).
  progress("installing", 0, statSync(exe).size);
  const run = await (o.run ?? runInstaller)(exe, ["install"], o.runEnv ?? o.env);
  await dropAside(exe, o.runningPaths);
  const tail = outputTail(run.out);
  return { version, from, setup: run.ok ? null : `agy install 没做完（${run.reason === "timeout" ? "等了 5 分钟" : "出错"}），agy 本身已经装好，只是 PATH 可能没配上${tail ? "：\n" + tail : ""}` };
}
