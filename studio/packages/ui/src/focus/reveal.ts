// 展开后看全 (2026-11-06; the user: 点击之后 card 要保证最好能够完整的出现在 focus 界面，现在有可能展开后，还要继续向下
// 滚动，才能看到下面的按钮): a card opened by a click is scrolled into the list whole — or, taller than the list, with its
// top in view. Its detail loads after it opens and grows it, so it is followed for a moment.

/** Space kept between the card and the list's edges. */
const PAD = 8;
/** How long a card is followed after it opened (its latest content and buttons arrive in this time). */
export const FOLLOW_MS = 1500;

/**
 * How far to scroll a list (its visible top and bottom) so a card (its top and bottom, same coordinates) shows whole:
 * down until its bottom is in, but never so far its top leaves; up when its top is above.
 */
export function revealDelta(listTop: number, listBottom: number, top: number, bottom: number, pad = PAD): number {
  let dy = 0;
  if (bottom > listBottom - pad) dy = bottom - (listBottom - pad);
  if (top - dy < listTop + pad) dy = top - (listTop + pad);
  return Math.round(dy);
}

function reveal(list: HTMLElement, card: HTMLElement): void {
  const l = list.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const dy = revealDelta(l.top, l.bottom, r.top, r.bottom);
  if (dy) list.scrollBy({ top: dy });
}

/**
 * A click in the list: when it opened something in a card (a toggle with aria-expanded, now true), the card is
 * revealed, and again as it grows during FOLLOW_MS.
 */
export function revealOpened(list: HTMLElement, target: EventTarget | null): void {
  const toggle = (target as Element | null)?.closest?.("[aria-expanded]");
  const card = toggle?.closest<HTMLElement>(".focus-entry");
  if (!toggle || !card || !list.contains(card)) return;
  requestAnimationFrame(() => {
    if (toggle.getAttribute("aria-expanded") !== "true" || !card.isConnected) return;
    reveal(list, card);
    const watch = new ResizeObserver(() => card.isConnected && reveal(list, card));
    watch.observe(card);
    // The person scrolling meanwhile is not fought: following stops at their wheel.
    const stop = () => {
      watch.disconnect();
      list.removeEventListener("wheel", stop);
    };
    list.addEventListener("wheel", stop, { passive: true });
    setTimeout(stop, FOLLOW_MS);
  });
}
