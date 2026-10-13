// Pure helpers for what a message carries besides its text (stage 11): file references appended as a block the
// transcript can read back, and names and sizes for the chips.

import { lineSuffix } from "@amo-studio/protocol";

/** First line of the block that lists referenced files at the end of a message. */
export const FILE_REFS_HEADING = "引用文件：";

/** A referenced file: its path, and for a marked file (S12-D) its line range and note. */
export interface FileRefItem {
  path: string;
  startLine?: number | null;
  endLine?: number | null;
  note?: string;
}

const NOTE_OPEN = "（说明：";
const NOTE_CLOSE = "）";

/** One line of the block (without "- "): "path", "path:12-30", "path（说明：note）". Notes stay on one line. */
export function formatFileRef(ref: string | FileRefItem): string {
  if (typeof ref === "string") return ref.trim();
  const note = (ref.note ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
  return `${ref.path.trim()}${lineSuffix(ref.startLine, ref.endLine)}${note ? `${NOTE_OPEN}${note}${NOTE_CLOSE}` : ""}`;
}

/** A line of the block read back (the inverse of formatFileRef). */
export function parseFileRef(line: string): FileRefItem {
  let rest = line.trim();
  let note: string | undefined;
  const at = rest.indexOf(NOTE_OPEN);
  if (at > 0 && rest.endsWith(NOTE_CLOSE)) {
    note = rest.slice(at + NOTE_OPEN.length, -NOTE_CLOSE.length).trim();
    rest = rest.slice(0, at).trimEnd();
  }
  // ":12" or ":12-30" at the end; a drive letter ("C:\…") never looks like that.
  const range = /^(.+?):(\d+)(?:-(\d+))?$/.exec(rest);
  const ref: FileRefItem = range ? { path: range[1]!, startLine: Number(range[2]), endLine: range[3] ? Number(range[3]) : null } : { path: rest };
  return note ? { ...ref, note } : ref;
}

/** The message as sent: the text, then the referenced files (one per line, marked ones with their range and note). */
export function withFileRefs(text: string, refs: readonly (string | FileRefItem)[]): string {
  const unique = [...new Set(refs.map(formatFileRef).filter(Boolean))];
  if (!unique.length) return text;
  const block = `${FILE_REFS_HEADING}\n${unique.map((p) => `- ${p}`).join("\n")}`;
  return text.trim() ? `${text.trimEnd()}\n\n${block}` : block;
}

/**
 * Reads the block back: the text before it and the files in it. Only a block at the very end counts, and only when
 * every line after the heading is a "- path" item, so a message that merely quotes the heading is left alone.
 */
export function splitFileRefItems(message: string): { text: string; refs: FileRefItem[] } {
  const at = message.lastIndexOf(FILE_REFS_HEADING);
  if (at < 0 || (at > 0 && message[at - 1] !== "\n")) return { text: message, refs: [] };
  const lines = message.slice(at + FILE_REFS_HEADING.length).replace(/^\r?\n/, "").trimEnd().split(/\r?\n/);
  if (!lines.length || !lines.every((l) => /^- \S/.test(l))) return { text: message, refs: [] };
  return { text: message.slice(0, at).trimEnd(), refs: lines.map((l) => parseFileRef(l.slice(2))) };
}

/** The block read back as paths only (see splitFileRefItems for ranges and notes). */
export function splitFileRefs(message: string): { text: string; files: string[] } {
  const { text, refs } = splitFileRefItems(message);
  return { text, files: refs.map((r) => r.path) };
}

/** The last part of a path (either slash). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

/** The folder part of a path, without the trailing slash ("" for a bare name). */
export function dirName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(0, Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"), 0));
}

/** When a file changed, short: "刚刚", "5 分钟前", "3 小时前", "昨天", "10-12", "2025-10-12". */
export function formatWhen(iso: string, now = new Date()): string {
  const t = new Date(iso);
  const minutes = Math.floor((now.getTime() - t.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60 && t.getDate() === now.getDate()) return `${Math.floor(minutes / 60)} 小时前`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (t.toDateString() === yesterday.toDateString()) return "昨天";
  const md = `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return t.getFullYear() === now.getFullYear() ? md : `${t.getFullYear()}-${md}`;
}

/** "12 KB", "3.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
