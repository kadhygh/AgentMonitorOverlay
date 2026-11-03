import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DownloadError, fileIntegrity, resumeDownload, SHA512_INTEGRITY, unpackZstd } from "@amo-studio/locate/download";
import { VERSION } from "./platform.js";
import { RelayError } from "./store.js";

// 工具镜像 on the team server (plans/claude-code-mirror.md; the user, 2026-11-02/03). Installing Claude Code or Codex from
// their makers means one big download that starts over when the line drops; the service checks each one's latest every
// hour, downloads the new version in the background, going on after a break (Range) and trying again, checks it against
// what the maker publishes, and only then hands it out on the LAN, where AMO 平台 installs from it. The newest 3 ready
// versions are kept. Settings, per tool, on the admin page.
//
//   Claude Code: Anthropic's `latest`, the version's manifest.json, <platform>/claude.exe.zst (122 MB; the manifest gives
//                the unpacked exe's sha256 and size, so the .zst is unpacked to check it).
//   Codex:       npm's `latest` of @openai/codex, the platform package @openai/codex@<version>-<platform> (its
//                dist.integrity, sha512), codex-<version>-<platform>.tgz (180 MB) as npm has it: the platform puts it in
//                npm's cache and runs npm install (tried 2026-11-03: 5 s, the big file not fetched again).
//
// Files, all under <data>/mirror (deploy never touches the data folder):
//   settings.json                              { "claude-code": MirrorSettings, "codex": MirrorSettings }
//   <tool>/index.json                          the ready versions, the last check (what the admin page shows)
//   claude-code/<version>/manifest.json        Anthropic's manifest, as it came
//   <tool>/<version>/<platform>/<file>         only there once it is checked; <file>.part while it comes

export const CLAUDE_CODE = "claude-code";
export const CODEX = "codex";
export const MIRROR_TOOLS = [CLAUDE_CODE, CODEX] as const;
export type MirrorTool = (typeof MIRROR_TOOLS)[number];
export const CLAUDE_OFFICIAL = "https://downloads.claude.ai/claude-code-releases";
export const NPM_REGISTRY = "https://registry.npmjs.org";
/** The Windows builds the mirror can keep (the platform installs on Windows); x64 by default (the user, 2026-11-03). */
export const MIRROR_PLATFORMS = ["win32-x64", "win32-arm64"] as const;
export type MirrorPlatform = (typeof MIRROR_PLATFORMS)[number];
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MirrorSettings {
  enabled: boolean;
  /** Minutes between checks of the official latest. */
  everyMinutes: number;
  platforms: MirrorPlatform[];
  /** Ready versions kept, newest first. */
  keep: number;
}

export const DEFAULT_MIRROR_SETTINGS: MirrorSettings = { enabled: true, everyMinutes: 60, platforms: ["win32-x64"], keep: 3 };

/** `raw` over `base`, each field checked; a wrong one throws (the admin page shows the message). */
export function checkMirrorSettings(raw: unknown, base: MirrorSettings = DEFAULT_MIRROR_SETTINGS): MirrorSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...base, platforms: [...base.platforms] };
  const bad = (m: string) => new RelayError("bad_request", m);
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") throw bad("开关要是 true 或 false");
    out.enabled = o.enabled;
  }
  if (o.everyMinutes !== undefined) {
    const n = Number(o.everyMinutes);
    if (!Number.isInteger(n) || n < 10 || n > 1440) throw bad("检查间隔要是 10 到 1440 之间的整数（分钟）");
    out.everyMinutes = n;
  }
  if (o.platforms !== undefined) {
    if (!Array.isArray(o.platforms) || !o.platforms.length || o.platforms.some((p) => !MIRROR_PLATFORMS.includes(p as MirrorPlatform))) throw bad(`平台至少选一个，只能是 ${MIRROR_PLATFORMS.join("、")}`);
    out.platforms = MIRROR_PLATFORMS.filter((p) => (o.platforms as unknown[]).includes(p));
  }
  if (o.keep !== undefined) {
    const n = Number(o.keep);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw bad("保留几版要是 1 到 10 之间的整数");
    out.keep = n;
  }
  return out;
}

/** One platform's file of a ready version. */
export interface MirrorFile {
  /** The file's name under <version>/<platform>/ (claude.exe.zst, codex-<version>-<platform>.tgz). */
  file: string;
  /** Its bytes. */
  size: number;
  /** Claude Code: the unpacked exe's sha256 and size, from Anthropic's manifest (and checked). */
  sha256?: string;
  exeSize?: number;
  /** Codex: npm's dist.integrity of the .tgz (and checked). */
  integrity?: string;
}

