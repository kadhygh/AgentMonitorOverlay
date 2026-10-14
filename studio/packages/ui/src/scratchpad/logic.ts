import { normalizeShortcut } from "@amo-studio/protocol";

// Pure helpers of the scratchpad window and its settings page (unit-tested).

interface KeyLike {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  key: string;
  code: string;
}

/** Ctrl+1…9 in the window: the page index it switches to, or null (not that key, or past the page count). */
export function pageFromKey(e: KeyLike, pageCount: number): number | null {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code) ?? /^([1-9])$/.exec(e.key);
  if (!m) return null;
  const index = Number(m[1]) - 1;
  return index < pageCount ? index : null;
}

const CODE_KEYS: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** The key itself, by its place on the keyboard (so Shift+1 is "1", not "!"); null for modifiers and unknown keys. */
function keyName(code: string): string | null {
  const m = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code) ?? /^(F\d{1,2})$/.exec(code);
  return m ? m[1]! : (CODE_KEYS[code] ?? null);
}

/**
 * A shortcut from a key press in the settings field: `{ shortcut }` in canonical form, `{ pending: true }` while only
 * modifiers are down, or `{ invalid: true }` for a combination Studio does not take (see normalizeShortcut).
 */
export function shortcutFromKey(e: KeyLike): { shortcut: string } | { pending: true } | { invalid: true } {
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return { pending: true };
  const key = keyName(e.code);
  if (!key) return { invalid: true };
  const parts = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", key].filter(Boolean) as string[];
  const shortcut = normalizeShortcut(parts.join("+"));
  return shortcut ? { shortcut } : { invalid: true };
}

/** How a shortcut reads in the UI: "Ctrl + Alt + Space", "Win" for Super; "关闭" when off. */
export function shortcutLabel(shortcut: string): string {
  if (!shortcut) return "关闭";
  return shortcut
    .split("+")
    .map((p) => (p === "Super" ? "Win" : p))
    .join(" + ");
}

/**
 * What 复制 puts on the clipboard (S14-B, after old AMO's toCliPasteClipboardText): trailing spaces and blank lines at
 * the end dropped, then either the lines kept with Windows line breaks, or (安全换行) joined into one line with spaces,
 * so pasting into a terminal CLI cannot send it line by line.
 */
export function clipboardText(text: string, safeNewlines: boolean): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/, "");
  return safeNewlines ? normalized.replace(/[ \t]*\n+[ \t]*/g, " ") : normalized.replace(/\n/g, "\r\n");
}
