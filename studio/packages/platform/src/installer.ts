import { createHash } from "node:crypto";
import { createReadStream, existsSync, linkSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readJsonFile, updateJsonFile, writeJsonFile } from "@amo-studio/account";
import type { Source } from "./client.js";
import { compareVersions, isToolId, isVersion, PlatformError, safeParts, type Manifest } from "./manifest.js";

// Installs, updates, rolls back and removes the tools (plans/amo-lan-platform.md, 「安装和更新怎么做」):
//   <apps>\<tool>\<version>\        one whole program folder per version, never changed in place
//   <apps>\<tool>\<version>.json    what the platform knows of it: the manifest, when installed, when last made current
//   <apps>\<tool>\current           a directory junction to the version in use (shortcuts point here)
// A new version is put together in <tool>\.partial-<version>-…: files this machine already has (same sha256) are
// hard-linked, the rest are downloaded and checked, and only then is the folder renamed to <version>.
// So a version folder exists only when it is complete — a failure half way leaves a .partial folder, which the next
// start or install removes. Then `current` is pointed at it and the oldest versions go, keeping the 2 last in use.
// A program running from the old folder is not touched: it keeps its files until it is restarted.
// programs.json (%APPDATA%\AMO) says for every installed tool where `current` is and its exe; other tools read it.
// apps\ is in the platform's folder (self-update.ts's root, 2026-10-28), which may be moved as a whole: the junctions
// keep absolute targets, so repair() points a `current` left on the old place at its version here again.
//
// Shared files (2026-10-29, plans/amo-lan-platform.md 「共用 Electron」): the platform's builds leave every tool's
// Electron files the same (321 MB of a 340–400 MB tool), so "already has" means any kept version of any tool, not only
// this tool's last one. file-index.json (in apps\, 2026-10-28) maps sha256 → the files here with that
// content, as paths relative to apps\. It is only a cache of the version records: rebuilt from them when it is missing
// or unreadable, and by repair(); every path is checked (there, a file, the manifest's size) before it is linked, and
// one that is not is dropped and the file downloaded instead. Each tool's folder holds only its own links: removing a
// version or uninstalling a tool removes its names, the other tools' names of the same files stay.

export interface VersionRecord {
  manifest: Manifest;
  installedAt: string;
  /** When `current` last pointed here: the 2 most recent stay, 回滚 goes to the other one. */
  activatedAt: string;
}

export interface InstalledVersion extends VersionRecord {
  version: string;
  dir: string;
  current: boolean;
}

export interface InstallProgress {
  phase: "manifest" | "linking" | "downloading" | "switching";
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  reused: number;
}

export interface InstallResult {
  version: string;
  previous: string | null;
  /** Files linked (or copied) from what this machine already had, any tool's. */
  reused: number;
  downloaded: number;
  /** The bytes of the files that had to be downloaded (as the manifest counts them, before gzip). */
  downloadedBytes: number;
  /** Already there: only `current` moved. */
  switchedOnly: boolean;
  /** Old version folders that could not be removed yet (a program still runs from them); tried again later. */
  leftover: string[];
}

export interface ProgramsFile {
  tools: Record<string, { version: string; dir: string; exe: string }>;
}

/** file-index.json: sha256 → { size, paths relative to apps\ (`studio/0.9.2/AMO Studio.exe`) }. */
export interface FileIndex {
  format: 1;
  files: Record<string, { size: number; paths: string[] }>;
}

const KEEP = 2;
const PARALLEL = 4;

export interface InstallerOptions {
  /** <the platform's folder>\apps (self-update.ts's root) */
  appsDir: string;
  /** %APPDATA%\AMO\programs.json */
  programsFile: string;
  /** The sha256 index of the files here (default: file-index.json in appsDir, so the platform's folder holds only its entry and apps\). */
  indexFile?: string;
  /** Whether a program runs from this tool's folder (uninstall refuses then). */
  isRunning?: (tool: string) => Promise<boolean>;
  now?: () => Date;
}

