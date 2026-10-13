import type { GitChangedFile } from "@amo-studio/protocol";
import { listOrder } from "./logic.js";

// The file list of the review window (S12-A): a tree of folders (single-child chains compacted into one row, as in
// VS Code) or a flat list, names that stay readable when they are too long, and the list's remembered width.

export interface TreeFolder {
  kind: "folder";
  /** Full folder path ("src/components"); "" for the project folder. */
  path: string;
  /** What the row shows: one name, or a compacted chain ("src/components"). */
  name: string;
  folders: TreeFolder[];
  files: TreeFile[];
  /** Files anywhere below. */
  count: number;
}

export interface TreeFile {
  kind: "file";
  file: GitChangedFile;
  name: string;
}

const byName = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** The changed files as a folder tree: folders first, then files, each by name; chains of lone folders compacted. */
export function buildTree(files: readonly GitChangedFile[]): TreeFolder {
  const root: TreeFolder = { kind: "folder", path: "", name: "", folders: [], files: [], count: 0 };
  const index = new Map<string, TreeFolder>([["", root]]);
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop()!;
    let at = root;
    at.count++;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let next = index.get(path);
      if (!next) {
        next = { kind: "folder", path, name: part, folders: [], files: [], count: 0 };
        index.set(path, next);
        at.folders.push(next);
      }
      next.count++;
      at = next;
    }
    at.files.push({ kind: "file", file, name });
  }
  const tidy = (f: TreeFolder): TreeFolder => {
    // A folder holding only one folder becomes one row with it ("src/components").
    let folder = f;
    while (folder.path && !folder.files.length && folder.folders.length === 1) {
      const only = folder.folders[0]!;
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    folder.folders = folder.folders.map(tidy).sort((a, b) => byName(a.name, b.name));
    folder.files.sort((a, b) => byName(a.name, b.name));
    return folder;
  };
  return tidy(root);
}

export type TreeRow =
  | { kind: "folder"; key: string; folder: TreeFolder; depth: number; open: boolean }
  | { kind: "file"; key: string; file: GitChangedFile; name: string; depth: number };

/** The rows a tree shows: folders in `closed` keep their files hidden. */
export function treeRows(root: TreeFolder, closed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (folder: TreeFolder, depth: number) => {
    for (const sub of folder.folders) {
      const open = !closed.has(sub.path);
      rows.push({ kind: "folder", key: `d:${sub.path}`, folder: sub, depth, open });
      if (open) walk(sub, depth + 1);
    }
    for (const f of folder.files) rows.push({ kind: "file", key: f.file.path, file: f.file, name: f.name, depth });
  };
  walk(root, 0);
  return rows;
}

/** Every file in tree order, folded or not (j / k walk this; the selection opens its folders). */
export function treeOrder(root: TreeFolder): GitChangedFile[] {
  return treeRows(root, new Set()).flatMap((r) => (r.kind === "file" ? [r.file] : []));
}

/** The folders a path sits in, as tree paths ("a", "a/b"): opening them shows the file. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export type ListLayout = "tree" | "flat";

/** The files in the order the list shows them. */
export const fileOrder = (files: readonly GitChangedFile[], layout: ListLayout): GitChangedFile[] => (layout === "tree" ? treeOrder(buildTree(files)) : listOrder(files));

/**
 * A name split for a middle ellipsis: the head shrinks with "…" (CSS text-overflow), the tail always shows, so the
 * extension and the end of the name stay readable ("PlayerInventoryCont…roller.cs").
 */
export function splitName(name: string, keep = 6): { head: string; tail: string } {
  const dot = name.lastIndexOf(".");
  // ".gitignore" or a dot far from the end is no extension.
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  const stem = name.slice(0, name.length - ext.length);
  const tailOfStem = Math.min(keep, Math.max(0, stem.length - keep));
  const cut = stem.length - tailOfStem;
  return { head: name.slice(0, cut), tail: name.slice(cut) };
}

/** A folder path split the same way: its last folder always shows. */
export function splitFolder(folder: string): { head: string; tail: string } {
  const cut = folder.lastIndexOf("/");
  return cut < 0 ? { head: "", tail: folder } : { head: folder.slice(0, cut + 1), tail: folder.slice(cut + 1) };
}

export const LIST_WIDTH = { min: 180, max: 600, initial: 280 } as const;

export const clampWidth = (w: number) => Math.round(Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, Number.isFinite(w) ? w : LIST_WIDTH.initial)));

// The window's view choices, remembered on this machine (a per-viewer convenience: storage may be missing).
const PREFS_KEY = "amo.gitreview.prefs";

export interface ReviewPrefs {
  listWidth: number;
  layout: ListLayout;
  split: boolean;
  mode: "changes" | "full";
}

export const DEFAULT_PREFS: ReviewPrefs = { listWidth: LIST_WIDTH.initial, layout: "tree", split: false, mode: "changes" };

export function parsePrefs(raw: string | null): ReviewPrefs {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<ReviewPrefs>) : {};
    return {
      listWidth: clampWidth(typeof v.listWidth === "number" ? v.listWidth : LIST_WIDTH.initial),
      layout: v.layout === "flat" ? "flat" : "tree",
      split: v.split === true,
      mode: v.mode === "full" ? "full" : "changes",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function readPrefs(): ReviewPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePrefs(p: ReviewPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // per-viewer convenience only
  }
}
