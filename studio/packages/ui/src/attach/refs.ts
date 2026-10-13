// Pure helpers for what a message carries besides its text (stage 11): file references appended as a block the
// transcript can read back, and names and sizes for the chips.

/** First line of the block that lists referenced files at the end of a message. */
export const FILE_REFS_HEADING = "引用文件：";

/** The message as sent: the text, then the referenced files (one path per line). */
export function withFileRefs(text: string, paths: readonly string[]): string {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  if (!unique.length) return text;
  const block = `${FILE_REFS_HEADING}\n${unique.map((p) => `- ${p}`).join("\n")}`;
  return text.trim() ? `${text.trimEnd()}\n\n${block}` : block;
}

/**
 * Reads the block back: the text before it and the paths in it. Only a block at the very end counts, and only when
 * every line after the heading is a "- path" item, so a message that merely quotes the heading is left alone.
 */
export function splitFileRefs(message: string): { text: string; files: string[] } {
  const at = message.lastIndexOf(FILE_REFS_HEADING);
  if (at < 0 || (at > 0 && message[at - 1] !== "\n")) return { text: message, files: [] };
  const lines = message.slice(at + FILE_REFS_HEADING.length).replace(/^\r?\n/, "").trimEnd().split(/\r?\n/);
  if (!lines.length || !lines.every((l) => /^- \S/.test(l))) return { text: message, files: [] };
  return { text: message.slice(0, at).trimEnd(), files: lines.map((l) => l.slice(2).trim()) };
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