/** Removes a junction (or symlink) itself, never what it points to. */
function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class Installer {
  private readonly now: () => Date;
  /** file-index.json as last read or written; one Installer per process, so installs running side by side share it. */
  private index: FileIndex | null = null;

  constructor(private readonly options: InstallerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get appsDir(): string {
    return this.options.appsDir;
  }

  get indexFile(): string {
    return this.options.indexFile ?? join(this.options.appsDir, "file-index.json");
  }

  // ---- the sha256 index of the files here

  private loadIndex(): FileIndex {
    if (this.index) return this.index;
    const read = readJsonFile<FileIndex>(this.indexFile);
    if (read && read.format === 1 && read.files && typeof read.files === "object") return (this.index = read);
    return this.rebuildIndex();
  }

  /** Builds file-index.json again from the version records of every tool (what each kept version's folder holds). */
  rebuildIndex(): FileIndex {
    this.index = { format: 1, files: {} };
    for (const tool of this.tools()) for (const v of this.versions(tool)) this.indexAdd(tool, v.version, v.manifest.files);
    this.saveIndex();
    return this.index;
  }

  private indexAdd(tool: string, version: string, files: Manifest["files"]): void {
    const index = this.index ?? this.loadIndex();
    for (const f of files) {
      const rel = `${tool}/${version}/${f.path}`;
      const entry = index.files[f.sha256];
      if (!entry) index.files[f.sha256] = { size: f.size, paths: [rel] };
      else if (!entry.paths.includes(rel)) entry.paths.push(rel);
    }
  }

  /** Forgets every path under `prefix` (`studio/` or `studio/0.9.1/`). */
  private indexDrop(prefix: string): void {
    const index = this.loadIndex();
    for (const [sha, entry] of Object.entries(index.files)) {
      const paths = entry.paths.filter((p) => !p.startsWith(prefix));
      if (!paths.length) delete index.files[sha];
      else if (paths.length !== entry.paths.length) entry.paths = paths;
    }
  }

  private saveIndex(): void {
    if (this.index) writeJsonFile(this.indexFile, this.index);
  }

  /**
   * A file here with this content: the first of the index's paths that is still a file of the manifest's size (the
   * others are dropped from the index). Null when there is none.
   */
  private findHere(sha256: string, size: number): string | null {
    const index = this.loadIndex();
    const entry = index.files[sha256];
    if (!entry) return null;
    const alive = entry.paths.filter((rel) => {
      const parts = safeParts(rel);
      if (!parts) return false;
      try {
        const st = statSync(join(this.options.appsDir, ...parts));
        return st.isFile() && st.size === size;
      } catch {
        return false;
      }
    });
    if (!alive.length) delete index.files[sha256];
    else if (alive.length !== entry.paths.length) entry.paths = alive;
    return alive.length ? join(this.options.appsDir, ...safeParts(alive[0]!)!) : null;
  }

  toolDir(tool: string): string {
    if (!isToolId(tool)) throw new PlatformError("bad_data", `工具名不对：${tool}`);
    return join(this.options.appsDir, tool);
  }

  currentLink(tool: string): string {
    return join(this.toolDir(tool), "current");
  }

  /** The tools with a folder here. */
  tools(): string[] {
    if (!existsSync(this.options.appsDir)) return [];
    return readdirSync(this.options.appsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isToolId(d.name))
      .map((d) => d.name);
  }

  /** The version `current` points at, or null. */
  currentVersion(tool: string): string | null {
    const link = this.currentLink(tool);
    if (!exists(link)) return null;
    try {
      const v = basename(realpathSync(link));
      return existsSync(join(this.toolDir(tool), `${v}.json`)) ? v : null;
    } catch {
      return null;
    }
  }

  /** The complete versions here (folder and record both there), the most recently used first. */
  versions(tool: string): InstalledVersion[] {
    const dir = this.toolDir(tool);
    if (!existsSync(dir)) return [];
    const current = this.currentVersion(tool);
    const out: InstalledVersion[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      const version = e.name.slice(0, -5);
      if (!isVersion(version) || !existsSync(join(dir, version))) continue;
      const r = readJsonFile<VersionRecord>(join(dir, e.name));
      if (!r?.manifest || r.manifest.version !== version) continue;
      out.push({ ...r, version, dir: join(dir, version), current: version === current });
    }
    return out.sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : b.activatedAt.localeCompare(a.activatedAt) || compareVersions(b.version, a.version)));
  }

  /** Where 回滚 would go: the other kept version most recently in use. */
  rollbackTarget(tool: string): InstalledVersion | null {
    return this.versions(tool).find((v) => !v.current) ?? null;
  }

  /**
   * Cleans up after a run that stopped half way: a switch between removing `current` and renaming the new link, .partial
   * folders, version folders without a record (or records without a folder), and versions beyond the 2 kept.
   */
  repair(tool: string): void {
    const dir = this.toolDir(tool);
    if (!existsSync(dir)) {
      this.indexDrop(`${tool}/`);
      this.saveIndex();
      return;
    }
    const link = this.currentLink(tool);
    if (!exists(link) && exists(`${link}.next`)) renameSync(`${link}.next`, link);
    else if (exists(`${link}.next`)) removeLink(`${link}.next`);
    this.relink(tool);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.name.startsWith(".partial-") || e.name.endsWith(".tmp")) rmSync(p, { recursive: true, force: true, maxRetries: 3 });
      else if (e.isDirectory() && e.name !== "current" && isVersion(e.name) && !existsSync(`${p}.json`)) this.tryRemove(p);
      else if (e.isFile() && e.name.endsWith(".json") && !existsSync(p.slice(0, -5))) rmSync(p, { force: true });
    }
    this.prune(tool);
    this.syncPrograms(tool);
    // The index's entries for this tool, again from its records.
    this.indexDrop(`${tool}/`);
    for (const v of this.versions(tool)) this.indexAdd(tool, v.version, v.manifest.files);
    this.saveIndex();
  }

  /**
   * Installs `version` of `tool` from `source` and makes it current. Already installed (kept): only `current` moves.
   * `onProgress` is called as files are linked and bytes arrive.
   */
  async install(tool: string, version: string, source: Source, onProgress: (p: InstallProgress) => void = () => undefined): Promise<InstallResult> {
    if (!isVersion(version)) throw new PlatformError("bad_data", `版本号不对：${version}`);
    const dir = this.toolDir(tool);
    mkdirSync(dir, { recursive: true });
    const previous = this.currentVersion(tool);
    const progress: InstallProgress = { phase: "manifest", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, reused: 0 };
    const report = () => onProgress({ ...progress });
    report();

    const kept = this.versions(tool).find((v) => v.version === version);
    if (kept) {
      progress.phase = "switching";
      report();
      this.activate(tool, version);
      const leftover = this.prune(tool);
      this.saveIndex();
      return { version, previous, reused: 0, downloaded: 0, downloadedBytes: 0, switchedOnly: true, leftover };
    }

    const manifest = await source.manifest(tool, version);
    const target = join(dir, version);
    const partial = join(dir, `.partial-${version}-${process.pid}-${Date.now().toString(36)}`);
    try {
      mkdirSync(partial, { recursive: true });
      progress.totalFiles = manifest.files.length;
      progress.phase = "linking";
      report();

      // Files this machine has, by sha256, in any kept version of any tool (file-index.json; each path checked there and
      // of the manifest's size: a file someone changed by hand, or one gone since, is not reused).
      const have = new Map<string, string | null>();
      const findHere = (f: Manifest["files"][number]) => {
        if (!have.has(f.sha256)) have.set(f.sha256, this.findHere(f.sha256, f.size));
        return have.get(f.sha256)!;
      };

      /** A hard link; a copy when that fails (another volume, a file system without them, 1024 links). False when the file went away meanwhile. */
      const place = (from: string, to: string): boolean => {
        mkdirSync(dirname(to), { recursive: true });
        try {
          linkSync(from, to);
          return true;
        } catch {
          try {
            copyFileSync(from, to);
            return true;
          } catch {
            return false;
          }
        }
      };

      // Which objects to download (each once, even when several paths share it), and which paths wait for them.
      const missing = new Map<string, { size: number; paths: string[][] }>();
      for (const f of manifest.files) {
        const parts = safeParts(f.path)!;
        const from = findHere(f);
        if (from && place(from, join(partial, ...parts))) {
          progress.reused++;
          progress.doneFiles++;
          continue;
        }
        // Gone since it was looked up (another tool uninstalled meanwhile): downloaded like the rest.
        if (from) have.set(f.sha256, null);
        const m = missing.get(f.sha256);
        if (m) m.paths.push(parts);
        else missing.set(f.sha256, { size: f.size, paths: [parts] });
      }
      report();

      progress.phase = "downloading";
      progress.totalBytes = [...missing.values()].reduce((n, m) => n + m.size, 0);
      report();
      const queue = [...missing.entries()];
      let last = 0;
      const tick = () => {
        // At most ~20 reports a second, whatever the chunk size.
        const t = Date.now();
        if (t - last >= 50) {
          last = t;
          report();
        }
      };
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [sha, m] = next;
          const first = join(partial, ...m.paths[0]!);
          mkdirSync(dirname(first), { recursive: true });
          const tmp = `${first}.download`;
          let got = 0;
          await source.download(sha, tmp, (n) => {
            got += n;
            progress.doneBytes += n;
            tick();
          });
          const size = statSync(tmp).size;
          const actual = size === m.size ? await fileSha256(tmp) : null;
          if (actual !== sha) {
            const name = m.paths[0]!.join("/");
            throw new PlatformError("checksum", size !== m.size ? `${name} 下载得不完整（${size} / ${m.size} 字节），没有装。` : `${name} 下载下来和服务器清单对不上（sha256 不同），没有装。`);
          }
          // A short count from the server would leave the bar short: the file is right, so it is all there.
          progress.doneBytes += m.size - got;
          renameSync(tmp, first);
          progress.doneFiles++;
          for (const more of m.paths.slice(1)) {
            place(first, join(partial, ...more));
            progress.doneFiles++;
          }
          tick();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
      report();

      progress.phase = "switching";
      report();
      // A folder by this name without a record is a leftover from a run that stopped; a complete one was found above.
      if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      renameSync(partial, target);
    } catch (err) {
      rmSync(partial, { recursive: true, force: true, maxRetries: 3 });
      // Paths found missing on the way are forgotten all the same.
      this.saveIndex();
      throw err;
    }
    const at = this.now().toISOString();
    writeJsonFile(join(dir, `${version}.json`), { manifest, installedAt: at, activatedAt: at } satisfies VersionRecord);
    this.indexAdd(tool, version, manifest.files);
    this.activate(tool, version);
    const leftover = this.prune(tool);
    this.saveIndex();
    return { version, previous, reused: progress.reused, downloaded: manifest.files.length - progress.reused, downloadedBytes: progress.totalBytes, switchedOnly: false, leftover };
  }

  /** Points `current` back at the other kept version. */
  rollback(tool: string): { version: string; from: string | null } {
    const target = this.rollbackTarget(tool);
    if (!target) throw new PlatformError("nothing", "没有可以回去的上一版");
    const from = this.currentVersion(tool);
    this.activate(tool, target.version);
    return { version: target.version, from };
  }

  /** Removes every version and `current`, and the tool from programs.json. Refused while it runs. */
  async uninstall(tool: string, name = tool): Promise<void> {
    if (await this.options.isRunning?.(tool)) throw new PlatformError("running", `${name} 正在运行，先关掉它再卸载。`);
    const dir = this.toolDir(tool);
    const link = this.currentLink(tool);
    if (exists(link)) removeLink(link);
    if (exists(`${link}.next`)) removeLink(`${link}.next`);
    this.syncPrograms(tool);
    // Its own names of shared files go with its folder; the other tools' names of the same files stay.
    this.indexDrop(`${tool}/`);
    this.saveIndex();
    if (!existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      throw new PlatformError("io", `${name} 的文件夹没删干净（${err instanceof Error ? err.message : String(err)}），可能有程序还在用里面的文件。`);
    }
  }

  /**
   * `current` still aimed at the folder's old place (the platform's folder moved as a whole): pointed at the version of
   * the same name here, when that is here. A `current` aimed here, or at nothing known, is left as it is.
   */
  private relink(tool: string): void {
    const dir = this.toolDir(tool);
    const link = this.currentLink(tool);
    if (!exists(link)) return;
    let target: string;
    try {
      target = readlinkSync(link).replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
    } catch {
      return;
    }
    const version = basename(target);
    const here = join(dir, version);
    if (!isVersion(version) || resolve(target).toLowerCase() === here.toLowerCase() || !existsSync(here) || !existsSync(`${here}.json`)) return;
    const next = `${link}.next`;
    symlinkSync(here, next, "junction");
    removeLink(link);
    renameSync(next, link);
  }

  /** Makes `version` current: a new junction beside the old one, then swapped in by rename. */
  private activate(tool: string, version: string): void {
    const dir = this.toolDir(tool);
    const link = this.currentLink(tool);
    const next = `${link}.next`;
    if (exists(next)) removeLink(next);
    symlinkSync(join(dir, version), next, "junction");
    if (exists(link)) removeLink(link);
    renameSync(next, link);
    const recordFile = join(dir, `${version}.json`);
    updateJsonFile<VersionRecord>(recordFile, (r) => ({ ...r, activatedAt: this.now().toISOString() }));
    this.syncPrograms(tool);
  }

  /** Keeps the current version and the one used before it; removes the rest. Returns those still in use. */
  private prune(tool: string): string[] {
    const leftover: string[] = [];
    for (const v of this.versions(tool).slice(KEEP)) {
      if (this.tryRemove(v.dir)) {
        rmSync(`${v.dir}.json`, { force: true });
        this.indexDrop(`${tool}/${v.version}/`);
      } else leftover.push(v.version);
    }
    return leftover;
  }

  private tryRemove(dir: string): boolean {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      // A program still runs from it (Windows keeps its exe locked): it goes on a later install or start.
      return false;
    }
  }

  /** programs.json: the tool's entry follows `current` (gone when nothing is installed). Other tools' entries stay. */
  syncPrograms(tool: string): void {
    const version = this.currentVersion(tool);
    const record = version ? readJsonFile<VersionRecord>(join(this.toolDir(tool), `${version}.json`)) : null;
    const file = this.options.programsFile;
    if (!version && !existsSync(file)) return;
    updateJsonFile<ProgramsFile>(file, (p) => {
      const tools = { ...(p.tools ?? {}) };
      if (version && record) tools[tool] = { version, dir: this.currentLink(tool), exe: record.manifest.exe };
      else delete tools[tool];
      return { ...p, tools };
    });
  }
}
