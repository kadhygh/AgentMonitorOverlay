// 跟随系统 / 浅色 / 深色, as in AMO Studio: the theme variables (Studio's base.css) answer to data-theme on <html>,
// and follow the system without it. Kept per viewer in this browser or client.

export type Theme = "system" | "light" | "dark";

const KEY = "amo-relay.theme";
export const THEME_LABEL: Record<Theme, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
export const nextTheme = (t: Theme): Theme => ({ system: "light", light: "dark", dark: "system" })[t] as Theme;

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  applyTheme(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // storage blocked: this window keeps it
  }
}
