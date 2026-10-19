import type { Id, Timestamp } from "./entities.js";

// File marks (文件标记, stage 12, S12-D): files or folders the person marked with a note, kept per project so they can
// be handed to an agent later (@ in the composer, or dragged in from the marks window).
// 书签 (2026-10-19): the marks became bookmarks kept under a topic (专题), and a bookmark can also be a passage of a
// session's reply (ChatMark). The file ones keep their project for @ and the agents' list_file_marks.

/** A marked file or folder. `exists` and `folder` are read from disk each time the marks are listed. */
export interface FileMark {
  kind: "file";
  id: Id;
  /** The topic it is kept under; null: 未归专题. */
  topicId: Id | null;
  /** Absolute. */
  path: string;
  /** The project the path lies in; null for "其他" (outside every project). Derived from the path. */
  workspaceId: Id | null;
  /** 1-based, inclusive; both null for the whole file. */
  startLine: number | null;
  endLine: number | null;
  /** 说明; may be empty. */
  note: string;
  /** Lower first within a project. */
  order: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  exists: boolean;
  folder: boolean;
}

export interface NewFileMark {
  /** Absolute, or relative to `workspaceId`'s folder. */
  path: string;
  workspaceId?: Id;
  /** The topic to keep it under (null: 未归专题); when absent, the topic of `sessionId`'s task, else none. */
  topicId?: Id | null;
  /** The session it was marked from (the viewer opened from a conversation): only to choose the topic. */
  sessionId?: Id;
  startLine?: number | null;
  endLine?: number | null;
  note?: string;
}

export interface FileMarkPatch {
  note?: string;
  /** Moves it to another topic (null: 未归专题). */
  topicId?: Id | null;
  /** null clears the range (both together). */
  startLine?: number | null;
  endLine?: number | null;
  order?: number;
}

export const FILE_MARK_NOTE_MAX = 4000;

/**
 * A bookmarked passage of a session's reply (2026-10-19): anchored as an annotation is (the reply's item and the
 * range in its markdown, with the text around it), with a copy of the text so it still reads when the session is gone.
 */
export interface ChatMark {
  kind: "chat";
  id: Id;
  topicId: Id | null;
  sessionId: Id;
  itemId: Id;
  /** [start, end) in the reply's markdown. */
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  note: string;
  /** Lower first within a topic (files and passages share the order). */
  order: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Read each time the bookmarks are listed: where the session is now, and whether it and the reply are still there. */
  taskId: Id | null;
  workspaceId: Id | null;
  sessionTitle: string;
  exists: boolean;
}

export interface NewChatMark {
  sessionId: Id;
  itemId: Id;
  start: number;
  end: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  note?: string;
  /** null: 未归专题; when absent, the session's topic (its task's). */
  topicId?: Id | null;
}

export const CHAT_MARK_QUOTE_MAX = 8000;

/** 书签: a file (or folder) or a passage of a conversation. */
export type Bookmark = FileMark | ChatMark;

/** The drag type of a mark dragged from the marks window (JSON of FileMarkDrag); `text/plain` carries the path. */
export const FILE_MARK_MIME = "application/x-amo-file-mark";

/** What a dragged mark carries. */
export interface FileMarkDrag {
  id: Id;
  path: string;
  note: string;
  startLine: number | null;
  endLine: number | null;
}

/** ":12" or ":12-30" after a path; "" without a range. */
export function lineSuffix(startLine: number | null | undefined, endLine: number | null | undefined): string {
  if (!startLine) return "";
  return endLine && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`;
}

/** "第 12 行", "第 12–30 行"; "" without a range. */
export function lineLabel(startLine: number | null | undefined, endLine: number | null | undefined): string {
  if (!startLine) return "";
  return endLine && endLine !== startLine ? `第 ${startLine}–${endLine} 行` : `第 ${startLine} 行`;
}

/** A dragged mark read back, or null when the data is not one. */
export function parseFileMarkDrag(data: string): FileMarkDrag | null {
  try {
    const v = JSON.parse(data) as Partial<FileMarkDrag> | null;
    if (!v || typeof v.path !== "string" || !v.path) return null;
    const line = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null);
    return { id: typeof v.id === "string" ? v.id : "", path: v.path, note: typeof v.note === "string" ? v.note : "", startLine: line(v.startLine), endLine: line(v.endLine) };
  } catch {
    return null;
  }
}
