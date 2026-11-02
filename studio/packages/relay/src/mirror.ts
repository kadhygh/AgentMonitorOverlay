import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DownloadError, resumeDownload, unpackZstd } from "@amo-studio/locate/download";
import { VERSION } from "./platform.js";
import { RelayError } from "./store.js";

// Claude Code 镜像 on the team server (plans/claude-code-mirror.md; the user, 2026-11-02/03). Installing Claude Code
// from Anthropic means one 335 MB download that starts over when the line drops; the service checks Anthropic's `latest`
// every hour, downloads the new version's .zst (122 MB) in the background, going on after a break (Range) and trying
// again, unpacks it to check it against the official manifest (sha256 and size of the exe), and only then hands it out on
// the LAN, where AMO 平台 installs from it. The newest 3 ready versions are kept. Settings on the admin page.
//
// Files, all under <data>/mirror (deploy never touches the data folder):
//   settings.json                                   { "claude-code": MirrorSettings }
//   claude-code/index.json                          the ready versions, the last check (what the admin page shows)
//   claude-code/<version>/manifest.json             Anthropic's manifest, as it came
//   claude-code/<version>/<platform>/claude.exe.zst  only there once it is checked; claude.exe.zst.part while it comes

export const CLAUDE_CODE = "claude-code";
export const CLAUDE_OFFICIAL = "https://downloads.claude.ai/claude-code-releases";
/** The Windows builds the mirror can keep (the platform installs on Windows); x64 by default (the user, 2026-11-03). */
export const MIRROR_PLATFORMS = ["win32-x64", "win32-arm64"] as const;
export type MirrorPlatform = (typeof MIRROR_PLATFORMS)[number];
const BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface MirrorSettings {
  enabled: boolean;
  /** Minutes between checks of Anthropic's latest. */
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
  /** The file's name under <version>/<platform>/ (claude.exe.zst). */
  file: string;
  /** The .zst's bytes. */
  size: number;
  /** The unpacked exe's sha256 and size, from Anthropic's manifest (and checked). */
  sha256: string;
  exeSize: number;
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
  /** Anthropic's latest as the last check saw it. */
  official: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  /** What went wrong last; cleared by a check that got everything. */
  error: string | null;
  progress: MirrorProgress | null;
}

/** The admin page's card. */
export interface MirrorAdminView {
  settings: MirrorSettings;
  status: MirrorStatus;
  /** Ready versions, newest first. */
  versions: MirrorVersion[];
}

/** What AMO 平台 asks (GET /api/platform/mirror/claude-code). */
export interface MirrorPlatformView {
  official: string | null;
  checkedAt: string | null;
  versions: MirrorVersion[];
  /** A version on its way here, with how far it is. */
  preparing: { version: string; platform: MirrorPlatform; done: number; total: number | null } | null;
}

export interface MirrorOptions {
  /** <data>/mirror. */
  dir: string;
  /** Anthropic's release base (tests: a fake). */
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

interface OfficialManifest {
  version?: unknown;
  platforms?: Record<string, { binary?: unknown; checksum?: unknown; size?: unknown } | undefined>;
}

export class ClaudeCodeMirror {
  readonly dir: string;
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

  constructor(private readonly opts: MirrorOptions) {
    this.dir = resolve(opts.dir);
    this.root = join(this.dir, CLAUDE_CODE);
    mkdirSync(this.root, { recursive: true });
    this.base = (opts.base ?? CLAUDE_OFFICIAL).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    const saved = readJson<Record<string, unknown>>(join(this.dir, "settings.json"));
    try {
      this.settingsNow = checkMirrorSettings(saved?.[CLAUDE_CODE]);
    } catch {
      this.settingsNow = { ...DEFAULT_MIRROR_SETTINGS };
    }
    const index = readJson<{ versions?: MirrorVersion[]; official?: string | null; checkedAt?: string | null; error?: string | null }>(join(this.root, "index.json"));
    // Only versions whose files are still there.
    this.versions = (index?.versions ?? []).filter((v) => VERSION.test(v.version) && Object.entries(v.platforms).every(([p, f]) => f && BINARY.test(f.file) && existsSync(join(this.root, v.version, p, f.file))));
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
    writeJson(join(this.dir, "settings.json"), { ...all, [CLAUDE_CODE]: next });
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
    if (!this.settingsNow.enabled) return Promise.reject(new RelayError("conflict", "镜像关着：先打开它"));
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
    return { settings: this.settings(), status: this.statusView(), versions: this.versions.map((v) => ({ ...v })) };
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

  /** Anthropic's manifest of a ready version, as it came. */
  manifestFile(version: string): string | null {
    if (!this.versions.some((x) => x.version === version)) return null;
    const path = this.inside(version, "manifest.json");
    return path && existsSync(path) ? path : null;
  }

  /** A path under claude-code/, never outside it. */
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
    this.opts.log?.(`[镜像] ${line}`);
  }

