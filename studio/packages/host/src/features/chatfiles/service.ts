import { stat } from "node:fs/promises";
import path from "node:path";
import { MAX_EXISTS_PATHS, type ExistingPath, type FsExistsRequest, type FsExistsResult } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { git } from "../gitreview/git.js";

type PathApi = Pick<typeof path, "isAbsolute" | "join" | "normalize">;

/** How long a project's file list is reused for finding a path by its end (S18). */
const FILE_LIST_TTL_MS = 30_000;

/** A project's files (relative, `/`-separated) and the same in lower case, or null when it is not a git project. */
/** The project's files, lower-cased, and by lower-cased name (a match ends with the name written, 2026-10-20). */
type FileList = { files: string[]; lower: string[]; byName?: Map<string, number[]> } | null;

/** A file list with its name index. */
export function indexFiles(files: string[]): NonNullable<FileList> {
  const lower = files.map((f) => f.toLowerCase());
  const byName = new Map<string, number[]>();
  lower.forEach((f, i) => {
    const name = f.slice(f.lastIndexOf("/") + 1);
    const at = byName.get(name);
    if (at) at.push(i);
    else byName.set(name, [i]);
  });
  return { files, lower, byName };
}

/**
 * Files named in a conversation (stage 12, S12-C): tells which of the paths a reply, a tool row or a file chip names
 * exist, so the UI only links those. Never reads the files; network shares are not looked at (they can stall).
 */
export class ChatFilesFeature extends Feature {
  private readonly lists = new Map<string, { at: number; list: Promise<FileList> }>();

  async exists(input: Partial<FsExistsRequest>): Promise<FsExistsResult> {
    if (!Array.isArray(input.paths) || !input.paths.every((p) => typeof p === "string")) throw new HostError("bad_request", "paths must be a list of strings");
    if (input.paths.length > MAX_EXISTS_PATHS) throw new HostError("bad_request", `at most ${MAX_EXISTS_PATHS} paths at once`);
    let base: string | null = null;
    const project = typeof input.workspaceId === "string" && input.workspaceId ? this.requireWorkspace(input.workspaceId).path : null;
    if (typeof input.cwd === "string" && input.cwd.trim() && path.isAbsolute(input.cwd.trim())) base = input.cwd.trim();
    else base = project;
    const found: Record<string, ExistingPath | null> = {};
    await Promise.all(
      [...new Set(input.paths)].map(async (p) => {
        const abs = resolveMentioned(p, base);
        const info = abs ? await stat(abs).catch(() => null) : null;
        found[p] = abs && info ? { path: abs, dir: info.isDirectory() } : null;
      }),
    );
    // S18: a relative path that is not there from the project's folder may be written from somewhere inside it
    // ("路径相对 UnityProject/…/Simulation/" and then `System/…/X.cs:8`, or a bare `X.cs`): the one file of the
    // project whose path ends with it. Git projects only (their file list is quick to get); several matches link none.
    const root = project ?? base;
    const missing = Object.keys(found).filter((p) => !found[p] && relativeMention(p));
    if (root && missing.length) {
      const list = await this.fileList(root);
      if (list)
        await Promise.all(
          missing.map(async (p) => {
            const rel = findByEnd(p, list);
            if (!rel) return;
            const abs = path.normalize(path.join(root, rel));
            const info = await stat(abs).catch(() => null);
            if (info?.isFile()) found[p] = { path: abs, dir: false };
          }),
        );
    }
    return { found };
  }

  /** The project's files from git (tracked, and untracked ones not ignored), kept for a short while. */
  private fileList(root: string): Promise<FileList> {
    const now = Date.now();
    const hit = this.lists.get(root);
    if (hit && now - hit.at < FILE_LIST_TTL_MS) return hit.list;
    const list = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], 64 * 1024 * 1024)
      .then((out): FileList => {
        const files = out.split("\0").filter(Boolean);
        return indexFiles(files);
      })
      .catch((): FileList => null);
    for (const [k, v] of this.lists) if (now - v.at >= FILE_LIST_TTL_MS) this.lists.delete(k);
    this.lists.set(root, { at: now, list });
    return list;
  }
}

/** A relative path as a reply writes it (`a/b.cs`, `.\a\b.cs`, `b.cs`): not absolute, a URL, `~` or `../`. */
function relativeMention(written: string): boolean {
  const s = written.trim();
  return !!s && !/^[a-z][a-z\d+.-]*:/i.test(s) && !/^[\\/]{2}/.test(s) && !s.startsWith("~") && !/^\.\.[\\/]/.test(s);
}

/**
 * The one file of `list` whose path is `written` or ends with `/written` (any case, either slash), or null when none
 * or several do.
 */
export function findByEnd(written: string, list: NonNullable<FileList>): string | null {
  const w = written.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/^\//, "").toLowerCase();
  if (!w || w.endsWith("/")) return null;
  const tail = `/${w}`;
  let hit: string | null = null;
  // Only files of that name can end with it: a few, not every file of the project for every name looked up.
  const candidates = list.byName ? (list.byName.get(w.slice(w.lastIndexOf("/") + 1)) ?? []) : list.lower.keys();
  for (const i of candidates) {
    const f = list.lower[i]!;
    if (f !== w && !f.endsWith(tail)) continue;
    if (hit !== null) return null;
    hit = list.files[i]!;
  }
  return hit;
}

/**
 * Where a path written in a conversation points: absolute (also `file://…`) as is, relative ones from `base`; a path
 * starting with one slash and no drive (`/src/a.ts`) is taken as relative to `base` on Windows. Null for what cannot be
 * a local file: network paths, `~`, other URL schemes, relative paths without a base.
 */
export function resolveMentioned(written: string, base: string | null, p: PathApi = path, windows = process.platform === "win32"): string | null {
  let s = written.trim();
  if (!s || s.length > 1024 || /[\u0000-\u001f]/.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//i, ""));
    } catch {
      return null;
    }
    // file:///G:/a → G:/a; file:///home/a → /home/a
    if (/^\/[a-z]:[\\/]/i.test(s)) s = s.slice(1);
  }
  if (/^[\\/]{2}/.test(s) || s.startsWith("~") || (/^[a-z][a-z\d+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s))) return null;
  if (windows && /^[\\/]/.test(s)) return base ? p.normalize(p.join(base, s.slice(1))) : null;
  if (p.isAbsolute(s)) return p.normalize(s);
  return base ? p.normalize(p.join(base, s)) : null;
}
