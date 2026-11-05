import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileIntegrity, SHA512_INTEGRITY } from "@amo-studio/locate/download";
import { fetchPart, InstallError, machinePlatform, mirrorInfo, outputTail, runInstaller, serverReady, toolSources, VERSION, type InstallFrom, type InstallProgress, type InstallRunner, type MachinePlatform, type ServerAccount, type ToolSources } from "./tool-mirror.js";

// 环境 → 安装 / 更新 Codex (plans/done/claude-code-mirror.md; the user, 2026-11-03). Codex is installed with npm as before, only
// its big part comes another way: npm's @openai/codex is a 13 KB package whose program is in a platform package
// (@openai/codex@<version>-win32-x64, a 180 MB .tgz). That .tgz comes from the team server's mirror or from npm, whichever
// the person clicks, going on after a break (Range); it is checked against npm's own dist.integrity (sha512; the server's
// copy of it only when npm cannot be reached), put into npm's cache (`npm cache add`), and `npm install -g
// @openai/codex@<version>` then takes it from there (npm finds a package in its cache by that same sha512). Tried
// 2026-11-03 with 0.166.0: 5 s, only the package list (5 MB) and the 13 KB package fetched. npm keeps that copy in its
// cache as it would after a plain install; the platform's own file goes once it is in.
//
// A Codex from OpenAI's own install.ps1 (a release folder under %USERPROFILE%\.codex\packages\standalone, linked from
// %LOCALAPPDATA%\Programs\OpenAI\Codex\bin) is not touched: it updates itself, and the page says so.

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const CODEX_PACKAGE = "@openai/codex";
type Env = Record<string, string | undefined>;

