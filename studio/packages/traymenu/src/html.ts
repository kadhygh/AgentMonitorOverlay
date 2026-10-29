// The page of a tray menu (index.ts shows it): 便签's tray menu look (ui/src/notes/TrayMenu.tsx, notes.css .tm-*) —
// square, a grey title per part, 26 px items, a hairline between parts — as one self-contained page, so the platform,
// Studio and 中转 draw the same menu without a UI bundle of their own (2026-10-29, the user: every tray menu like 便签's).
// Light or dark as Windows is (prefers-color-scheme), with base.css's colours. A click navigates to
// http://amo-menu/<index>, Esc to http://amo-menu/close; the window catches that navigation and never follows it.

export type MenuEntry =
  /** A part's grey heading. */
  | { kind: "title"; label: string }
  /** strong: what a click on the icon does. checked: a choice (✓ when chosen). */
  | { kind: "item"; label: string; strong?: boolean; checked?: boolean; run: () => void }
  | { kind: "rule" };

/** Heights in px, as the page draws them: the window is made to fit exactly. */
export const MENU_SIZES = { title: 24, item: 26, rule: 7, chrome: 10 };

export function menuHeight(entries: readonly MenuEntry[]): number {
  return entries.reduce((h, e) => h + MENU_SIZES[e.kind], MENU_SIZES.chrome);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function menuHtml(entries: readonly MenuEntry[], label: string): string {
  const body = entries
    .map((e, i) => {
      if (e.kind === "title") return `<div class="t">${escape(e.label)}</div>`;
      if (e.kind === "rule") return `<div class="r" aria-hidden="true"></div>`;
      const check = e.checked === undefined ? "" : `<span class="k">${e.checked ? "✓" : ""}</span>`;
      const role = e.checked === undefined ? "menuitem" : `menuitemradio" aria-checked="${e.checked}`;
      return `<button type="button" role="${role}" class="i${e.strong ? " s" : ""}" data-i="${i}">${escape(e.label)}${check}</button>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(label)}</title><style>
:root { --panel: #181b1f; --selected: #22272d; --border: #2b3036; --border-strong: #3a414a; --text: #e6e8eb; --text-dim: #a0a8b2; --text-faint: #7c8590; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --panel: #fbfaf7; --selected: #e7dfcd; --border: #d9d3c7; --border-strong: #2a2723; --text: #22201c; --text-dim: #5d5850; --text-faint: #8d877c; color-scheme: light; } }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--panel); }
body { font-family: "Noto Sans SC Variable", "Microsoft YaHei UI", "Segoe UI", sans-serif; font-size: 13px; user-select: none; }
.m { height: 100%; box-sizing: border-box; display: flex; flex-direction: column; padding: 4px; border: 1px solid var(--border-strong); color: var(--text); }
.t { flex: none; height: ${MENU_SIZES.title}px; box-sizing: border-box; display: flex; align-items: center; padding: 1px 8px 0; font-weight: 700; font-size: 12px; letter-spacing: 0.1em; color: var(--text-dim); white-space: nowrap; }
.i { flex: none; display: flex; align-items: center; gap: 8px; height: ${MENU_SIZES.item}px; padding: 0 8px; border: none; border-radius: 3px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; white-space: nowrap; }
.i:hover, .i:focus-visible { background: var(--selected); outline: none; }
.i.s { font-weight: 600; }
.k { margin-left: auto; width: 14px; text-align: center; color: var(--text-dim); }
.r { flex: none; height: 1px; margin: 3px 8px; background: var(--border); }
</style></head><body><div class="m" role="menu" aria-label="${escape(label)}">${body}</div><script>
const go = (to) => { location.href = "http://amo-menu/" + to; };
document.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => go(b.dataset.i)));
addEventListener("keydown", (e) => { if (e.key === "Escape") go("close"); });
</script></body></html>`;
}
