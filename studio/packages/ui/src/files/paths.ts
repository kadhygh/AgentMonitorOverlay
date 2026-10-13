// Which text in a conversation names a file (stage 12, S12-C), as pure functions: inline code in a reply
// (`src/a.cs`, `a.cs:12`, `G:\p\a.cs:12:5`), Markdown links to local paths (`[x](src/a.cs#L12)`, `file:///…`) and
// tool rows. Only a guess: the Host says whether the file exists before anything becomes a link.

/** A file named in the conversation: the path as written (no line suffix), and the line / column when given. */
export interface FileMention {
  path: string;
  line?: number;
  column?: number;
}

const MAX_PATH = 300;
/** `:12`, `:12:5`, `:12-20`, `:12–20` (a range opens at its first line), `#L12`, `#L12C5`, `#L12-L20`, `(12)`, `(12,5)`. */
const LINE_SUFFIX = /(?::(\d+)(?:[-–]\d+)?(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?|\((\d+)(?:,\s*(\d+))?\))$/;
/** A drive-absolute Windows path (`G:\…` or `G:/…`), the only kind that may contain spaces. */
const DRIVE = /^[a-z]:[\\/]/i;
/** Characters a path in a reply does not have (commands, calls, globs, expressions). */
const NOT_IN_PATH = /[<>"'|*?`{}()=;,$!^]|\s-{1,2}\w/;
/** The last part of a path looks like a file: `name.ext` or a dotfile. */
const FILE_NAME = /^(?:[^.\\/][^\\/]*\.[A-Za-z0-9_-]{1,12}|\.[A-Za-z0-9_][\w.-]*)$/;
/** Version numbers and such: `1.2.3`, `v2.0`. */
const VERSION = /^v?\d+(?:\.\d+)+$/i;

const int = (s: string | undefined): number | undefined => {
  const n = s ? Number(s) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** Splits a trailing line (and column) off a written path. */
export function splitLine(written: string): FileMention {
  const m = LINE_SUFFIX.exec(written);
  if (!m || m.index === 0) return { path: written };
  const line = int(m[1] ?? m[3] ?? m[5]);
  const column = int(m[2] ?? m[4] ?? m[6]);
  return { path: written.slice(0, m.index), ...(line ? { line } : {}), ...(line && column ? { column } : {}) };
}

/** `file:///G:/a%20b.cs` → `G:/a b.cs`; other text unchanged; null for a malformed escape. */
function fromFileUrl(s: string): string | null {
  if (!/^file:\/\//i.test(s)) return s;
  try {
    const p = decodeURIComponent(s.replace(/^file:\/\//i, ""));
    return /^\/[a-z]:[\\/]/i.test(p) ? p.slice(1) : p;
  } catch {
    return null;
  }
}

/** Whether a path (no line suffix) could name a file, judged by its shape only. */
export function looksLikeFilePath(path: string): boolean {
  if (!path || path.length > MAX_PATH || /[\r\n\t]/.test(path)) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !DRIVE.test(path)) return false; // URLs and other schemes
  if (/^[\\/]{2}/.test(path) || path.startsWith("~") || path.startsWith("-")) return false; // network paths, home, flags
  if (/\s/.test(path) && !DRIVE.test(path)) return false;
  if (NOT_IN_PATH.test(path)) return false;
  if (/[\\/]$/.test(path)) return false; // a folder
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const hasDir = name.length < path.length;
  if (!name || name === "." || name === ".." || VERSION.test(name)) return false;
  if (FILE_NAME.test(name)) return true;
  // Extensionless files (Makefile, LICENSE, bin/run) only with a folder in front.
  return hasDir && /^[\w][\w.-]*$/.test(name) && /[\\/]/.test(path.replace(/^\.{1,2}[\\/]/, "")) && !/^\d+$/.test(name);
}

/** Inline code that names a file, or null when it does not look like a path. */
export function parseInlinePath(code: string): FileMention | null {
  const text = code.trim();
  if (!text || text.length > MAX_PATH) return null;
  const url = fromFileUrl(text);
  if (url === null) return null;
  const mention = splitLine(url);
  return looksLikeFilePath(mention.path) ? mention : null;
}

/**
 * A Markdown link's destination that points at a local file (after DSH's parseFileLink): a path, `file://…`, with an
 * optional `#L12` / `#L12-L20` fragment or `:12` suffix. Null for web links, anchors, queries and other schemes.
 */
export function parseLinkTarget(href: string): FileMention | null {
  let target = href.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (!target || target.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(target) && !DRIVE.test(target) && !/^file:\/\//i.test(target)) return null;
  const hash = target.indexOf("#");
  let line: number | undefined;
  let column: number | undefined;
  if (hash >= 0) {
    const frag = /^L(\d+)(?:C(\d+))?(?:-L?\d+)?$/.exec(target.slice(hash + 1));
    if (!frag) return null;
    line = int(frag[1]);
    column = int(frag[2]);
    target = target.slice(0, hash);
  }
  if (target.includes("?")) return null;
  let path = fromFileUrl(target);
  if (path === null) return null;
  if (!/^file:/i.test(target)) {
    try {
      path = decodeURIComponent(path);
    } catch {
      return null;
    }
  }
  if (line === undefined) {
    const split = splitLine(path);
    path = split.path;
    line = split.line;
    column = split.column;
  }
  if (!path || path.length > MAX_PATH || /^[\\/]{2}/.test(path) || /[\r\n]/.test(path)) return null;
  return { path, ...(line ? { line } : {}), ...(line && column ? { column } : {}) };
}

/** The last part of a path (either slash). */
export function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

/** The folder part of a path ("" for a bare name). */
export function folderOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(0, Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"), 0));
}

/** A path for the eye: long middles elided ("G:\PROJECT\…\studio\src"). */
export function shortFolder(path: string, max = 48): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/);
  if (parts.length <= 3) return `…${path.slice(-(max - 1))}`;
  const head = parts.slice(0, 2).join(sep);
  let tail = parts.at(-1)!;
  for (let i = parts.length - 2; i >= 2; i--) {
    const next = `${parts[i]}${sep}${tail}`;
    if (head.length + next.length + 3 > max) break;
    tail = next;
  }
  return `${head}${sep}…${sep}${tail}`;
}
