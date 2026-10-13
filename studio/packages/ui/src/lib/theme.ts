// UI theme: light (the default: direction A, 纸感编辑部), dark, or following the system. Stored per install (this window profile's localStorage, which the
// workbench and Focus windows share); applied as data-theme on <html>, which app.css reads.

export type ThemePref = "system" | "light" | "dark";

const KEY = "amo.theme";

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(pref: ThemePref = themePref()): void {
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  syncTitleBar();
}

/** "#rrggbb" for a colour token, or null when it is not a plain hex colour. */
function tokenHex(name: string): string | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

/** The window controls over the top bar take the bar's colours (Electron workbench window only). */
export function syncTitleBar(): void {
  const set = window.amo?.setTitleBarColors;
  if (!set) return;
  const color = tokenHex("--bg-header");
  const symbolColor = tokenHex("--text");
  if (color && symbolColor) set({ color, symbolColor });
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // private profile: still applies to this window
  }
  applyTheme(pref);
}

/** Keeps a window in step when another window (workbench ↔ Focus) changes the theme. */
export function followThemeChanges(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) applyTheme();
  };
  // "跟随系统": the system switching between light and dark changes the bar's colours too.
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => syncTitleBar();
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", onMedia);
  return () => {
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", onMedia);
  };
}

export const THEME_LABELS: Record<ThemePref, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
