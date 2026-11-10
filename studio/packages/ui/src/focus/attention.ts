import { readStored, writeStored } from "../lib/stored.js";

// When the Focus robot dances (S14-J): something needs the person that they have not acknowledged yet. Each thing gets
// a key; clicking the robot or the list acknowledges every key on screen; a key that goes away (handled) is forgotten,
// so the same session asking again later makes the robot come back.

/** Keys of what needs the person now: sessions (with what they wait for), open decisions, scheduler proposals. */
export function attentionKeys(sessions: ReadonlyArray<{ id: string; status: string }>, decisionIds: readonly string[], proposalIds: readonly string[]): string[] {
  return [...sessions.map((s) => `s:${s.id}:${s.status}`), ...decisionIds.map((id) => `d:${id}`), ...proposalIds.map((id) => `p:${id}`)];
}

/** The acknowledged keys still on screen. */
export function pruneSeen(seen: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const now = new Set(keys);
  return new Set([...seen].filter((k) => now.has(k)));
}

/** Left this long without the person looking, the robot gets angry and flies about the screen (2026-10-15 evening). */
export const ANGRY_AFTER_MS = 5 * 60_000;

/** When each key on screen first appeared: kept for the ones still there, now for new ones, gone ones forgotten. */
export function trackFirstSeen(before: ReadonlyMap<string, number>, keys: readonly string[], now: number): Map<string, number> {
  return new Map(keys.map((k) => [k, before.get(k) ?? now]));
}

/** How long the oldest thing the person has not acknowledged has waited, in ms (0 when nothing waits). */
export function longestWait(keys: readonly string[], seen: ReadonlySet<string>, firstSeen: ReadonlyMap<string, number>, now: number): number {
  return Math.max(0, ...keys.filter((k) => !seen.has(k)).map((k) => now - (firstSeen.get(k) ?? now)));
}

/** Whether something on screen is new to the person. */
export function shouldAlert(keys: readonly string[], seen: ReadonlySet<string>): boolean {
  return keys.some((k) => !seen.has(k));
}

const LOCK_KEY = "amo.focusLocked";

/** 锁定位置: the Focus window cannot be dragged. Per machine, like where it was left. */
export const readFocusLocked = (): boolean => readStored(LOCK_KEY) === "1";
export const writeFocusLocked = (on: boolean): void => writeStored(LOCK_KEY, on ? "1" : "0");

const PASSTHROUGH_KEY = "amo.focusPassthrough";

/** 点击穿透 (2026-10-15): clicks on Focus go to the window below, except on its buttons. Off by default. */
export const readFocusPassthrough = (): boolean => readStored(PASSTHROUGH_KEY) === "1";
export const writeFocusPassthrough = (on: boolean): void => writeStored(PASSTHROUGH_KEY, on ? "1" : "0");

const COLLAPSED_KEY = "amo.focusCollapsed";
const AUTO_EXPAND_KEY = "amo.focusAutoExpand";

/**
 * 收起成悬浮块 (2026-11-10, the user: 收起成一行优化一下，变成缩成一个图标带底部块的悬浮小块 … 不勾选，默认收起): Focus
 * rests as a small tile — collapsed unless the person opened it — and opens by itself when something needs them.
 */
export const readFocusCollapsed = (): boolean => readStored(COLLAPSED_KEY) !== "0";
export const writeFocusCollapsed = (on: boolean): void => writeStored(COLLAPSED_KEY, on ? "1" : "0");
/** 自动展开: the tile opens while the pointer is over it, and folds when it leaves. Off by default. */
export const readFocusAutoExpand = (): boolean => readStored(AUTO_EXPAND_KEY) === "1";
export const writeFocusAutoExpand = (on: boolean): void => writeStored(AUTO_EXPAND_KEY, on ? "1" : "0");

/**
 * The tile's bottom strip (design A, plans/done/focus-mini.md): the one thing that matters most, as one number — what needs
 * the person, else finished work to look at, else what is running.
 */
export function miniStatus(needs: number, toReview: number, running: number): { tone: "att" | "done" | "run" | "idle"; text: string; title: string } {
  const title = [needs ? `需要你 ${needs}` : "", toReview ? `完成待看 ${toReview}` : "", running ? `运行中 ${running}` : ""].filter(Boolean).join(" · ") || "没有待处理";
  if (needs) return { tone: "att", text: `! ${needs}`, title };
  if (toReview) return { tone: "done", text: `✓ ${toReview}`, title };
  if (running) return { tone: "run", text: `▶ ${running}`, title };
  return { tone: "idle", text: "—", title };
}

/** Whether the folded Focus opens by itself: something that needs the person is new since it last looked (`prev`). */
export function opensFocus(prev: ReadonlySet<string> | null, now: readonly string[]): boolean {
  return now.length > 0 && (!prev || now.some((k) => !prev.has(k)));
}

/** What still answers clicks under 点击穿透: buttons, fields and links, and the settings box. */
export const PASSTHROUGH_INTERACTIVE = "button, a[href], input, textarea, select, summary, [role=button], .focus-pop";

/** The window parts to keep, from the elements' boxes: a few pixels around each for the glow, inside the window. */
export function shapeRects(boxes: ReadonlyArray<{ left: number; top: number; width: number; height: number }>, win: { width: number; height: number }, margin = 8): Array<{ x: number; y: number; width: number; height: number }> {
  return boxes
    .filter((b) => b.width > 0 && b.height > 0)
    .map((b) => {
      const x = Math.max(0, Math.floor(b.left - margin));
      const y = Math.max(0, Math.floor(b.top - margin));
      const right = Math.min(win.width, Math.ceil(b.left + b.width + margin));
      const bottom = Math.min(win.height, Math.ceil(b.top + b.height + margin));
      return { x, y, width: right - x, height: bottom - y };
    })
    .filter((r) => r.width > 0 && r.height > 0);
}