export interface MirrorVersion {
  version: string;
  readyAt: string;
  platforms: Partial<Record<MirrorPlatform, MirrorFile>>;
}

export interface MirrorProgress {
  version: string;
  platform: MirrorPlatform;
  done: number;
  total: number | null;
  /** Over the last few seconds. */
  bytesPerSec: number;
}

export interface MirrorStatus {
  /** off: switched off; waiting: a try failed, the next one comes after a pause. */
  state: "off" | "idle" | "checking" | "downloading" | "verifying" | "waiting";
  /** The official latest as the last check saw it. */
  official: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  /** What went wrong last; cleared by a check that got everything. */
  error: string | null;
  progress: MirrorProgress | null;
}

/** One tool's card on the admin page. */
export interface MirrorAdminView {
  tool: MirrorTool;
  name: string;
  /** Where its latest comes from, in words. */
  officialFrom: string;
  settings: MirrorSettings;
  status: MirrorStatus;
  /** Ready versions, newest first. */
  versions: MirrorVersion[];
}

/** What AMO 平台 asks (GET /api/platform/mirror/<tool>). */
export interface MirrorPlatformView {
  official: string | null;
  checkedAt: string | null;
  versions: MirrorVersion[];
  /** A version on its way here, with how far it is. */
  preparing: { version: string; platform: MirrorPlatform; done: number; total: number | null } | null;
}

/** One platform's file of a version: where it comes from and how it is checked. */
export interface MirrorTarget {
  name: string;
  url: string;
  /** Recorded with it (and given to the platform). */
  info: Pick<MirrorFile, "sha256" | "exeSize" | "integrity">;
  /** Throws (the reason) when the downloaded file is not what the maker published. */
  check(file: string): Promise<void>;
}

interface SourceContext {
  base: string;
  get: (url: string) => Promise<string>;
  /** <tool>/<version>, there already. */
  dir: string;
}

