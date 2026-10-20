// Scrolling the conversation to something (2026-10-20): its turns off screen are drawn only once in view (chat.css,
// content-visibility) and stand in at 300px before, so a jump worked out once lands wrong: the turns it brings into
// view take their real height and push the target away (a bookmark ended 12,000px off, a reply jump 2,900px, a place
// gone back to 11,800px). A jump here measures again each frame and corrects itself until the target stays put.

/** Frames a jump goes on correcting itself (about half a second), and how many still ones end it. */
const SETTLE_FRAMES = 30;
const STILL_FRAMES = 3;
/** The jump still settling, per scroller: a new one stops it. */
const settling = new WeakMap<HTMLElement, number>();

/** On a scroller that was just scrolled to something to read: stay here, do not follow the end. */
export const READ_HERE_EVENT = "amo:read-here";

/**
 * Scrolls `scroller` by `delta()` (how far the target is from where it should be, in px; positive scrolls down), then
 * again each frame while the layout moves, until it stays put, or until the person scrolls themselves (wheel, keys,
 * the scrollbar): from then on, where to read is theirs.
 */
export function pinScroll(scroller: HTMLElement, delta: () => number): void {
  const run = (settling.get(scroller) ?? 0) + 1;
  settling.set(scroller, run);
  const place = () => {
    const by = Math.round(delta());
    if (Math.abs(by) > 1) scroller.scrollTop += by;
    return by;
  };
  place();
  // The conversation stops following its end now, not at its scroll event a frame later: content growing in between
  // (a turn unfolding, code highlighted) would take it back to the end (2026-10-19: 书签 → 打开对话 landed there).
  scroller.dispatchEvent(new Event(READ_HERE_EVENT));
  // Not a change of scrollTop: the browser's scroll anchoring moves it too, as the turns above take their height.
  let theirs = false;
  const mine = () => (theirs = true);
  const inputs = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
  for (const e of inputs) scroller.addEventListener(e, mine, { passive: true });
  let frames = 0;
  let still = 0;
  const settle = () => {
    if (settling.get(scroller) === run && !theirs && scroller.isConnected) {
      const by = place();
      still = Math.abs(by) > 1 ? 0 : still + 1;
      if (++frames < SETTLE_FRAMES && still < STILL_FRAMES) return void requestAnimationFrame(settle);
    }
    for (const e of inputs) scroller.removeEventListener(e, mine);
  };
  requestAnimationFrame(settle);
}
