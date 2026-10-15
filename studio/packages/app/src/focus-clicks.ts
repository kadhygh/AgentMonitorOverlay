// Lost clicks on Focus (2026-10-15). Focus never takes activation (focusable: false). Sometimes Windows asks it, as
// a button goes down, whether the click should activate it (WM_MOUSEACTIVATE); Chromium answers for a window that
// cannot activate "do not activate, and drop the click" (MA_NOACTIVATEANDEAT), so the page never sees the press and
// the button does nothing. The trace showed WM_MOUSEACTIVATE on exactly the clicks that were lost and on none of
// the ones that worked. This gives such a click back: when a press came with WM_MOUSEACTIVATE and the page has not
// reported its pointerdown shortly after the button is released, the click is replayed into the page where it was
// pressed. Only clicks, in the page's own area (HTCLIENT); a drag of the title row cannot be replayed.

export interface Point {
  x: number;
  y: number;
}

export interface EatenClickOptions {
  /** Clicks the page at this point (window content coordinates, DIP). */
  replay(at: Point): void;
  now?: () => number;
  later?: (fn: () => void, ms: number) => void;
  /** How long after the release the page's pointerdown may still arrive (it comes over IPC). */
  graceMs?: number;
  /** A press older than this when released is not a click to give back. */
  maxPressMs?: number;
}

export class EatenClicks {
  private press: { at: Point; time: number; pageSaw: boolean } | null = null;
  private readonly now: () => number;
  private readonly later: (fn: () => void, ms: number) => void;
  private readonly graceMs: number;
  private readonly maxPressMs: number;

  constructor(private readonly options: EatenClickOptions) {
    this.now = options.now ?? Date.now;
    this.later = options.later ?? ((fn, ms) => void setTimeout(fn, ms));
    this.graceMs = options.graceMs ?? 60;
    this.maxPressMs = options.maxPressMs ?? 3000;
  }

  /** WM_MOUSEACTIVATE for a left press in the page's area, with where the pointer is. */
  activated(at: Point | null): void {
    this.press = at ? { at, time: this.now(), pageSaw: false } : null;
  }

  /** The page saw a pointerdown: nothing was lost. */
  pagePressed(): void {
    if (this.press) this.press.pageSaw = true;
  }

  /** WM_LBUTTONUP: give the click back if the page never saw the press. */
  released(): void {
    const press = this.press;
    if (!press) return;
    if (press.pageSaw || this.now() - press.time > this.maxPressMs) {
      this.press = null;
      return;
    }
    this.later(() => {
      if (this.press !== press) return;
      this.press = null;
      if (!press.pageSaw) this.options.replay(press.at);
    }, this.graceMs);
  }
}
