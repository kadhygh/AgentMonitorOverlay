import { lineSuffix } from "./marks.js";

// The block of referenced files a message ends with (stage 11; moved from the UI 2026-10-29 so the Host can read it
// too: a message to a remote task carries B's files over to A, and A writes the block again with its own paths).

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
