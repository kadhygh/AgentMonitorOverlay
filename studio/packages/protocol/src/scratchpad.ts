// The scratchpad (便签, stage 11): limits shared by the Host and the UI, and the global shortcut that shows it.

export const SCRATCHPAD_MAX_PAGES = 9;
/** Old AMO's scratchpad had three pages; a new document starts the same. */
export const SCRATCHPAD_DEFAULT_PAGES = 3;
export const SCRATCHPAD_MAX_TEXT = 200_000;
export const SCRATCHPAD_MAX_IMAGES = 20;

/**
 * The default keyboard shortcut. It was old AMO's Ctrl+Alt+Space until 2026-10-26, when 豆包输入法 (whose voice key
 * is the right Alt) was found swallowing that Space; a combo without Alt stays clear of input methods. Old AMO's mouse
 * side-button choices (Ctrl + Mouse4…) needed a native mouse hook; Electron's global shortcuts take keys only.
 */
export const DEFAULT_SCRATCHPAD_SHORTCUT = "Ctrl+Shift+F12";

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIERS)[number]> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  meta: "Super",
  win: "Super",
};
const NAMED_KEYS = ["Space", "Tab", "Insert", "Delete", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right"];
const PUNCTUATION = "`-=[]\\;',./";

function canonicalKey(raw: string): string | null {
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  const named = NAMED_KEYS.find((k) => k.toLowerCase() === raw.toLowerCase());
  if (named) return named;
  if (raw.length === 1 && PUNCTUATION.includes(raw)) return raw;
  return null;
}

/**
 * A shortcut in its canonical form ("Ctrl+Alt+Space": modifiers in a fixed order, then one key), "" for off, or null
 * when it is not one Studio can register. Letters, digits and other keys need Ctrl, Alt or Super, so a shortcut never
 * swallows plain typing; function keys may stand alone.
 */
export function normalizeShortcut(value: string): string | null {
  const text = value.trim();
  if (!text) return "";
  const parts = text.split("+").map((p) => p.trim());
  // "Ctrl++" is not a thing; Electron spells the plus key "Plus", which Studio does not offer.
  if (parts.some((p) => !p)) return null;
  const key = canonicalKey(parts.pop()!);
  if (!key) return null;
  const mods = new Set<(typeof MODIFIERS)[number]>();
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p.toLowerCase()];
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  const fKey = /^F\d+$/.test(key);
  if (!fKey && !mods.has("Ctrl") && !mods.has("Alt") && !mods.has("Super")) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}
