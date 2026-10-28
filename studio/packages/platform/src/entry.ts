import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { readJsonFile, writeJsonFile } from "@amo-studio/account";
import { fileSha256 } from "./installer.js";
import { safeParts } from "./manifest.js";

// The entry: the platform's own files at the top of its folder — what the zip unpacked, <root>\AMO Platform.exe and its
// Electron files and resources\app — kept on the version the platform runs (self-update.ts). Run from
// <root>\apps\platform\<version>\ (forwarded by an older entry, or after 重启平台), the platform brings the entry up to
// its own version, so the next double-click opens it directly.
//
// Hard rules (2026-10-28):
//   - Only the version's manifest paths and the entry's own earlier files are touched; anything under apps\ never is (the
//     tools and the platform's versions), nor anything else in the folder (whatever the person keeps there).
//   - No file is ever written in place: the entry's files and the tools' Electron files are hard links of the same data,
//     so writing one would change them all. A new file is hard-linked (or copied, where links do not work) into a
//     staging folder, the old one moved out of the way into that folder, the new one moved in; the staging folder then
//     goes, and with it only those names.
//   - Only files whose content differs are touched (same size and sha256 as the manifest's: left alone, even when they
//     are copies, not links). Electron's files stay the same between versions, so an update moves a handful of files.
//     The real walkthrough (2026-10-28) is why: renaming every file of the entry to <name>.amo-old-… beside itself made
//     the antivirus here (火绒) take the platform for ransomware (ADV:Ransom/Genalocker.A) and quarantine its exe. Old
//     files keep their names in the staging folder (apps\.entry-…\old\…), no new extensions.
//   - resources\app\package.json goes last: it is the version the entry tells (the forwarding compares it), so an entry
//     left half way still reads as the old version and forwards to the new one.
//   - Any failure (a file in use, a full disk) puts back what was swapped and leaves the rest for the next start.
// <root>\apps\platform-entry.json records the files the entry was given, so a later version knows which old ones to
// remove. Before the first refresh there is none: then the old files are those of the entry's version when apps\platform
// still keeps it, else whatever is under resources\app (the program's own folder, nobody keeps files there).

export const ENTRY_RECORD = "platform-entry.json";
/** The entry's version file, swapped last (see above). */
const VERSION_FILE = "resources/app/package.json";
/** Staging folders in apps\ (not a tool id, so the installer passes them by). */
const STAGE_PREFIX = ".entry-";

export interface EntryRecord {
  version: string;
  files: string[];
}

export interface EntryRefresh {
  /** Files given the new version's content. */
  changed: number;
  /** Old files the new version does not have, removed. */
  removed: number;
  /** Why nothing changed this time (tried again at the next start), or null. */
  error: string | null;
}

export interface EntryFile {
  path: string;
  size: number;
  sha256: string;
}

const key = (p: string) => p.toLowerCase();
const underApps = (parts: string[]) => parts[0]!.toLowerCase() === "apps";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Both names are the same file (one hard-linked to the other). */
function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev && x.ino !== 0n;
  } catch {
    return false;
  }
}

/** Whether `dst` already has the manifest's content: the same file as `src`, or the same size and sha256. */
async function upToDate(src: string, dst: string, f: EntryFile): Promise<boolean> {
  if (sameFile(src, dst)) return true;
  try {
    const st = lstatSync(dst);
    if (!st.isFile() || st.size !== f.size) return false;
    return (await fileSha256(dst)) === f.sha256;
  } catch {
    return false;
  }
}

/** The version the entry tells: <root>\resources\app\package.json's, or null. */
export function entryVersion(root: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(root, ...VERSION_FILE.split("/")), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** Every file under <root>\resources\app, as `/` paths relative to root. */
function appFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(join(root, "resources", "app"));
  return out;
}

const readRecord = (root: string) => {
  const r = readJsonFile<EntryRecord>(join(root, "apps", ENTRY_RECORD));
  return r && typeof r.version === "string" && Array.isArray(r.files) ? { version: r.version, files: r.files.filter((f): f is string => typeof f === "string") } : null;
};

/**
 * The entry's files before this refresh: the record of the last one; else the manifest of the entry's version, when
 * apps\platform still has it (`manifestFiles`); else what is under resources\app.
 */
export function entryOldFiles(root: string, manifestFiles: (version: string) => string[] | null): string[] {
  const record = readRecord(root);
  if (record) return record.files;
  const version = entryVersion(root);
  return (version ? manifestFiles(version) : null) ?? appFiles(root);
}

/** Staging folders an earlier refresh could not remove (a file in use then). */
function removeStages(apps: string): void {
  let names: string[];
  try {
    names = readdirSync(apps);
  } catch {
    return;
  }
  for (const n of names)
    if (n.startsWith(STAGE_PREFIX))
      try {
        rmSync(join(apps, n), { recursive: true, force: true });
      } catch {
        // still in use: the next time
      }
}

