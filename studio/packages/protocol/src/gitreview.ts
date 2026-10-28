// Git Review (stage 11, S11-D): a project's changes as git sees them, line comments on them, and the summary message
// that sends the comments to a session. Shared by the Host (git, storage, sending) and the UI (views, preview).
import type { Id } from "./entities.js";

/**
 * What a review compares:
 * - `working`: the working tree (staged, unstaged and untracked) against HEAD;
 * - `branch`: everything this branch changes: the working tree against the merge base with the default branch;
 * - `staged`: the index against HEAD.
 */
export type GitRange = "working" | "branch" | "staged";

export const GIT_RANGES: readonly { id: GitRange; label: string; hint: string }[] = [
  { id: "working", label: "工作区改动", hint: "暂存、未暂存和新文件，对比 HEAD" },
  { id: "branch", label: "本分支全部", hint: "本分支的提交加上工作区改动，对比和默认分支的合并基点" },
  { id: "staged", label: "已暂存", hint: "只看暂存区，对比 HEAD" },
];

export const isGitRange = (v: unknown): v is GitRange => GIT_RANGES.some((r) => r.id === v);

/**
 * Where a comment was written: a range of Git Review, or `file` (stage 14, S14-A): the viewer's 文件 mode, the file as
 * it is now, no diff; its lines are the file's (they show as new-side lines in Review too).
 */
export type GitCommentRange = GitRange | "file";

export const isCommentRange = (v: unknown): v is GitCommentRange => v === "file" || isGitRange(v);

/** A project folder as git sees it. Paths in a review are relative to the project folder, which may sit inside the repository. */
export interface GitStatus {
  repo: boolean;
  /** Why there is nothing to review when `repo` is false ("不是 git 仓库", git missing…). */
  reason?: string;
  /** The repository's top folder, as git prints it. */
  root?: string;
  /** Current branch; null when HEAD is detached. */
  branch: string | null;
  /** HEAD's commit; null in a repository without commits. */
  head: string | null;
  /** The branch's upstream (e.g. `origin/feature`), if it has one. */
  upstream: string | null;
  /** The default branch `branch` compares with: origin/HEAD, else main or master. */
  base: string | null;
  /** Where this branch left `base`; null without a base or commits. */
  mergeBase: string | null;
}

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface GitChangedFile {
  /** Path relative to the project folder, with forward slashes. */
  path: string;
  /** Renames: where it came from. */
  oldPath?: string;
  status: GitFileStatus;
  /** A new file git does not track yet. */
  untracked?: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** git's empty tree: what a repository without commits is compared with. */
export const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The commit (or tree) a range compares with: HEAD, or the merge base for `branch`. */
export function rangeBase(range: GitRange, status: GitStatus): string {
  const head = status.head ?? GIT_EMPTY_TREE;
  return range === "branch" ? (status.mergeBase ?? head) : head;
}

/** A full object id (SHA-1 or SHA-256), as `?base=` takes it. */
export const isObjectId = (v: unknown): v is string => typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);

export interface GitChanges {
  status: GitStatus;
  range: GitRange;
  files: GitChangedFile[];
  /** More files changed than are listed. */
  truncated: boolean;
}

export type GitDiffLineKind = "context" | "add" | "del";