  private saveIndex(): void {
    writeJson(join(this.root, "index.json"), { official: this.status.official, checkedAt: this.status.checkedAt, error: this.status.error, versions: this.versions });
  }

  private async getText(url: string): Promise<string> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]);
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal });
    } catch (err) {
      throw new Error(`连不上 ${new URL(url).host}（${err instanceof Error && err.cause instanceof Error ? err.cause.message : errText(err)}）`);
    }
    if (!res.ok) throw new Error(`${url} 回了 ${res.status}`);
    return res.text();
  }

  private async run(): Promise<void> {
    if (this.abort.signal.aborted && !this.closed) this.abort = new AbortController();
    this.status.state = "checking";
    let failed: string | null = null;
    try {
      const official = (await this.getText(`${this.base}/latest`)).trim();
      if (!VERSION.test(official)) throw new Error(`官方的 latest 不像版本号：${official.slice(0, 40)}`);
      this.status.official = official;
      const have = this.versions.find((v) => v.version === official);
      const missing = this.settingsNow.platforms.filter((p) => !have?.platforms[p]);
      if (missing.length) {
        const manifest = await this.manifest(official);
        for (const platform of missing) {
          if (this.abort.signal.aborted) break;
          try {
            await this.fetchPlatform(official, platform, manifest);
          } catch (err) {
            if (this.abort.signal.aborted) break;
            failed = `${official} ${platform}：${errText(err)}`;
            this.log(`没下好 ${failed}`);
          }
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

  /** The version's manifest: kept on disk once fetched (a later try of the same version uses it). */
  private async manifest(version: string): Promise<OfficialManifest> {
    const dir = join(this.root, version);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "manifest.json");
    const kept = readJson<OfficialManifest>(file);
    if (kept?.platforms) return kept;
    const text = await this.getText(`${this.base}/${version}/manifest.json`);
    let parsed: OfficialManifest;
    try {
      parsed = JSON.parse(text) as OfficialManifest;
    } catch {
      throw new Error(`${version} 的清单不是 JSON`);
    }
    if (parsed.version !== version || !parsed.platforms) throw new Error(`${version} 的清单不对（版本或平台缺了）`);
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
    return parsed;
  }

  private async fetchPlatform(version: string, platform: MirrorPlatform, manifest: OfficialManifest): Promise<void> {
    const entry = manifest.platforms?.[platform];
    const binary = typeof entry?.binary === "string" && BINARY.test(entry.binary) ? entry.binary : null;
    const sha256 = typeof entry?.checksum === "string" && /^[0-9a-f]{64}$/.test(entry.checksum) ? entry.checksum : null;
    const exeSize = typeof entry?.size === "number" && entry.size > 0 ? entry.size : null;
    if (!binary || !sha256 || !exeSize) throw new Error(`清单里没有 ${platform}`);
    const dir = join(this.root, version, platform);
    mkdirSync(dir, { recursive: true });
    const name = `${binary}.zst`;
    const final = join(dir, name);
    const part = `${final}.part`;
    const url = `${this.base}/${version}/${platform}/${name}`;
    const delays = this.opts.retryDelaysMs ?? [30_000, 60_000, 120_000, 240_000, 300_000];
    for (let attempt = 0; ; attempt++) {
      try {
        this.status.state = "downloading";
        this.speed = [];
        this.progress = { version, platform, done: 0, total: null, bytesPerSec: 0 };
        await resumeDownload(url, part, { fetch: this.fetchFn, signal: this.abort.signal, ...(this.opts.stallMs ? { stallMs: this.opts.stallMs } : {}), onProgress: (done, total) => this.onProgress(done, total) });
        this.status.state = "verifying";
        let got: { sha256: string; size: number };
        try {
          got = await unpackZstd(part);
        } catch (err) {
          rmSync(part, { force: true });
          throw new Error(`解压不了，已经删掉重下（${errText(err)}）`);
        }
        if (got.sha256 !== sha256 || got.size !== exeSize) {
          rmSync(part, { force: true });
          throw new Error("和官方清单对不上（sha256 或大小），已经删掉重下");
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
    const file: MirrorFile = { file: name, size: statSync(final).size, sha256, exeSize };
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
