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

// 字体大小 (settings · 通用): the body text's size; Studio's other text sizes keep their steps from it. Per viewer too.

export const FONT_SIZES = [13, 14, 15, 16] as const;
export type FontSize = (typeof FONT_SIZES)[number];
export const FONT_LABEL: Record<FontSize, string> = { 13: "小", 14: "标准", 15: "大", 16: "特大" };
const FONT_KEY = "amo-relay.fontSize";

export function readFontSize(): FontSize {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return (FONT_SIZES as readonly number[]).includes(n) ? (n as FontSize) : 14;
  } catch {
    return 14;
  }
}

export function applyFontSize(px: FontSize): void {
  const s = document.documentElement.style;
  const d = px - 14;
  if (!d) for (const v of ["--fs-cap", "--fs-sm", "--fs-body", "--fs-title", "--fs-h2"]) s.removeProperty(v);
  else Object.entries({ "--fs-cap": 12, "--fs-sm": 13, "--fs-body": 14, "--fs-title": 16, "--fs-h2": 19 }).forEach(([v, base]) => s.setProperty(v, `${base + d}px`));
}

export function setFontSize(px: FontSize): void {
  applyFontSize(px);
  try {
    localStorage.setItem(FONT_KEY, String(px));
  } catch {
    // storage blocked: this window keeps it
  }
}
