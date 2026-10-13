import type { GitChangedFile, GitDiffLine, GitFileDiff, GitFileStatus, GitLineSide, GitRange, GitReviewComment, Session, StateSnapshot } from "@amo-studio/protocol";

// Pure logic of the Git Review window: its address, the file list, the rows of a diff, where comments sit, and the
// session the comments go to by default.

/** What a review window shows: a project, and the session comments go to unless another is picked. */
export interface ReviewTarget {
  workspaceId: string;
  sessionId?: string;
}

/** The window's address: `#review?workspace=…&session=…`. */
export function reviewHash(t: ReviewTarget): string {
  const q = new URLSearchParams({ workspace: t.workspaceId, ...(t.sessionId ? { session: t.sessionId } : {}) });
  return `#review?${q.toString()}`;
}

export function parseReviewHash(hash: string): ReviewTarget | null {
  if (!hash.startsWith("#review")) return null;
  const q = new URLSearchParams(hash.slice("#review".length).replace(/^\?/, ""));
  const workspaceId = q.get("workspace");
  if (!workspaceId) return null;
  const sessionId = q.get("session");
  return { workspaceId, ...(sessionId ? { sessionId } : {}) };
}

export const STATUS_LETTER: Record<GitFileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
export const STATUS_NAME: Record<GitFileStatus, string> = { added: "新增", modified: "修改", deleted: "删除", renamed: "改名" };

export interface FolderGroup {
  /** "" for the project folder itself. */
  folder: string;
  files: { file: GitChangedFile; name: string }[];
}

/** Files grouped by folder: the project's own files first, then folders by path; files keep their order. */
export function groupByFolder(files: readonly GitChangedFile[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const file of files) {
    const cut = file.path.lastIndexOf("/");
    const folder = cut < 0 ? "" : file.path.slice(0, cut);
    const group = groups.get(folder) ?? { folder, files: [] };
    group.files.push({ file, name: file.path.slice(cut + 1) });
    groups.set(folder, group);
  }
  return [...groups.values()].sort((a, b) => (a.folder === "" ? -1 : b.folder === "" ? 1 : a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/** The files in the order the list shows them (j / k walk this order). */
export const listOrder = (files: readonly GitChangedFile[]): GitChangedFile[] => groupByFolder(files).flatMap((g) => g.files.map((f) => f.file));

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
