import { normalizeShortcut } from "@amo-studio/protocol";

// Pure helpers of the scratchpad window, its task-page entry and its settings section (unit-tested).

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

/** The first lines of a page for the task page's preview, with an ellipsis when there is more. */
export function previewText(text: string, maxLines = 6, maxChars = 280): string {
  const trimmed = text.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  let out = lines.slice(0, maxLines).join("\n");
  let cut = lines.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    cut = true;
  }
  return cut ? `${out.replace(/\s+$/, "")}…` : out;
}