const lower = (p: string) => p.toLowerCase().replace(/\//g, "\\");

/** A Codex from OpenAI's standalone installer (install.ps1). */
export function isStandaloneCodex(path: string | null, env: Env): boolean {
  if (!path) return false;
  const p = lower(path);
  const roots = [env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex") : null, join(env.CODEX_HOME || join(env.USERPROFILE || homedir(), ".codex"), "packages")];
  return roots.some((r) => !!r && p.startsWith(lower(r) + "\\"));
}

/** npm's latest @openai/codex, or null (no network, a slow registry: 8 s). */
export async function codexLatest(fetchFn: typeof fetch = fetch, registry = NPM_REGISTRY): Promise<string | null> {
  try {
    const res = await fetchFn(`${registry.replace(/\/+$/, "")}/@openai%2fcodex/latest`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const v = ((await res.json()) as { version?: unknown }).version;
    return typeof v === "string" && VERSION.test(v) ? v : null;
  } catch {
    return null;
  }
}

export interface CodexSourceOptions {
  env: Env;
  account: ServerAccount | null;
  fetch?: typeof fetch;
  /** npm's registry (tests: a fake). */
  registry?: string;
}

/** The team server's newest ready Codex for this machine and npm's latest, both asked at once. */
export async function codexSources(o: CodexSourceOptions): Promise<ToolSources> {
  const fetchFn = o.fetch ?? fetch;
  const [info, official] = await Promise.all([mirrorInfo("codex", o.account, fetchFn), codexLatest(fetchFn, o.registry)]);
  return toolSources(info, official, machinePlatform(o.env));
}

/** The platform package's dist.integrity on npm, or null. */
async function npmIntegrity(registry: string, version: string, platform: MachinePlatform, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`${registry}/@openai%2fcodex/${version}-${platform}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const doc = (await res.json()) as { version?: unknown; dist?: { integrity?: unknown } };
    const integrity = doc?.dist?.integrity;
    return doc?.version === `${version}-${platform}` && typeof integrity === "string" && SHA512_INTEGRITY.test(integrity) ? integrity : null;
  } catch {
    return null;
  }
}

export interface CodexInstallOptions extends CodexSourceOptions {
  /** npm.cmd, found on PATH. */
  npm: string;
  /** Where the .tgz waits between tries (the platform's folder, downloads\codex). */
  downloadsDir: string;
  onProgress?: (p: InstallProgress) => void;
  /** Runs npm (tests stand in for it). */
  run?: InstallRunner;
  /** The environment npm runs with. */
  runEnv?: Env;
  stallMs?: number;
  retryDelaysMs?: number[];
  signal?: AbortSignal;
}

/**
 * Installs (or updates to) `version` from `from`: npm's sha512, download, check, `npm cache add`, `npm install -g`. Throws
 * InstallError with what went wrong in words; a broken download's .part stays, so 再点一次 goes on.
 */
export async function installCodex(version: string, from: InstallFrom, o: CodexInstallOptions): Promise<{ version: string; from: InstallFrom; out: string }> {
  const fetchFn = o.fetch ?? fetch;
  const registry = (o.registry ?? NPM_REGISTRY).replace(/\/+$/, "");
  const platform = machinePlatform(o.env);
  if (!VERSION.test(version)) throw new InstallError(`版本号不对：${version}`);
  if (from === "server" && !o.account) throw new InstallError("没登录团队服务器，从团队服务器装不了：在「账号」里登录，或者从官方装。");
  const progress = (phase: InstallProgress["phase"], done = 0, total: number | null = null) => o.onProgress?.({ phase, from, done, total });
  const name = `codex-${version}-${platform}.tgz`;

  // 1. What the file must be: npm's sha512 first; the server's record of it only when npm cannot be reached.
  progress("manifest");
  let integrity = await npmIntegrity(registry, version, platform, fetchFn);
  if (!integrity && from === "server") {
    const ready = serverReady(await mirrorInfo("codex", o.account, fetchFn), platform);
    const given = ready?.version === version ? ready.file.integrity : undefined;
    integrity = given && SHA512_INTEGRITY.test(given) ? given : null;
  }
  if (!integrity) throw new InstallError(`拿不到 ${CODEX_PACKAGE}@${version}-${platform} 的 sha512（npm${from === "server" ? "和团队服务器" : ""}都没连上），没法校验，先不装。`);

  // 2. The .tgz (a whole one left by a try whose npm step failed is used again; other versions' go).
  const tgz = join(o.downloadsDir, name);
  for (const f of existsSync(o.downloadsDir) ? readdirSync(o.downloadsDir) : []) if (f !== name && f.endsWith(".tgz")) rmSync(join(o.downloadsDir, f), { force: true });
  if (!(existsSync(tgz) && (await fileIntegrity(tgz)) === integrity)) {
    const auth: Record<string, string> = o.account ? { authorization: `Bearer ${o.account.key}` } : {};
    const part = await fetchPart({
      url: from === "server" ? `${o.account!.server}/platform/mirror/codex/${version}/${platform}/${name}` : `${registry}/@openai/codex/-/${name}`,
      headers: from === "server" ? auth : {},
      from,
      downloadsDir: o.downloadsDir,
      partName: `${name}.part`,
      fetch: fetchFn,
      ...(o.stallMs ? { stallMs: o.stallMs } : {}),
      ...(o.retryDelaysMs ? { retryDelaysMs: o.retryDelaysMs } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      onProgress: (done, total) => progress("downloading", done, total),
    });
    progress("verifying");
    if ((await fileIntegrity(part)) !== integrity) {
      rmSync(part, { force: true });
      throw new InstallError(`下好的文件和 npm 的 sha512 对不上，已经删掉，没有装。再点一次会重新下${from === "server" ? "；还是不对的话，告诉管理团队服务器的人" : ""}。`);
    }
    renameSync(part, tgz);
  }

  // 3. Into npm's cache, then npm installs the version, taking the big package from there.
  progress("installing");
  const run = o.run ?? runInstaller;
  const env = o.runEnv ?? o.env;
  const added = await run(o.npm, ["cache", "add", tgz], env);
  if (!added.ok) throw new InstallError(`文件已经下好、校验过了，但 npm cache add 没成功${outputTail(added.out) ? "：\n" + outputTail(added.out) : ""}`);
  const installed = await run(o.npm, ["install", "-g", `${CODEX_PACKAGE}@${version}`, "--no-fund", "--no-audit"], env);
  if (!installed.ok) {
    const tail = outputTail(installed.out);
    throw new InstallError(`文件已经下好、校验过了，但 npm install -g ${CODEX_PACKAGE}@${version} 没成功（${installed.reason === "timeout" ? "等了 5 分钟还没做完" : "出错"}）${tail ? "：\n" + tail : ""}`);
  }
  rmSync(tgz, { force: true });
  return { version, from, out: installed.out };
}
