import { anchorRow, parseRowKey, type DiffRow, type RowAnchor } from "./logic.js";

// Keeping the place across 只看改动 / 完整文件 and 单栏 / 左右对照 (S14-A): the rows change (and their count, so the
// scroll offset means another line), so the view remembers a line and puts it back where it was on screen.

/** A line, and how far below the top of the view it was. */
export interface ViewAnchor extends RowAnchor {
  offset: number;
}

const inView = (el: Element, top: number, bottom: number) => {
  const b = el.getBoundingClientRect();
  return b.bottom > top && b.top < bottom;
};

/**
 * The line to keep: the comment being written or edited (the one with the cursor, else one on screen), else the
 * first line at the top of the view. Null when nothing is drawn.
 */
export function captureAnchor(scroller: HTMLElement, rows: readonly DiffRow[]): ViewAnchor | null {
  const view = scroller.getBoundingClientRect();
  const focused = document.activeElement?.closest?.<HTMLElement>("[data-anchor]");
  const writing =
    focused && scroller.contains(focused) ? focused : [...scroller.querySelectorAll<HTMLElement>("[data-anchor]")].find((el) => inView(el, view.top, view.bottom));
  const at = writing && parseRowKey(writing.dataset.anchor ?? "");
  if (writing && at) return { ...at, offset: writing.getBoundingClientRect().top - view.top };
  // The chunk at the top of the view, then its first line there (chunks off screen are not looked into).
  for (const chunk of scroller.querySelectorAll<HTMLElement>(".gr-chunk")) {
    if (chunk.getBoundingClientRect().bottom <= view.top) continue;
    for (const el of chunk.querySelectorAll<HTMLElement>("[data-row]")) {
      const box = el.getBoundingClientRect();
      if (box.bottom <= view.top) continue;
      const row = rows[Number(el.dataset.row)];
      if (row?.kind === "line") return { side: row.side, number: row.number, offset: box.top - view.top };
    }
  }
  return null;
}

/** Puts the anchor back at its offset: the comment box when it is drawn again, else its line or the nearest one. */
export function restoreAnchor(scroller: HTMLElement, rows: readonly DiffRow[], anchor: ViewAnchor): void {
  const key = `${anchor.side}:${anchor.number}`;
  let el = scroller.querySelector<HTMLElement>(`[data-anchor="${key}"]`);
  if (!el) {
    const i = anchorRow(rows, anchor);
    if (i === null) return;
    el = scroller.querySelector<HTMLElement>(`[data-row="${i}"]`);
  }
  if (!el) return;
  // Into view first (its chunk may not be drawn yet, its height only guessed), then to the same offset.
  el.scrollIntoView({ block: "start" });
  scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
}
