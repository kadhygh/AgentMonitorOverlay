import { isCommitRef, isObjectId, type GitChangedFile, type GitCommentRange, type GitDiffLine, type GitFileDiff, type GitFileStatus, type GitLineSide, type GitReviewComment, type Session, type StateSnapshot } from "@amo-studio/protocol";

// Pure logic of the Git Review window: its address, the file list, the rows of a diff, where comments sit, and the
// session the comments go to by default.

/**
 * What a review window shows: a project, and the session comments go to unless another is picked; or one commit of
 * the project's history (S13-B), read-only.
 */
export interface ReviewTarget {
  workspaceId: string;
  sessionId?: string;
  /** A commit's window: read-only. */
  commit?: string;
  /** Stage 13 (用 git diff 看): the file to select, absolute or relative to the project. */
  file?: string;
  /** Changes on every open with a file (the shell sets it), so asking for the same file again still selects it. */
  nonce?: string;
  /**
   * 外部打开 Review (2026-10-18): a full commit id to compare with — the working tree against it (the 本分支 view with
   * this base), or with `commit`, the commit against it. `baseLabel` is how the caller named it.
   */
  base?: string;
  baseLabel?: string;
}

/** The window's address: `#review?workspace=…&session=…&file=…&n=…`, or `#review?workspace=…&commit=…`. */
export function reviewHash(t: ReviewTarget): string {
  if (t.commit) return `#review?${new URLSearchParams({ workspace: t.workspaceId, commit: t.commit, ...(t.base ? { base: t.base } : {}), ...(t.file ? { file: t.file, ...(t.nonce ? { n: t.nonce } : {}) } : {}) }).toString()}`;
  const q = new URLSearchParams({ workspace: t.workspaceId, ...(t.sessionId ? { session: t.sessionId } : {}) });
  if (t.base) q.set("base", t.base);
  if (t.base && t.baseLabel) q.set("label", t.baseLabel);
  if (t.file) q.set("file", t.file);
  if (t.nonce) q.set("n", t.nonce);
  return `#review?${q.toString()}`;
}

export function parseReviewHash(hash: string): ReviewTarget | null {
  if (!hash.startsWith("#review")) return null;
  const q = new URLSearchParams(hash.slice("#review".length).replace(/^\?/, ""));
  const workspaceId = q.get("workspace");
  if (!workspaceId) return null;
  const commit = q.get("commit");
  const base = q.get("base");
  if (base !== null && !isObjectId(base)) return null;
  const sessionId = q.get("session");
  const file = q.get("file");
  const nonce = q.get("n");
  if (commit !== null) return isCommitRef(commit) ? { workspaceId, commit, ...(base ? { base } : {}), ...(file ? { file, ...(nonce ? { nonce } : {}) } : {}) } : null;
  const label = q.get("label");
  return { workspaceId, ...(sessionId ? { sessionId } : {}), ...(file ? { file } : {}), ...(nonce ? { nonce } : {}), ...(base ? { base, ...(label ? { baseLabel: label } : {}) } : {}) };
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
 * Tab between marked rows (2026-10-23: the commented lines; 重点 in a 查看包): the next one after `current` (before it
 * with `dir` -1), round to the first (the last) at the end; from nowhere, the first (the last).
 */
export function cycle(list: readonly number[], current: number | null, dir: 1 | -1): number | null {
  if (!list.length) return null;
  if (current === null) return dir > 0 ? list[0]! : list.at(-1)!;
  if (dir > 0) return list.find((x) => x > current) ?? list[0]!;
  return [...list].reverse().find((x) => x < current) ?? list.at(-1)!;
}

/** The next of `list` after `current`, round to the first: q through 工作区改动 / 本分支全部 / 已暂存. */
export const nextOf = <T,>(list: readonly T[], current: T): T => list[(list.indexOf(current) + 1) % list.length]!;

/**
 * Comments of one file split into the ones that sit under a shown row and the rest (lines outside the shown hunks, or
 * deleted lines commented in another range: their numbers belong to another old version).
 */
export function placeComments(comments: readonly GitReviewComment[], path: string, range: GitCommentRange, rows: readonly DiffRow[]) {
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
/**
 * The sessions 发给 offers: the project's, and `also` (外部打开 Review, 2026-10-18: the session the caller named may work in
 * another project).
 */
export function sessionChoices(state: Pick<StateSnapshot, "sessions" | "tasks" | "topics">, workspaceId: string, also?: string): { id: string; label: string }[] {
  return state.sessions
    .filter((s) => (s.workspaceId === workspaceId || s.id === also) && !s.archivedAt)
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

/** A line to keep in place when the rows are drawn another way (S14-A): which version, and its number there. */
export interface RowAnchor {
  side: GitLineSide;
  number: number;
}

/** `side:number` keys ("new:12") back to an anchor. */
export function parseRowKey(key: string): RowAnchor | null {
  const m = /^(new|old):(\d+)$/.exec(key);
  return m ? { side: m[1] as GitLineSide, number: Number(m[2]) } : null;
}

/**
 * The row to show the anchor at after 只看改动 / 完整文件 or 单栏 / 左右对照 (S14-A): the same line when it is drawn,
 * else the nearest drawn line of that version (a line outside the hunks lands on the closest one); null without lines.
 */
export function anchorRow(rows: readonly DiffRow[], anchor: RowAnchor): number | null {
  const key = `${anchor.side}:${anchor.number}`;
  let best: number | null = null;
  let distance = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind !== "line") continue;
    if (r.key === key) return i;
    // Old-side numbers only mean something next to other old numbers; new-side ones against the new file.
    const n = anchor.side === "old" ? r.line.oldLine : r.line.newLine;
    if (n === null) continue;
    const d = Math.abs(n - anchor.number);
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
}