/** What differs between the tools: where the latest is, what one platform's file is. */
export interface MirrorSource {
  tool: MirrorTool;
  name: string;
  officialFrom: string;
  base: string;
  latest(ctx: Omit<SourceContext, "dir">): Promise<string>;
  target(version: string, platform: MirrorPlatform, ctx: SourceContext): Promise<MirrorTarget>;
  /** A file of the version's own the platform may read (Claude Code: Anthropic's manifest). */
  metaFile?: string;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Writes JSON beside and renames it in, so a reader never sees half a file. */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}不是 JSON`);
  }
}

interface OfficialManifest {
  version?: unknown;
  platforms?: Record<string, { binary?: unknown; checksum?: unknown; size?: unknown } | undefined>;
}

export const CLAUDE_CODE_SOURCE: MirrorSource = {
  tool: CLAUDE_CODE,
  name: "Claude Code",
  officialFrom: "Anthropic 的 latest 通道",
  base: CLAUDE_OFFICIAL,
  metaFile: "manifest.json",
  async latest({ base, get }) {
    return (await get(`${base}/latest`)).trim();
  },
  async target(version, platform, { base, get, dir }) {
    // The manifest is kept once fetched: a later try of the same version, and the platform, use it.
    const file = join(dir, "manifest.json");
    let manifest = readJson<OfficialManifest>(file);
    if (!manifest?.platforms) {
      const text = await get(`${base}/${version}/manifest.json`);
      manifest = parseJson<OfficialManifest>(text, `${version} 的清单`);
      if (manifest.version !== version || !manifest.platforms) throw new Error(`${version} 的清单不对（版本或平台缺了）`);
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
    }
    const entry = manifest.platforms?.[platform];
    const binary = typeof entry?.binary === "string" && FILE_NAME.test(entry.binary) ? entry.binary : null;
    const sha256 = typeof entry?.checksum === "string" && /^[0-9a-f]{64}$/.test(entry.checksum) ? entry.checksum : null;
    const exeSize = typeof entry?.size === "number" && entry.size > 0 ? entry.size : null;
    if (!binary || !sha256 || !exeSize) throw new Error(`清单里没有 ${platform}`);
    const name = `${binary}.zst`;
    return {
      name,
      url: `${base}/${version}/${platform}/${name}`,
      info: { sha256, exeSize },
      async check(part) {
        let got: { sha256: string; size: number };
        try {
          got = await unpackZstd(part);
        } catch (err) {
          throw new Error(`解压不了（${errText(err)}）`);
        }
        if (got.sha256 !== sha256 || got.size !== exeSize) throw new Error("和官方清单对不上（sha256 或大小）");
      },
    };
  },
};

export const CODEX_SOURCE: MirrorSource = {
  tool: CODEX,
  name: "Codex",
  officialFrom: "npm 的 latest（@openai/codex）",
  base: NPM_REGISTRY,
  async latest({ base, get }) {
    const v = parseJson<{ version?: unknown }>(await get(`${base}/@openai%2fcodex/latest`), "npm 的 latest ").version;
    return typeof v === "string" ? v : "";
  },
  async target(version, platform, { base, get }) {
    // The platform package's own entry (a few KB; the whole package list is 5 MB and not needed here).
    const doc = parseJson<{ version?: unknown; dist?: { integrity?: unknown } }>(await get(`${base}/@openai%2fcodex/${version}-${platform}`), `@openai/codex@${version}-${platform} 的信息`);
    const integrity = typeof doc.dist?.integrity === "string" && SHA512_INTEGRITY.test(doc.dist.integrity) ? doc.dist.integrity : null;
    if (doc.version !== `${version}-${platform}` || !integrity) throw new Error(`npm 上没有 @openai/codex@${version}-${platform}（或没有 sha512）`);
    const name = `codex-${version}-${platform}.tgz`;
    return {
      name,
      url: `${base}/@openai/codex/-/${name}`,
      info: { integrity },
      async check(part) {
        if ((await fileIntegrity(part)) !== integrity) throw new Error("和 npm 的 sha512 对不上");
      },
    };
  },
};

export const MIRROR_SOURCES: Record<MirrorTool, MirrorSource> = { [CLAUDE_CODE]: CLAUDE_CODE_SOURCE, [CODEX]: CODEX_SOURCE };

export interface MirrorOptions {
  /** <data>/mirror. */
  dir: string;
  /** The official base (tests: a fake). */
  base?: string;
  fetch?: typeof fetch;
  /** No byte for this long = stalled (default 60 s). */
  stallMs?: number;
  /** The pauses between tries of one file (default 30 s, 1, 2, 4, 5 min: 6 tries). */
  retryDelaysMs?: number[];
  /** The first check after the service starts (default 30 s). */
  firstCheckMs?: number;
  log?: (line: string) => void;
}

const newerFirst = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

/** The mirrors of every tool, in <dir>; `bases` for tests. */
export function createMirrors(opts: Omit<MirrorOptions, "base"> & { bases?: Partial<Record<MirrorTool, string>> }): Record<MirrorTool, ToolMirror> {
  const { bases, ...rest } = opts;
  const one = (tool: MirrorTool) => new ToolMirror(MIRROR_SOURCES[tool], { ...rest, ...(bases?.[tool] ? { base: bases[tool] } : {}) });
  return { [CLAUDE_CODE]: one(CLAUDE_CODE), [CODEX]: one(CODEX) };
}

/** One tool's mirror: its timer, its check, its files under <dir>/<tool>. */
export class ToolMirror {
  readonly dir: string;
  readonly tool: MirrorTool;
  private readonly root: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private settingsNow: MirrorSettings;
  private versions: MirrorVersion[];
  private status: Omit<MirrorStatus, "state" | "nextCheckAt" | "progress"> & { state: Exclude<MirrorStatus["state"], "off"> };
  private progress: MirrorProgress | null = null;
  private speed: { at: number; done: number }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextAt: number | null = null;
  private running: Promise<void> | null = null;
  private abort = new AbortController();
  private closed = false;

  constructor(
    readonly source: MirrorSource,
    private readonly opts: MirrorOptions,
  ) {
    this.dir = resolve(opts.dir);
    this.tool = source.tool;
    this.root = join(this.dir, source.tool);
    mkdirSync(this.root, { recursive: true });
    this.base = (opts.base ?? source.base).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    const saved = readJson<Record<string, unknown>>(join(this.dir, "settings.json"));
    try {
      this.settingsNow = checkMirrorSettings(saved?.[source.tool]);
    } catch {
      this.settingsNow = { ...DEFAULT_MIRROR_SETTINGS };
    }
    const index = readJson<{ versions?: MirrorVersion[]; official?: string | null; checkedAt?: string | null; error?: string | null }>(join(this.root, "index.json"));
    // Only versions whose files are still there.
    this.versions = (index?.versions ?? []).filter((v) => VERSION.test(v.version) && Object.entries(v.platforms).every(([p, f]) => f && FILE_NAME.test(f.file) && existsSync(join(this.root, v.version, p, f.file))));
    this.status = { state: "idle", official: index?.official ?? null, checkedAt: index?.checkedAt ?? null, error: index?.error ?? null };
  }

  /** Starts the timer: the first check soon after the service starts, then every everyMinutes. */
  start(): void {
    this.schedule(this.opts.firstCheckMs ?? 30_000);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    if (this.closed || !this.settingsNow.enabled) return;
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => void this.checkNow().catch(() => undefined), ms);
    this.timer.unref?.();
  }

  settings(): MirrorSettings {
    return { ...this.settingsNow, platforms: [...this.settingsNow.platforms] };
  }

  /** Saves new settings; they count at once (switched on: a check soon; the timer follows the new interval). */
  saveSettings(raw: unknown): MirrorSettings {
    const next = checkMirrorSettings(raw, this.settingsNow);
    const all = readJson<Record<string, unknown>>(join(this.dir, "settings.json")) ?? {};
    writeJson(join(this.dir, "settings.json"), { ...all, [this.tool]: next });
    const wasOn = this.settingsNow.enabled;
    this.settingsNow = next;
    if (!next.enabled) {
      this.schedule(0);
      this.abort.abort();
    } else if (!this.running) this.schedule(wasOn && this.nextAt ? Math.max(0, Math.min(this.nextAt - Date.now(), next.everyMinutes * 60_000)) : 1000);
    return this.settings();
  }

  /** A check now (管理页「现在检查」); one already going is joined, not doubled. */
  checkNow(): Promise<void> {
    if (!this.settingsNow.enabled) return Promise.reject(new RelayError("conflict", `${this.source.name} 镜像关着：先打开它`));
    // While it runs there is no next time yet: it is set when this one ends.
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.running ??= this.run().finally(() => {
      this.running = null;
      this.schedule(this.settingsNow.everyMinutes * 60_000);
    });
    return this.running;
  }

  private statusView(): MirrorStatus {
    return {
      ...this.status,
      state: this.settingsNow.enabled ? this.status.state : this.running ? this.status.state : "off",
      nextCheckAt: this.nextAt ? new Date(this.nextAt).toISOString() : null,
      progress: this.progress ? { ...this.progress } : null,
    };
  }

  adminView(): MirrorAdminView {
    return { tool: this.tool, name: this.source.name, officialFrom: this.source.officialFrom, settings: this.settings(), status: this.statusView(), versions: this.versions.map((v) => ({ ...v })) };
  }

  platformView(): MirrorPlatformView {
    const p = this.progress;
    return { official: this.status.official, checkedAt: this.status.checkedAt, versions: this.versions.map((v) => ({ ...v })), preparing: p ? { version: p.version, platform: p.platform, done: p.done, total: p.total } : null };
  }

  /** A ready file for the platform to download, or null (also for names that fail their patterns). */
  file(version: string, platform: string): { path: string; size: number } | null {
    const v = this.versions.find((x) => x.version === version);
    const f = v?.platforms[platform as MirrorPlatform];
    if (!v || !f) return null;
    const path = this.inside(version, platform, f.file);
    return path && existsSync(path) ? { path, size: statSync(path).size } : null;
  }

  /** The version's own file (Claude Code: Anthropic's manifest, as it came) of a ready version. */
  metaFile(version: string, name: string): string | null {
    if (!this.source.metaFile || name !== this.source.metaFile || !this.versions.some((x) => x.version === version)) return null;
    const path = this.inside(version, name);
    return path && existsSync(path) ? path : null;
  }

  /** A path under <tool>/, never outside it. */
  private inside(...parts: string[]): string | null {
    const path = resolve(this.root, ...parts);
    return path.startsWith(this.root + sep) ? path : null;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.running?.catch(() => undefined);
  }

  // ---- one check

  private log(line: string): void {
    this.opts.log?.(`[${this.source.name} 镜像] ${line}`);
  }

  private saveIndex(): void {
    writeJson(join(this.root, "index.json"), { official: this.status.official, checkedAt: this.status.checkedAt, error: this.status.error, versions: this.versions });
  }

  private readonly get = async (url: string): Promise<string> => {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]);
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal });
    } catch (err) {
      throw new Error(`连不上 ${new URL(url).host}（${err instanceof Error && err.cause instanceof Error ? err.cause.message : errText(err)}）`);
    }
    if (!res.ok) throw new Error(`${url} 回了 ${res.status}`);
    return res.text();
  };

  private async run(): Promise<void> {
    if (this.abort.signal.aborted && !this.closed) this.abort = new AbortController();
    this.status.state = "checking";
    let failed: string | null = null;
    try {
      const official = await this.source.latest({ base: this.base, get: this.get });
      if (!VERSION.test(official)) throw new Error(`官方的 latest 不像版本号：${official.slice(0, 40)}`);
      this.status.official = official;
      const have = this.versions.find((v) => v.version === official);
      for (const platform of this.settingsNow.platforms.filter((p) => !have?.platforms[p])) {
        if (this.abort.signal.aborted) break;
        try {
          const dir = join(this.root, official);
          mkdirSync(dir, { recursive: true });
          await this.fetchPlatform(official, platform, await this.source.target(official, platform, { base: this.base, get: this.get, dir }));
        } catch (err) {
          if (this.abort.signal.aborted) break;
          failed = `${official} ${platform}：${errText(err)}`;
          this.log(`没下好 ${failed}`);
        }
      }
      this.prune();
    } catch (err) {
      failed = errText(err);
      this.log(`检查没成功：${failed}`);
    } finally {
      this.progress = null;
      this.status.state = "idle";
      if (!this.abort.signal.aborted) {
        this.status.checkedAt = new Date().toISOString();
        this.status.error = failed;
      }
      this.saveIndex();
    }
  }

  private async fetchPlatform(version: string, platform: MirrorPlatform, target: MirrorTarget): Promise<void> {
    if (!FILE_NAME.test(target.name)) throw new Error(`文件名不对：${target.name.slice(0, 60)}`);
    const dir = join(this.root, version, platform);
    mkdirSync(dir, { recursive: true });
    const final = join(dir, target.name);
    const part = `${final}.part`;
    const delays = this.opts.retryDelaysMs ?? [30_000, 60_000, 120_000, 240_000, 300_000];
    for (let attempt = 0; ; attempt++) {
      try {
        this.status.state = "downloading";
        this.speed = [];
        this.progress = { version, platform, done: 0, total: null, bytesPerSec: 0 };
        await resumeDownload(target.url, part, { fetch: this.fetchFn, signal: this.abort.signal, ...(this.opts.stallMs ? { stallMs: this.opts.stallMs } : {}), onProgress: (done, total) => this.onProgress(done, total) });
        this.status.state = "verifying";
        try {
          await target.check(part);
        } catch (err) {
          rmSync(part, { force: true });
          throw new Error(`${errText(err)}，已经删掉重下`);
        }
        renameSync(part, final);
        break;
      } catch (err) {
        if (this.abort.signal.aborted || attempt >= delays.length) throw err;
        const wait = delays[attempt]!;
        this.log(`${version} ${platform} 第 ${attempt + 1} 次没成功（${errText(err)}），${Math.round(wait / 1000)} 秒后接着下`);
        this.status.state = "waiting";
        this.status.error = `${version} ${platform}：${errText(err)}（${Math.round(wait / 1000)} 秒后接着下）`;
        await new Promise<void>((done) => {
          const t = setTimeout(done, wait);
          this.abort.signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
        });
        if (this.abort.signal.aborted) throw err instanceof DownloadError ? err : new Error(errText(err));
      }
    }
    const file: MirrorFile = { file: target.name, size: statSync(final).size, ...target.info };
    const at = new Date().toISOString();
    const v = this.versions.find((x) => x.version === version);
    if (v) v.platforms[platform] = file;
    else this.versions.push({ version, readyAt: at, platforms: { [platform]: file } });
    this.versions.sort((a, b) => newerFirst(a.version, b.version));
    this.saveIndex();
    this.log(`${version} ${platform} 已备好（${file.size} 字节）`);
  }

  private onProgress(done: number, total: number | null): void {
    if (!this.progress) return;
    const now = Date.now();
    this.speed.push({ at: now, done });
    while (this.speed.length > 2 && now - this.speed[0]!.at > 5000) this.speed.shift();
    const first = this.speed[0]!;
    const secs = (now - first.at) / 1000;
    this.progress = { ...this.progress, done, total, bytesPerSec: secs > 0.5 ? Math.round((done - first.done) / secs) : this.progress.bytesPerSec };
  }

  /** Keeps the newest `keep` ready versions; older folders go, and so do folders of versions never finished but older. */
  private prune(): void {
    const keep = this.versions.slice(0, this.settingsNow.keep);
    const gone = this.versions.slice(this.settingsNow.keep);
    this.versions = keep;
    const kept = new Set(keep.map((v) => v.version));
    const official = this.status.official;
    for (const name of readdirSync(this.root)) {
      if (!VERSION.test(name) || kept.has(name)) continue;
      // An unfinished newer one (the next try goes on from its .part) stays.
      if (official && name === official) continue;
      if (statSync(join(this.root, name)).isDirectory()) rmSync(join(this.root, name), { recursive: true, force: true });
    }
    for (const v of gone) this.log(`删掉旧版本 ${v.version}`);
  }
}