/** One line of a file diff: unchanged lines carry both numbers, added lines only the new one, deleted ones the old. */
export interface GitDiffLine {
  kind: GitDiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** A block of `lines` around changes ("只看改动"): `[start, end)` indexes, and the @@ numbers it covers. */
export interface GitDiffHunk {
  start: number;
  end: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface GitFileDiff {
  /** The range of a working-tree diff; a commit's diff (`commit` set) says `working` and means nothing by it. */
  range: GitRange;
  /** A commit's diff (S13-B): the commit's full id. */
  commit?: string;
  path: string;
  oldPath?: string;
  binary: boolean;
  /** Too large to show; `lines` is empty. */
  tooLarge: boolean;
  /** The whole new file, each line unchanged or added, with deleted lines where they were ("完整文件"). */
  lines: GitDiffLine[];
  /** The changes with a few lines around them ("只看改动"). */
  hunks: GitDiffHunk[];
}

/** Lines of context kept around changes in "只看改动". */
export const DIFF_CONTEXT = 3;

/** Groups the changed lines of a full-file diff into hunks with `context` unchanged lines around them. */
export function diffHunks(lines: readonly GitDiffLine[], context = DIFF_CONTEXT): GitDiffHunk[] {
  const spans: { start: number; end: number }[] = [];
  lines.forEach((l, i) => {
    if (l.kind === "context") return;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length, i + context + 1);
    const last = spans.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  });
  return spans.map(({ start, end }) => {
    const part = lines.slice(start, end);
    const oldCount = part.filter((l) => l.oldLine !== null).length;
    const newCount = part.filter((l) => l.newLine !== null).length;
    // As in unified diff headers: an empty side names the line before it.
    const before = (pick: (l: GitDiffLine) => number | null) => {
      for (let i = start - 1; i >= 0; i--) {
        const n = pick(lines[i]!);
        if (n !== null) return n;
      }
      return 0;
    };
    const oldStart = part.find((l) => l.oldLine !== null)?.oldLine ?? before((l) => l.oldLine);
    const newStart = part.find((l) => l.newLine !== null)?.newLine ?? before((l) => l.newLine);
    return { start, end, oldStart, oldCount, newStart, newCount };
  });
}

/** Which version a commented line belongs to: the new file, or the old one for deleted lines. */
export type GitLineSide = "new" | "old";

/** A comment on one line of a reviewed file. Drafts can be edited; sending freezes them. */
export interface GitReviewComment {
  id: Id;
  workspaceId: Id;
  /** The range it was written in (old-side line numbers depend on it); `file` in the viewer (always new side). */
  range: GitCommentRange;
  path: string;
  side: GitLineSide;
  line: number;
  /** The line as it was when commented. */
  lineText: string;
  note: string;
  state: "draft" | "sent";
  /** The session it was sent to. */
  sessionId: Id | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  /** Written on the file as shown rendered (Markdown, HTML) rather than on a line; `line` is where it starts in the source, best guess. */
  passage?: GitCommentPassage;
}

/**
 * 渲染批注 (2026-10-28): a passage of a file shown rendered in the viewer — Markdown, or HTML in its frame. Its words and
 * up to PASSAGE_CONTEXT characters on each side, as read on screen with whitespace runs as one space; found again by
 * those, so it survives the file being regenerated as long as the words are still there.
 */
export interface GitCommentPassage {
  quote: string;
  prefix: string;
  suffix: string;
  /** An HTML file's Markdown source (relative to the project), when it has one: the changes go there. */
  source?: string;
}

export const PASSAGE_CONTEXT = 24;

export interface NewGitReviewComment {
  range: GitCommentRange;
  path: string;
  side: GitLineSide;
  line: number;
  lineText: string;
  note: string;
  passage?: GitCommentPassage;
}

/** Longest line kept in the summary message; the rest is elided. */
export const GIT_REVIEW_LINE_LIMIT = 300;

/** Where a comment points, as the message names it: `path:line`, or the old line of a deleted one. */
export const commentWhere = (c: Pick<GitReviewComment, "path" | "side" | "line">): string =>
  c.side === "old" ? `${c.path}（旧版第 ${c.line} 行，已删除）` : `${c.path}:${c.line}`;

/** Comments in message order: by file, then by line (new-side lines first where both sides share a number). */
export function sortComments<T extends Pick<GitReviewComment, "path" | "side" | "line" | "createdAt">>(comments: readonly T[]): T[] {
  return [...comments].sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || (a.side === b.side ? 0 : a.side === "new" ? -1 : 1) || a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * The user message that sends Git Review comments to a session, grouped by file. Shared by Host (sending) and UI
 * (preview). `project` names the reviewed project.
 */
export function composeGitReviewMessage(
  comments: ReadonlyArray<Pick<GitReviewComment, "path" | "side" | "line" | "lineText" | "note" | "createdAt"> & { range?: GitCommentRange; passage?: GitCommentPassage | undefined }>,
  project?: string,
): string {
  const files = new Map<string, typeof comments[number][]>();
  for (const c of sortComments(comments)) files.set(c.path, [...(files.get(c.path) ?? []), c]);
  const parts = [...files].map(([path, list]) => {
    const body = list.map((c) => {
      const raw = (c.passage?.quote ?? c.lineText).replace(/\s+$/, "");
      const text = raw.length > GIT_REVIEW_LINE_LIMIT ? `${raw.slice(0, GIT_REVIEW_LINE_LIMIT)}…` : raw;
      const where = c.passage ? `${c.path}（渲染后的段落，源码约第 ${c.line} 行）` : commentWhere(c);
      return `${where}\n> ${text || "（空行）"}\n${c.note.trim()}`;
    });
    // HTML made from Markdown (2026-10-28): the Markdown is what to change.
    const source = list.find((c) => c.passage?.source)?.passage?.source;
    const from = source ? `这份 HTML 由 \`${source}\` 生成：请改 \`${source}\`，再重新生成这份 HTML。\n\n` : "";
    return `### ${path}\n\n${from}${body.join("\n\n")}`;
  });
  // Only comments written in the viewer's 文件 mode (S14-A): they are on files, not on changes.
  if (comments.length && comments.every((c) => c.range === "file")) {
    const files = project ? `「${project}」的文件` : "文件";
    return `文件批注：我看了${files}，有 ${comments.length} 条批注。\n\n${parts.join("\n\n")}`;
  }
  const where = project ? `「${project}」的改动` : "改动";
  return `Git Review 批注：我看了${where}，有 ${comments.length} 条批注。\n\n${parts.join("\n\n")}`;
}

// ---- commit history (stage 13, S13-B): the branch's commits, and one commit's changes in a window of its own ------

/** A commit of the branch's history. */
export interface GitCommit {
  /** Full id. */
  sha: string;
  /** Full ids; the first is what the commit's changes are shown against (none for a root commit). */
  parents: string[];
  author: string;
  email: string;
  /** Author date, ISO 8601. */
  date: string;
  /** First line of the message. */
  subject: string;
}

/** Commits listed at most (newest first). */
export const GIT_LOG_MAX = 500;

/** HEAD's history, newest first; only the commits that touch the project folder when it sits inside a larger repository. */
export interface GitLog {
  branch: string | null;
  head: string | null;
  commits: GitCommit[];
  /** More commits than listed. */
  truncated: boolean;
}

/** A commit as a window address or a query names it: 7 to 64 hex digits (abbreviated or full). */
export const isCommitRef = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,64}$/.test(v);

/**
 * 外部打开 Review (2026-10-18): what another tool asks the open Studio to show. `path` (the project's folder; registered
 * when new) or `workspaceId`; then nothing (the uncommitted changes), `base` (the working tree against it), `commit`
 * (with or without `base`), or `range` (`A..B`, `A...B`). Refs may be branch names, tags, `HEAD~2` or ids.
 */
export interface ReviewOpenRequest {
  path?: string;
  workspaceId?: string;
  base?: string;
  commit?: string;
  range?: string;
  /** `changes` (default): Git Review; `file`: the current file in the viewer, including files without changes. */
  mode?: "changes" | "file";
  /** The file to select: absolute, or relative to the project. Required in `file` mode. */
  file?: string;
  /** 1-based line or range to reveal in `file` mode. */
  line?: number;
  endLine?: number;
  /** Where 发回 sends the comments. */
  sessionId?: string;
}

/** What the review window opens on, refs resolved to full ids. */
export interface ReviewOpenTarget {
  workspaceId: string;
  sessionId?: string;
  commit?: string;
  base?: string;
  /** How the caller named the base ("master", "v1.2 的分叉点"). */
  baseLabel?: string;
  file?: string;
  mode?: "changes" | "file";
  line?: number;
  endLine?: number;
}

/** The open request was validated and sent to the workbench; this is not a human review/approval or window acknowledgement. */
export interface ReviewOpenResult {
  target: ReviewOpenTarget;
  /** The folder was not a project yet and was registered. */
  workspaceAdded: boolean;
}

/** One commit's changed files, against its first parent (git's empty tree for a root commit) or a given base. */
export interface GitCommitChanges {
  commit: GitCommit;
  /** What the files are compared with: the first parent, or the empty tree. */
  base: string;
  files: GitChangedFile[];
  truncated: boolean;
}