/**
 * Brings the entry at `root` to the files of `versionDir` (a platform version folder; `files` its manifest's). The
 * caller only calls it from apps\platform (the entry is not running then). Never touches apps\ (but its own staging
 * folder and record) or files outside `files` and the entry's old files.
 */
export async function refreshEntry(o: { root: string; version: string; versionDir: string; files: readonly EntryFile[]; oldFiles: readonly string[] }): Promise<EntryRefresh> {
  const apps = join(o.root, "apps");
  // Done already (the record says so, and the entry tells this version): nothing to look at.
  if (readRecord(o.root)?.version === o.version && entryVersion(o.root) === o.version) return { changed: 0, removed: 0, error: null };
  removeStages(apps);

  const want: Array<{ parts: string[]; file: EntryFile }> = [];
  const wanted = new Set<string>();
  for (const f of o.files) {
    const parts = safeParts(f.path);
    if (!parts || underApps(parts) || wanted.has(key(f.path))) continue;
    wanted.add(key(f.path));
    want.push({ parts, file: f });
  }
  const stale = o.oldFiles.map((f) => safeParts(f)).filter((p): p is string[] => !!p && !underApps(p) && !wanted.has(key(p.join("/"))));

  // 1. What differs, each new file hard-linked into the staging folder: nothing the entry uses has changed yet.
  const stage = join(apps, `${STAGE_PREFIX}${process.pid.toString(36)}-${Date.now().toString(36)}`);
  const staged: Array<{ parts: string[]; dst: string; next: string; old: string }> = [];
  const dropStage = () => {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // a name still in use: removed at the next refresh (removeStages)
    }
  };
  try {
    for (const { parts, file } of want) {
      const src = join(o.versionDir, ...parts);
      const dst = join(o.root, ...parts);
      if (await upToDate(src, dst, file)) continue;
      const next = join(stage, "new", ...parts);
      mkdirSync(dirname(next), { recursive: true });
      try {
        linkSync(src, next);
      } catch {
        // No hard links here (FAT/exFAT, some network drives): a copy, still a new file of its own.
        copyFileSync(src, next, constants.COPYFILE_EXCL);
      }
      staged.push({ parts, dst, next, old: join(stage, "old", ...parts) });
    }
  } catch (err) {
    dropStage();
    return { changed: 0, removed: 0, error: message(err) };
  }
  // The version file last.
  staged.sort((a, b) => Number(key(a.parts.join("/")) === VERSION_FILE) - Number(key(b.parts.join("/")) === VERSION_FILE));

  // 2. Swapped by moves under their own names: the old file into the staging folder, the new one into its place. A
  //    failure puts back what was swapped.
  const done: Array<{ dst: string; next: string; old: string | null }> = [];
  try {
    for (const s of staged) {
      mkdirSync(dirname(s.dst), { recursive: true });
      let old: string | null = null;
      if (exists(s.dst)) {
        mkdirSync(dirname(s.old), { recursive: true });
        renameSync(s.dst, s.old);
        old = s.old;
      }
      try {
        renameSync(s.next, s.dst);
      } catch (err) {
        if (old) renameSync(old, s.dst);
        throw err;
      }
      done.push({ dst: s.dst, next: s.next, old });
    }
  } catch (err) {
    for (const d of done.reverse()) {
      try {
        renameSync(d.dst, d.next);
        if (d.old) renameSync(d.old, d.dst);
      } catch {
        // as far as it goes; the version file was not swapped, so the entry still forwards
      }
    }
    dropStage();
    return { changed: 0, removed: 0, error: message(err) };
  }

  // 3. The entry's old files the new version does not have, and the folders that leaves empty (never root, never apps\).
  let removed = 0;
  const emptied = new Set<string>();
  const kept: string[] = [];
  for (const parts of stale) {
    const p = join(o.root, ...parts);
    let isFile = false;
    try {
      isFile = lstatSync(p).isFile();
    } catch {
      continue; // gone already
    }
    if (!isFile) continue;
    try {
      unlinkSync(p);
      removed++;
      for (let d = dirname(p); d.length > o.root.length && key(d).startsWith(key(o.root + sep)); d = dirname(d)) emptied.add(d);
    } catch {
      // in use: kept in the record, so the next refresh tries again
      kept.push(parts.join("/"));
    }
  }
  for (const d of [...emptied].sort((a, b) => b.length - a.length))
    try {
      rmdirSync(d);
    } catch {
      // not empty
    }
  // The old names in the staging folder go with it (only names: the data stays wherever else it is linked).
  dropStage();

  try {
    writeJsonFile(join(apps, ENTRY_RECORD), { version: o.version, files: [...want.map((w) => w.parts.join("/")), ...kept] } satisfies EntryRecord);
  } catch {
    // without it the next refresh falls back to resources\app (entryOldFiles)
  }
  return { changed: done.length, removed, error: null };
}
