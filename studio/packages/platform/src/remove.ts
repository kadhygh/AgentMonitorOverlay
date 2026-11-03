import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

// Removing the platform's folders (2026-11-03). Tried here with a running exe and hard links of it (the platform's
// folders are full of those: the tools share Electron's files, plans/amo-lan-platform.md 「共用 Electron」):
//                                        plain Node 24.22   the platform's Electron 44 (Node 24.21)
//   rmSync of a hard link of it          removes it         EPERM
//   unlinkSync of a hard link of it      removes it         removes it
//   unlinkSync of the running exe        EPERM              removes it
//   renaming the folder it runs from     works              works
// rmSync is what the installer used: in the platform it could not remove an old version a tool had used, nor a failed
// .partial, so they piled up (apps\platform kept 0.9.6 … 0.9.13) and the cleanup's error hid the real one. So removal
// goes file by file with unlink, rmSync where that fails. Unlink takes a running program as well: whoever removes a
// version folder first makes sure nothing runs from it (Installer.prune).
// A folder is first moved into apps\.trash, so its name is free at once (a version can be installed again, nothing
// half removed is taken for a version); what cannot be removed yet stays there and goes on a later start (emptyTrash).

/** apps\.trash: not a tool id (it starts with a dot), so the installer passes it by. */
export const TRASH = ".trash";

const kind = (p: string) => {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
};

/** Whether anything is at `p` (a broken junction counts). */
export function present(p: string): boolean {
  return kind(p) !== null;
}

/**
 * Removes `path` and all under it, as far as it goes, then throws the first error it could not get past (nothing when
 * all went). A junction or link inside is removed itself, never what it points to.
 */
export function removeTree(path: string): void {
  let first: unknown = null;
  const keep = (err: unknown) => void (first ??= err);
  const walk = (p: string) => {
    const k = kind(p);
    if (!k) return;
    if (k === "dir") {
      for (const name of readdirSync(p)) walk(join(p, name));
      try {
        rmdirSync(p);
      } catch (err) {
        keep(err);
      }
      return;
    }
    try {
      unlinkSync(p);
    } catch (err) {
      try {
        if (k === "link") rmdirSync(p);
        else rmSync(p, { force: true });
      } catch {
        keep(err);
      }
    }
  };
  walk(path);
  if (first) throw first;
}

/**
 * Takes `path` away: moved into `<appsDir>\.trash` and removed there (what cannot go yet stays for emptyTrash), or —
 * when it cannot be moved — removed in place as far as it goes. True when nothing is left at `path`.
 */
export function discard(path: string, appsDir: string): boolean {
  if (!present(path)) return true;
  const trash = join(appsDir, TRASH);
  const to = join(trash, `${basename(path)}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`);
  let moved = false;
  try {
    mkdirSync(trash, { recursive: true });
    renameSync(path, to);
    moved = true;
  } catch {
    // held (an antivirus scanning it) or on another volume: in place then
  }
  try {
    removeTree(moved ? to : path);
  } catch {
    // left for emptyTrash, or for the next repair
  }
  return !present(path);
}

/** Removes what apps\.trash still holds (and the folder once it is empty). Returns how many entries are left. */
export function emptyTrash(appsDir: string): number {
  const trash = join(appsDir, TRASH);
  if (kind(trash) !== "dir") return 0;
  let left = 0;
  for (const name of readdirSync(trash)) {
    try {
      removeTree(join(trash, name));
    } catch {
      left++;
    }
  }
  if (!left) {
    try {
      rmdirSync(trash);
    } catch {
      // something new arrived meanwhile
    }
  }
  return left;
}
