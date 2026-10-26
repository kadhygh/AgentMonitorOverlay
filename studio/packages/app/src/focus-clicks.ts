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

// A drag of the title row (2026-10-26). A dropped press cannot be given back as a drag, and since the 10-22 fix only
// 移动位置 let Focus move: dragging the title row did nothing in runs where every press came with WM_MOUSEACTIVATE
// (10-25 from the morning on, after a night away; it starts mid-run, not per launch). WM_MOUSEACTIVATE reaches the
// main process before Chromium answers it, so a press on the title row makes the window activatable right there:
// Chromium then lets the press through and Windows' own move starts. When the move ends (WM_EXITSIZEMOVE) the window
// stops being activatable again; if no move started at all, after a while.

export interface CaptionDragOptions {
  /** Makes the window activatable (true) or not, handing focus on when it ends. */
  allow(on: boolean): void;
  /** Whether it is activatable already (移动位置 is on): then nothing needs doing. */
  allowed(): boolean;
  later?: (fn: () => void, ms: number) => void;
  /** How long after the press a move must have started before the window goes back to unactivatable. */
  startMs?: number;
}

export class CaptionDrag {
  private press: object | null = null;
  private moving = false;
  private readonly later: (fn: () => void, ms: number) => void;
  private readonly startMs: number;

  constructor(private readonly options: CaptionDragOptions) {
    this.later = options.later ?? ((fn, ms) => void setTimeout(fn, ms));
    this.startMs = options.startMs ?? 3000;
  }

  /** WM_MOUSEACTIVATE for a left press on the title row. Returns whether the window was made activatable. */
  pressed(): boolean {
    if (this.press) return false;
    if (this.options.allowed()) return false;
    const press = {};
    this.press = press;
    this.moving = false;
    this.options.allow(true);
    this.later(() => {
      if (this.press === press && !this.moving) this.end();
    }, this.startMs);
    return true;
  }

  /** WM_ENTERSIZEMOVE: Windows' move started. */
  entered(): void {
    if (this.press) this.moving = true;
  }

  /** WM_EXITSIZEMOVE: the move is over. */
  exited(): void {
    if (this.press) this.end();
  }

  private end(): void {
    this.press = null;
    this.moving = false;
    this.options.allow(false);
  }
}
