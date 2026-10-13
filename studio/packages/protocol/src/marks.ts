import type { Id, Timestamp } from "./entities.js";

// File marks (文件标记, stage 12, S12-D): files or folders the person marked with a note, kept per project so they can
// be handed to an agent later (@ in the composer, or dragged in from the marks window).

/** A marked file or folder. `exists` and `folder` are read from disk each time the marks are listed. */
export interface FileMark {
  id: Id;
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
  startLine?: number | null;
  endLine?: number | null;
  note?: string;
}

export interface FileMarkPatch {
  note?: string;
  /** null clears the range (both together). */
  startLine?: number | null;
  endLine?: number | null;
  order?: number;
}

export const FILE_MARK_NOTE_MAX = 4000;

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
