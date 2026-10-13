import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fuzzyMatch, type Id, type ProjectFile, type ProjectFiles } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";

/** Folders a walk never enters (only used when the project is not a git repository). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "bin", "obj", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", ".parcel-cache", "coverage", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  ".idea", ".vs", ".gradle", ".dart_tool", "Pods", "Library", "Temp", "Logs",
]);
/** A walk stops after this many files, or this deep. */
const WALK_FILES = 10_000;
const WALK_DEPTH = 16;
/** How long a listing is reused (typing in the selector asks again on every key). */
const CACHE_MS = 15_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Listing {
  source: "git" | "walk";
  /** Relative paths with forward slashes. */
  paths: string[];
  /** Walk only: size and modification time, read on the way. */
  stats: Map<string, { size: number; mtimeMs: number }>;
  partial: boolean;
}

/** Runs git read-only in the folder (no optional locks, so it never competes with the person's own git). */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

const zsplit = (out: string) => out.split("\0").filter(Boolean);

/**
 * A project's files for the file selector and "@ 文件": listed with git when the project is a repository (what git
 * tracks plus untracked files it does not ignore), otherwise by a bounded walk. Paths only go to the UI, which
 * references them by absolute path; nothing here reads file contents.
 */
export class FilesFeature extends Feature {
  private readonly cache = new Map<Id, { at: number; listing: Promise<Listing> }>();

  async list(workspaceId: Id, query: string, limitIn: unknown): Promise<ProjectFiles> {
    const ws = this.requireWorkspace(workspaceId);
    const listing = await this.listing(workspaceId, ws.path);
    const limit = clampLimit(limitIn, DEFAULT_LIMIT);
    let rows: Array<{ path: string; match?: number[] }>;
    let total: number;
    if (query.trim()) {
      const scored = listing.paths.flatMap((path) => {
        const m = fuzzyMatch(query, path);
        return m ? [{ path, score: m.score, match: m.indices }] : [];
      });
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      total = scored.length;
      rows = scored.slice(0, limit).map(({ path, match }) => ({ path, match }));
    } else {
      total = listing.paths.length;
      rows = listing.paths.slice(0, limit).map((path) => ({ path }));
    }
    const files = await Promise.all(rows.map(async (r) => ({ ...(await this.describe(ws.path, listing, r.path)), ...(r.match ? { match: r.match } : {}) })));
    return { root: ws.path, files, total, source: listing.source, partial: listing.partial };
  }

  /** git: the working tree's changes (staged or not, and untracked files); otherwise the newest files. */
  async recent(workspaceId: Id, limitIn: unknown): Promise<ProjectFiles> {
    const ws = this.requireWorkspace(workspaceId);
    const limit = clampLimit(limitIn, 8);
    const changes = await this.gitChanges(ws.path);
    if (changes) {
      const described = await Promise.all([...changes].map(async ([path, change]) => ({ ...(await this.describe(ws.path, null, path)), change })));
      const present = described.filter((f) => f.modifiedAt).sort((a, b) => b.modifiedAt!.localeCompare(a.modifiedAt!));
      return { root: ws.path, files: present.slice(0, limit), total: present.length, source: "git", partial: false };
    }
    const listing = await this.listing(workspaceId, ws.path, true);
    const newest = [...listing.stats.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, limit);
    const files = newest.map(([path, s]) => ({ path, size: s.size, modifiedAt: new Date(s.mtimeMs).toISOString(), change: "" }));
    return { root: ws.path, files, total: listing.stats.size, source: "walk", partial: listing.partial };
  }

  private listing(workspaceId: Id, root: string, fresh = false): Promise<Listing> {
    const cached = this.cache.get(workspaceId);
    if (cached && !fresh && Date.now() - cached.at < CACHE_MS) return cached.listing;
    const listing = this.gitFiles(root).then((paths) => (paths ? { source: "git" as const, paths, stats: new Map(), partial: false } : walk(root)));
    this.cache.set(workspaceId, { at: Date.now(), listing });
    listing.catch(() => this.cache.delete(workspaceId));
    return listing;
  }

  /** Null when the folder is not in a git repository (or git is not installed). */
  private async gitFiles(root: string): Promise<string[] | null> {
    try {
      const out = await git(root, ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      return [...new Set(zsplit(out))].sort((a, b) => a.localeCompare(b));
    } catch {
      return null;
    }
  }

  /** path → short status, relative to the project folder; null when it is not a git repository. */
  private async gitChanges(root: string): Promise<Map<string, string> | null> {
    let untracked: string[];
    try {
      untracked = zsplit(await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
    } catch {
      return null;
    }
    const changes = new Map<string, string>();
    // Against HEAD, so staged and unstaged changes both count; a repository without commits has none of these yet.
    const tracked = await git(root, ["diff", "--name-status", "--relative", "-z", "HEAD"]).catch(() => "");
    const parts = zsplit(tracked);
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i]!;
      // Renames and copies name the old path first, then the new one.
      if (/^[RC]/.test(status)) {
        changes.set(parts[i + 2]!, status[0]!);
        i += 2;
      } else {
        if (status !== "D") changes.set(parts[i + 1]!, status[0]!);
        i += 1;
      }
    }
    for (const path of untracked) changes.set(path, "??");
    return changes;
  }

  private async describe(root: string, listing: Listing | null, path: string): Promise<ProjectFile> {
    const known = listing?.stats.get(path);
    if (known) return { path, size: known.size, modifiedAt: new Date(known.mtimeMs).toISOString() };
    try {
      const s = await stat(join(root, path));
      return { path, size: s.size, modifiedAt: s.mtime.toISOString() };
    } catch {
      return { path, size: null, modifiedAt: null };
    }
  }
}

function clampLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : fallback;
}

/** Breadth first, so a bound cuts deep corners rather than whole top-level folders. */
async function walk(root: string): Promise<Listing> {
  const paths: string[] = [];
  const stats = new Map<string, { size: number; mtimeMs: number }>();
  let partial = false;
  let level: string[] = [""];
  for (let depth = 0; level.length && !partial; depth++) {
    if (depth >= WALK_DEPTH) {
      partial = true;
      break;
    }
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) next.push(rel);
        } else if (e.isFile()) {
          const s = await stat(join(root, rel)).catch(() => null);
          if (!s) continue;
          paths.push(rel);
          stats.set(rel, { size: s.size, mtimeMs: s.mtimeMs });
          if (paths.length >= WALK_FILES) {
            partial = true;
            break;
          }
        }
      }
      if (partial) break;
    }
    level = next;
  }
  paths.sort((a, b) => a.localeCompare(b));
  return { source: "walk", paths, stats, partial };
}
