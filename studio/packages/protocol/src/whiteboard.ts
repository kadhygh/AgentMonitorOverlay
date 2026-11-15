import type { Id } from "./entities.js";

// 白板 (2026-11-16, plans/whiteboard.md; the user: 我觉得可能更需要的是一个 board，给 ai 来做数据临时存储。ai 通过快速调整 html 的方式，
// 直接展示这个 board 里的相关内容…人只是看这个白板加批注，这个批注可以加在白板上的任意位置，或者选中任意白板上的节点): a session's
// working board. Its AI writes it as data (nodes: what the task is, the plan, each suggestion, what a sub-session found,
// what was settled) and may give the page that draws it; the person only looks and pins notes on it — on a node, or at
// any place of the page. One thing read two ways: the person looks at the page, the AI reads the data in one call, also
// after a compaction took its context.

/** What a node is; shown as its label. */
export const WHITEBOARD_KINDS = { goal: "目标", plan: "计划", suggestion: "建议", question: "问题", finding: "发现", decision: "决定", todo: "待办", note: "备注" } as const;
export type WhiteboardKind = keyof typeof WHITEBOARD_KINDS;

/** Where a node stands. `waiting`: on the person. */
export const WHITEBOARD_STATUSES = { open: "开着", doing: "在做", done: "做完", dropped: "不做了", waiting: "等你" } as const;
export type WhiteboardStatus = keyof typeof WHITEBOARD_STATUSES;

export const WHITEBOARD_NODES_MAX = 150;
export const WHITEBOARD_TITLE_MAX = 60;
export const WHITEBOARD_BODY_MAX = 1500;
export const WHITEBOARD_GROUP_MAX = 20;
export const WHITEBOARD_NOTES_MAX = 200;
export const WHITEBOARD_NOTE_MAX = 1000;
export const WHITEBOARD_QUOTE_MAX = 80;
/** The AI's own page (whiteboard_view), in characters. */
export const WHITEBOARD_VIEW_MAX = 200_000;

export interface WhiteboardNode {
  /** The AI's own short id, or n1, n2… */
  id: string;
  kind: WhiteboardKind;
  title: string;
  /** A few lines, Markdown. */
  body: string;
  status: WhiteboardStatus;
  /** The column it is in, named by the AI (任务内容, 推进计划, 调查结果…); "" for none. */
  group: string;
  /** The nodes it comes after, drawn as lines. */
  after: string[];
  /** Who gave it, when not the session's AI itself (a sub-session's name). */
  from: string;
  /** The board's rev when it was last written: above the person's seenRev, it is new to them. */
  rev: number;
  at: string;
}

/**
 * A note the person pinned (批注). `draft`: written, the AI has not been told; `sent`: went to the AI with a message;
 * `answered`: the AI wrote a reply; `closed`: the person is done with it.
 */
export type WhiteboardNoteState = "draft" | "sent" | "answered" | "closed";

export interface WhiteboardNote {
  /** c1, c2… */
  id: string;
  /** On this node — or beside it, with x and y. Absent: at a place of the page. */
  nodeId?: string;
  /** A place: from the node's top left corner when nodeId is given, else from the page's. In CSS pixels. */
  x?: number;
  y?: number;
  /** It was on a node taken off the board since: that node's title. Such a note has no place any more. */
  gone?: string;
  /** The words at that place, so the AI knows what the person pointed at. */
  quote?: string;
  text: string;
  at: string;
  state: WhiteboardNoteState;
  reply?: string;
  repliedAt?: string;
}

export interface WhiteboardData {
  sessionId: Id;
  /** The session's AI was told to keep the board. */
  on: boolean;
  /** One more with every change of the nodes or the page. */
  rev: number;
  /** The rev the person last looked at. */
  seenRev: number;
  nodes: WhiteboardNode[];
  notes: WhiteboardNote[];
  /** The page that draws it: the AI's own (whiteboard_view), else Studio's. See features/whiteboard/template.ts for what a page gets. */
  view: {
    html: string;
    own: boolean;
    at?: string;
    /** Studio's own page, beside the AI's: what the person can look at when the AI's fails. */
    fallback?: string;
  };
}
