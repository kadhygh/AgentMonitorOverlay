// 会话弹窗 as a window of its own (2026-11-16, the user: 脉络点击的弹窗要独立弹窗，不然会被限制拖动范围): the pure part —
// what a page may ask a window to show, its address, and which window is reused. round-window.ts does the windows.

/** A card picked in a building: the conversation of `sessionId` (the building's own session or one it started), at `itemId`. */
export interface RoundTarget {
  taskId: string;
  sessionId: string;
  /** The building's session (`sessionId` itself, or the session that started it). */
  towerFor: string;
  itemId?: string;
  /** The card's own words (「3F · 标题」), shown after the session's name. */
  title?: string;
}

const ID = /^[\w-]{1,80}$/;
const MAX_TITLE = 200;

const id = (v: unknown): string | null => (typeof v === "string" && ID.test(v) ? v : null);

/** The request as asked by a page, or null when it is not one. */
export function roundTarget(v: unknown): RoundTarget | null {
  const t = v as { taskId?: unknown; sessionId?: unknown; towerFor?: unknown; itemId?: unknown; title?: unknown } | null;
  const taskId = id(t?.taskId);
  const sessionId = id(t?.sessionId);
  const towerFor = id(t?.towerFor);
  if (!taskId || !sessionId || !towerFor) return null;
  const itemId = id(t?.itemId);
  const title = typeof t?.title === "string" ? t.title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TITLE) : "";
  return { taskId, sessionId, towerFor, ...(itemId ? { itemId } : {}), ...(title ? { title } : {}) };
}

/** `#round?task=…&session=…&tower=…&item=…&title=…&n=…`; `n` changes every time, so the same card asked again scrolls again. */
export function roundHash(t: RoundTarget, nonce: number): string {
  const q = new URLSearchParams({ task: t.taskId, session: t.sessionId, tower: t.towerFor });
  if (t.itemId) q.set("item", t.itemId);
  if (t.title) q.set("title", t.title);
  q.set("n", String(nonce));
  return `#round?${q.toString()}`;
}

/** What the workbench is told about each open window (amo:rounds). */
export interface RoundInfo {
  id: number;
  taskId: string;
  sessionId: string;
  towerFor: string;
  pinned: boolean;
}

/**
 * The open windows and which one is reused, as the viewer's (查看器): the one not pinned is reused for the next card;
 * a pinned one stays, and the next card opens a new one. `W` is the window (BrowserWindow in the app, anything in tests).
 */
export class RoundSet<W> {
  private preview: W | null = null;
  private readonly open = new Map<W, { id: number; target: RoundTarget; pinned: boolean }>();
  private next = 1;

  /** Where a card goes: the window to reuse, or null to make a new one (then call `created`). */
  target(): W | null {
    return this.preview;
  }

  created(win: W, target: RoundTarget): void {
    this.open.set(win, { id: this.next++, target, pinned: false });
    this.preview = win;
  }

  /** The reused window shows another card. */
  shown(win: W, target: RoundTarget): void {
    const e = this.open.get(win);
    if (e) e.target = target;
  }

  /** 固定: the window stays; the next card opens a new one. False when `win` is not one of them. */
  pin(win: W): boolean {
    const e = this.open.get(win);
    if (!e) return false;
    e.pinned = true;
    if (this.preview === win) this.preview = null;
    return true;
  }

  isPinned(win: W): boolean {
    return !!this.open.get(win)?.pinned;
  }

  targetOf(win: W): RoundTarget | null {
    return this.open.get(win)?.target ?? null;
  }

  closed(win: W): void {
    this.open.delete(win);
    if (this.preview === win) this.preview = null;
  }

  /** The windows of a building: its one not pinned, or (`all`) every one. */
  ofTower(towerFor: string, all: boolean): W[] {
    return [...this.open].filter(([, e]) => e.target.towerFor === towerFor && (all || !e.pinned)).map(([w]) => w);
  }

  /** The window to bring forward for a session: the one not pinned, else the last pinned one opened. */
  showing(sessionId: string): W | null {
    const all = [...this.open].filter(([, e]) => e.target.sessionId === sessionId);
    return (all.find(([, e]) => !e.pinned) ?? all.at(-1))?.[0] ?? null;
  }

  all(): W[] {
    return [...this.open.keys()];
  }

  list(): RoundInfo[] {
    return [...this.open.values()].map((e) => ({ id: e.id, taskId: e.target.taskId, sessionId: e.target.sessionId, towerFor: e.target.towerFor, pinned: e.pinned }));
  }
}
