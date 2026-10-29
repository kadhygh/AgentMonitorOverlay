// Pure helpers for what a message carries besides its text (stage 11): file references appended as a block the
// transcript can read back, and names and sizes for the chips. The block itself is in the protocol (the Host reads it too).

export { FILE_REFS_HEADING, formatFileRef, parseFileRef, splitFileRefItems, withFileRefs, type FileRefItem } from "@amo-studio/protocol";
import { splitFileRefItems } from "@amo-studio/protocol";

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
