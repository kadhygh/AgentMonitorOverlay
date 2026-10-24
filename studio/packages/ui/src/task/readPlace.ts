import { pinScroll } from "../lib/scrollPin.js";

// Where a conversation is being read, for 后退 back to it (2026-10-20). It was its scrollTop, but a task page opened
// anew has its turns not drawn yet, standing in at 300px each (chat.css): the same scrollTop was then another part of
// the conversation (11,800px off). Now the block at the top of the view (a turn, by its place among the conversation's
// blocks; new turns only come after) and how far into it, scrollTop kept for a conversation that has fewer blocks now.

export interface ReadPlace {
  block: number;
  /** The turn's key: a long session draws only its last turns, so its place among the drawn blocks can change. */
  key?: string;
  /** px from the block's top to the top of the view. */
  offset: number;
  top: number;
}

const blocksOf = (scroller: HTMLElement): HTMLCollection | null => scroller.querySelector(":scope > .thread-inner")?.children ?? null;

/** The block at the top of the view, and how far into it. */
export function readPlaceOf(scroller: HTMLElement): ReadPlace {
  const top = Math.round(scroller.scrollTop);
  const blocks = blocksOf(scroller);
  if (!blocks?.length) return { block: -1, offset: 0, top };
  const viewTop = scroller.getBoundingClientRect().top;
  // The first block whose bottom is below the view's top (blocks follow each other down the page).
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid]!.getBoundingClientRect().bottom > viewTop) hi = mid;
    else lo = mid + 1;
  }
  const key = (blocks[lo] as HTMLElement).dataset.key;
  return { block: lo, ...(key ? { key } : {}), offset: Math.round(viewTop - blocks[lo]!.getBoundingClientRect().top), top };
}

export const samePlace = (a: ReadPlace | undefined, b: ReadPlace) => !!a && a.block === b.block && a.offset === b.offset && a.top === b.top;

/** Back to `place`, once the conversation's messages are in. */
export function restoreReadPlace(scroller: HTMLElement, place: ReadPlace): void {
  const byKey = place.key ? scroller.querySelector(`:scope > .thread-inner > [data-key="${CSS.escape(place.key)}"]`) : null;
  const block = byKey ?? (place.block >= 0 ? blocksOf(scroller)?.[place.block] : undefined);
  // Fewer blocks than then (the session compacted, say): the old way.
  if (!block) scroller.scrollTop = place.top;
  else pinScroll(scroller, () => block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + place.offset);
}
