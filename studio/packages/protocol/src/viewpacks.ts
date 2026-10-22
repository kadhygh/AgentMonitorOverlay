import type { Id, Timestamp } from "./entities.js";

// 查看包 (view packs, 2026-10-23): what an agent hands the person to look at, in one go — a list of items, each of a
// kind that a module on each side handles (Host: checking and resolving it; UI: its list entry and how it shows). A
// new kind is one more module on each side; the pack, its window and the flow stay as they are.
//   file      a file as it is now, with the agent's 重点 (lines, each with a note)
//   git       changes: uncommitted, against a base, a commit or a range — optionally only some files
//   proposal  改动预览: a file and what it would look like changed; nothing on disk changes

export const VIEW_KINDS = ["file", "git", "proposal"] as const;
export type ViewItemKind = (typeof VIEW_KINDS)[number];

/** A 重点: lines the agent points the person at, and why. */
export interface ViewHighlight {
  line: number;
  endLine?: number;
  /** "" when the agent only marked the lines. */
  note: string;
}

interface ViewItemBase {
  id: Id;
  kind: ViewItemKind;
  /** The agent's own name for it (else one from what it is). */
  title?: string;
  /** What the agent says about it, shown above it. */
  note?: string;
}

export interface FileViewItem extends ViewItemBase {
  kind: "file";
  /** Relative to the pack's project, forward slashes. */
  path: string;
  highlights: ViewHighlight[];
}

/** What a git item compares (refs resolved to full ids). */
export type GitViewSource =
  | { kind: "working" }
  | { kind: "base"; base: string; label: string }
  | { kind: "commit"; commit: string; base?: string; label?: string };

export interface GitViewItem extends ViewItemBase {
  kind: "git";
  source: GitViewSource;
  /** Only these files (relative to the project); empty: every changed file. */
  files: string[];
}

export interface ProposalViewItem extends ViewItemBase {
  kind: "proposal";
  /** Relative to the pack's project; the file need not exist. */
  path: string;
  /** The file when the pack was made ("" for a new file). */
  original: string;
  /** What the agent proposes it becomes. */
  proposed: string;
  isNew: boolean;
}

export type ViewItem = FileViewItem | GitViewItem | ProposalViewItem;

export interface ViewPack {
  id: Id;
  workspaceId: Id;
  /** The conversation that sent it: comments go back there by default. */
  sessionId: Id | null;
  title: string;
  items: ViewItem[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** One item as an agent sends it (view_open); the kind's module checks it and resolves it into a ViewItem. */
export interface ViewItemInput {
  kind: ViewItemKind;
  title?: string;
  note?: string;
  /** file, proposal: the file (relative to the project, or absolute inside it). */
  path?: string;
  /** file: 重点. */
  highlights?: Array<{ line: number; endLine?: number; note?: string }>;
  /** file: a line (or range) to show, without a note. */
  line?: number;
  endLine?: number;
  /** git: what to compare; `working` (default) the uncommitted changes. */
  source?: "working" | "base" | "commit" | "range";
  base?: string;
  commit?: string;
  /** git: `A..B` or `A...B` (from where B forked off A). */
  range?: string;
  /** git: only these files. */
  files?: string[];
  /** proposal: the whole new content of the file. */
  proposed?: string;
}

export interface ViewOpenRequest {
  /** Default: the calling session's project. */
  workspaceId?: Id;
  sessionId?: Id;
  title?: string;
  items: ViewItemInput[];
}

export interface ViewOpenResult {
  pack: ViewPack;
  /** Added to the pack the same session sent a moment ago, rather than a new one. */
  merged: boolean;
}

export const MAX_VIEW_ITEMS = 30;
export const MAX_VIEW_HIGHLIGHTS = 50;
/** A proposal's content, and the original it is compared with. */
export const MAX_PROPOSAL_BYTES = 1_000_000;
/** A second view_open of the same session within this goes into the same pack (two quick calls, one window). */
export const VIEW_MERGE_MS = 10_000;

const short = (sha: string) => sha.slice(0, 7);
const base = (path: string) => path.split("/").pop() || path;

/** The item's name in the pack's list. */
export function viewItemLabel(item: ViewItem): string {
  if (item.title) return item.title;
  if (item.kind === "file") return base(item.path);
  if (item.kind === "proposal") return `${base(item.path)}（改动预览）`;
  const s = item.source;
  const what = s.kind === "working" ? "未提交的改动" : s.kind === "base" ? `和 ${s.label} 比` : s.base ? `${s.label ?? short(s.base)}..${short(s.commit)}` : `提交 ${short(s.commit)}`;
  return item.files.length === 1 ? `${base(item.files[0]!)} · ${what}` : what;
}

/** The line under the name: where it is and what it carries. */
export function viewItemDetail(item: ViewItem): string {
  const dir = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  if (item.kind === "file") return [dir(item.path), item.highlights.length ? `${item.highlights.length} 处重点` : ""].filter(Boolean).join(" · ");
  if (item.kind === "proposal") return [dir(item.path), item.isNew ? "新文件" : ""].filter(Boolean).join(" · ");
  return item.files.length ? `${item.files.length} 个文件` : "全部改动";
}
