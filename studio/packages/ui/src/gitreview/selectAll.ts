import { useEffect, useRef } from "react";
import type { DiffRow } from "./logic.js";

// Ctrl+A in a file's view (2026-11-05, the user: 查看脚本文件时按全选会选到下面的快捷键内容): it selects the file's
// text only — the code, the diff, the rendered Markdown — not the key hints, the file list or the buttons around it.
// The code and the diff are drawn near the view only (LazyChunks), so the selection holds just the lines drawn: Ctrl+C
// on that selection puts the whole text on the clipboard instead (`text`), without line numbers. A box being typed in
// keeps its own Ctrl+A.

/** Typing in a box (search, a comment, go-to-line): Ctrl+A is the box's. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable]");
}

export const isSelectAllKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a";

/** Selects everything inside `el` (as Ctrl+A would, kept to it). */
export function selectWhole(el: HTMLElement) {
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The selection is what selectWhole(el) made: from before el's first child to after its last. */
export function wholeSelected(el: HTMLElement): boolean {
  const sel = el.ownerDocument.getSelection();
  if (!sel || sel.rangeCount !== 1) return false;
  const r = sel.getRangeAt(0);
  return r.startContainer === el && r.startOffset === 0 && r.endContainer === el && r.endOffset === el.childNodes.length;
}

/**
 * While `active`: Ctrl+A (outside a box) selects what `area()` returns; Ctrl+C on that selection copies `text()`
 * when given (else the browser copies what is selected). No area (nothing shown): Ctrl+A does nothing, rather than
 * selecting the window's buttons and hints.
 */
export function useSelectAll(active: boolean, area: () => HTMLElement | null, text?: () => string) {
  const latest = useRef({ area, text });
  latest.current = { area, text };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isSelectAllKey(e) || typingIn(e.target)) return;
      e.preventDefault();
      const el = latest.current.area();
      if (el) selectWhole(el);
    };
    const onCopy = (e: ClipboardEvent) => {
      const { area: areaOf, text: textOf } = latest.current;
      const el = areaOf();
      if (!textOf || !el || !e.clipboardData || typingIn(document.activeElement) || !wholeSelected(el)) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", textOf());
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("copy", onCopy);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
    };
  }, [active]);
}

/** A file's text as the viewer shows it: line endings as \n. */
export const fileText = (text: string) => text.replace(/\r\n?/g, "\n");

/**
 * A diff's rows as text, as a unified diff's body: each hunk's @@ line, then its lines marked " ", "+" or "-". Both
 * sides are in it, so what was taken out and put in can be told apart once pasted (line numbers are left out).
 */
export function diffText(rows: readonly DiffRow[]): string {
  const mark = { context: " ", add: "+", del: "-" } as const;
  return rows.map((r) => (r.kind === "hunk" ? r.header : `${mark[r.line.kind]}${r.line.text}`)).join("\n");
}
