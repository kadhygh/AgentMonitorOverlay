import { isCommon, type GitChangedFile, type Workspace } from "@amo-studio/protocol";

// Pure logic of the viewer window (查看器, stage 13): its address, which project a file belongs to, and which changed
// file in a Review is the one asked for.

export type ViewerMode = "file" | "changes";

/**
 * What a viewer window shows: a file (absolute, or relative to `workspaceId`), at a line or a range; or a 查看包
 * (`pack`, 2026-10-23: `path` is then "").
 */
export interface ViewerTarget {
  path: string;
  pack?: string;
  /** With `pack`: the item to show first (what the agent just added). */
  item?: string;
  workspaceId?: string;
  line?: number;
  endLine?: number;
  mode?: ViewerMode;
  /** The session whose conversation opened it (S14-A): where comments written here go by default. */
  sessionId?: string;
  /** Changes on every open (the shell sets it), so the same file opened again scrolls back to its line. */
  nonce?: string;
}

const int = (s: string | null): number | undefined => {
  const n = s ? Number(s) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** The window's address: `#viewer?path=…&workspace=…&line=…&end=…&mode=…&session=…&n=…` (as the shell builds it). */
export function viewerHash(t: ViewerTarget): string {
  if (t.pack) return `#viewer?${new URLSearchParams({ pack: t.pack, ...(t.item ? { item: t.item } : {}), ...(t.nonce ? { n: t.nonce } : {}) }).toString()}`;
  const q = new URLSearchParams({ path: t.path });
  if (t.workspaceId) q.set("workspace", t.workspaceId);
  if (t.line) {
    q.set("line", String(t.line));
    if (t.endLine && t.endLine > t.line) q.set("end", String(t.endLine));
  }
  if (t.mode === "changes") q.set("mode", "changes");
  if (t.sessionId) q.set("session", t.sessionId);
  if (t.nonce) q.set("n", t.nonce);
  return `#viewer?${q.toString()}`;
}

export function parseViewerHash(hash: string): ViewerTarget | null {
  if (!hash.startsWith("#viewer")) return null;
  const q = new URLSearchParams(hash.slice("#viewer".length).replace(/^\?/, ""));
  const pack = q.get("pack");
  if (pack) return { path: "", pack, ...(q.get("item") ? { item: q.get("item")! } : {}), ...(q.get("n") ? { nonce: q.get("n")! } : {}) };
  const path = q.get("path");
  if (!path) return null;
  const workspaceId = q.get("workspace");
  const line = int(q.get("line"));
  const end = int(q.get("end"));
  const nonce = q.get("n");
  const sessionId = q.get("session");
  return {
    path,
    ...(workspaceId ? { workspaceId } : {}),
    ...(line ? { line, ...(end && end > line ? { endLine: end } : {}) } : {}),
    ...(q.get("mode") === "changes" ? { mode: "changes" as const } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(nonce ? { nonce } : {}),
  };
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const isAbsolute = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith("/") || p.startsWith("\\");

/** `path` under `folder` (either slash, case aside), as a project-relative path with forward slashes; null if outside. */
export function relativeIn(path: string, folder: string): string | null {
  const p = norm(path);
  const f = norm(folder);
  if (!f || !p.startsWith(`${f}/`)) return null;
  return path.replace(/\\/g, "/").slice(f.length + 1);
}

/**
 * The project a file belongs to: the one named, when given and existing, else the innermost project folder that holds
 * an absolute path (the common space is not a project). Null for a file outside every project.
 */
export function projectOf(path: string, workspaces: readonly Workspace[], named?: string | null): Workspace | null {
  const byId = named ? workspaces.find((w) => w.id === named) : undefined;
  if (byId && (!isAbsolute(path) || relativeIn(path, byId.path) !== null)) return byId;
  if (!isAbsolute(path)) return byId ?? null;
  let best: Workspace | null = null;
  for (const w of workspaces) {
    if (isCommon(w) || relativeIn(path, w.path) === null) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best;
}

/** The changed file a Review was asked to show (`want` absolute, or relative to the project); null when unchanged. */
export function findChangedFile(files: readonly GitChangedFile[], want: string, projectPath: string): GitChangedFile | null {
  const rel = isAbsolute(want) ? relativeIn(want, projectPath) : want.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel === null) return null;
  const key = rel.toLowerCase();
  return files.find((f) => f.path.toLowerCase() === key) ?? files.find((f) => f.oldPath?.toLowerCase() === key) ?? null;
}

/** "第 12 行" / "第 12–20 行" / "". */
export function linesLabel(line?: number, endLine?: number): string {
  if (!line) return "";
  return endLine && endLine > line ? `第 ${line}–${endLine} 行` : `第 ${line} 行`;
}
