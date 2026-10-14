import type { GitChangedFile, GitDiffLine, GitFileDiff, GitFileStatus, GitLineSide, GitRange, GitReviewComment, Session, StateSnapshot } from "@amo-studio/protocol";

// Pure logic of the Git Review window: its address, the file list, the rows of a diff, where comments sit, and the
// session the comments go to by default.

/** What a review window shows: a project, and the session comments go to unless another is picked. */
export interface ReviewTarget {
  workspaceId: string;
  sessionId?: string;
  /** Stage 13 (用 git diff 看): the file to select, absolute or relative to the project. */
  file?: string;
  /** Changes on every open with a file (the shell sets it), so asking for the same file again still selects it. */
  nonce?: string;
}

/** The window's address: `#review?workspace=…&session=…&file=…&n=…`. */
export function reviewHash(t: ReviewTarget): string {
  const q = new URLSearchParams({ workspace: t.workspaceId, ...(t.sessionId ? { session: t.sessionId } : {}) });
  if (t.file) q.set("file", t.file);
  if (t.file && t.nonce) q.set("n", t.nonce);
  return `#review?${q.toString()}`;
}

export function parseReviewHash(hash: string): ReviewTarget | null {
  if (!hash.startsWith("#review")) return null;
  const q = new URLSearchParams(hash.slice("#review".length).replace(/^\?/, ""));
  const workspaceId = q.get("workspace");
  if (!workspaceId) return null;
  const sessionId = q.get("session");
  const file = q.get("file");
  const nonce = q.get("n");
  return { workspaceId, ...(sessionId ? { sessionId } : {}), ...(file ? { file, ...(nonce ? { nonce } : {}) } : {}) };
}

/** The list's status icons, as in Fork: + added, M modified, − deleted, R renamed. */
export const STATUS_GLYPH: Record<GitFileStatus, string> = { added: "+", modified: "M", deleted: "−", renamed: "R" };
export const STATUS_NAME: Record<GitFileStatus, string> = { added: "新增", modified: "修改", deleted: "删除", renamed: "改名" };

/** Paths in the order Explorer and Fork list them: by full path, case aside. */
export const comparePaths = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** The 平铺 list's order (j / k walk this order): by full path. */
export const listOrder = (files: readonly GitChangedFile[]): GitChangedFile[] => [...files].sort((a, b) => comparePaths(a.path, b.path));

export type DiffMode = "changes" | "full";

export type DiffRow =
  | { kind: "hunk"; key: string; header: string; hidden: number }
  | { kind: "line"; key: string; line: GitDiffLine; side: GitLineSide; number: number };

/** Where a comment on this line points: the new file's line, or the old one for a deleted line. */
export function lineAnchor(line: GitDiffLine): { side: GitLineSide; number: number } {
  return line.newLine !== null ? { side: "new", number: line.newLine } : { side: "old", number: line.oldLine ?? 0 };
}

const lineRow = (line: GitDiffLine): DiffRow => {
  const a = lineAnchor(line);
  return { kind: "line", key: `${a.side}:${a.number}`, line, side: a.side, number: a.number };
};

/**
 * Rows to draw. "完整文件": every line. "只看改动": each hunk under its @@ header, which also says how many unchanged
 * lines were skipped before it.
 */
export function diffRows(diff: Pick<GitFileDiff, "lines" | "hunks">, mode: DiffMode): DiffRow[] {
  if (mode === "full") return diff.lines.map(lineRow);
  const rows: DiffRow[] = [];
  let shown = 0;
  diff.hunks.forEach((h, i) => {
    rows.push({ kind: "hunk", key: `hunk:${i}`, header: `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, hidden: h.start - shown });
    rows.push(...diff.lines.slice(h.start, h.end).map(lineRow));
    shown = h.end;
  });
  return rows;
}

/** Rows that start a run of changed lines: n / p jump between them. */
export function changeStarts(rows: readonly DiffRow[]): number[] {
  const starts: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind !== "line" || r.line.kind === "context") return;
    const prev = rows[i - 1];
    if (!prev || prev.kind !== "line" || prev.line.kind === "context") starts.push(i);
  });
  return starts;
}

/** The next (dir 1) or previous (-1) entry of a sorted list from `current`; stays at the ends. */
export function step(list: readonly number[], current: number, dir: 1 | -1): number | null {
  if (!list.length) return null;
  if (dir > 0) return list.find((x) => x > current) ?? list.at(-1)!;
  return [...list].reverse().find((x) => x < current) ?? list[0]!;
}

/**
 * Comments of one file split into the ones that sit under a shown row and the rest (lines outside the shown hunks, or
 * deleted lines commented in another range: their numbers belong to another old version).
 */
export function placeComments(comments: readonly GitReviewComment[], path: string, range: GitRange, rows: readonly DiffRow[]) {
  const keys = new Set(rows.filter((r) => r.kind === "line").map((r) => r.key));
  const placed = new Map<string, GitReviewComment[]>();
  const elsewhere: GitReviewComment[] = [];
  for (const c of comments) {
    if (c.path !== path) continue;
    const key = `${c.side}:${c.line}`;
    if (keys.has(key) && (c.side === "new" || c.range === range)) placed.set(key, [...(placed.get(key) ?? []), c]);
    else elsewhere.push(c);
  }
  return { placed, elsewhere };
}

/** Draft comments per file path. */
export function draftCounts(comments: readonly GitReviewComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of comments) if (c.state === "draft") counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
  return counts;
}

/** Sessions comments can go to: live sessions of the project, most recently active first. */
export function sessionChoices(state: Pick<StateSnapshot, "sessions" | "tasks" | "topics">, workspaceId: string): { id: string; label: string }[] {
  return state.sessions
    .filter((s) => s.workspaceId === workspaceId && !s.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((s) => {
      const owner = s.taskId ? state.tasks.find((t) => t.id === s.taskId)?.title || "未命名任务" : state.topics.find((t) => t.id === s.topicId)?.title || "专题";
      return { id: s.id, label: `${owner} · ${s.title || "新会话"}` };
    });
}

/** A task's session for Review: its most recently active main session. */
export function latestMainSession(sessions: readonly Session[], taskId: string): Session | null {
  return (
    sessions
      .filter((s) => s.taskId === taskId && !s.parentId && !s.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

/** "+12 −3", or the binary mark. */
export const countLabel = (f: Pick<GitChangedFile, "additions" | "deletions" | "binary">) => (f.binary ? "二进制" : `+${f.additions} −${f.deletions}`);
