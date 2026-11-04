import { useEffect, useSyncExternalStore } from "react";
import type { DutyItem, DutyState, Id } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { watchLive } from "../host/live.js";

// 值守 outside 设置 (2026-10-31, the user: 「studio里应该需要一个查看duty的界面，并且如果有task/session开启了duty 能够看到
// duty标记」): one copy of the Host's DutyState for the top bar's button and panel, the board's cards, the task head and
// the session list. The shell starts it (useDutyWatch); the rest read it (useDuty).

let current: DutyState | null = null;
const listeners = new Set<() => void>();
function set(next: DutyState): void {
  current = next;
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Loads DutyState and keeps it live while the shell is up. */
export function useDutyWatch(link: HostLink | null): void {
  useEffect(() => {
    if (!link) return;
    const w = watchLive<DutyState | null>(
      () => ({ load: () => call(link, "GET /api/duty"), initial: null, onEvent: (cur, e) => (e.type === "duty.updated" ? e.duty : cur) }),
      (next) => {
        const value = next(current);
        if (value && value !== current) set(value);
      },
    );
    return w.stop;
  }, [link]);
}

export function useDuty(): DutyState | null {
  return useSyncExternalStore(subscribe, () => current);
}

// The shell's dialog, opened from a mark (the task head's 值守).
let opener: (() => void) | null = null;
export function setDutyOpener(open: (() => void) | null): void {
  opener = open;
}
export function openDuty(): void {
  opener?.();
}

/** For tests and the panel's own changes (the Host's answer is the new state). */
export function setDuty(next: DutyState): void {
  set(next);
}

/** The items that open sessions in this task and are on. */
export function dutyOfTask(duty: DutyState | null, taskId: Id): DutyItem[] {
  return (duty?.items ?? []).filter((i) => i.enabled && i.action.kind === "session" && i.action.taskId === taskId);
}

/** What 值守 has to do with a session: it started it (the item, when it is still there), or the session set items up. */
export function dutyOfSession(duty: DutyState | null, sessionId: Id): { startedBy: DutyItem | null; started: boolean; set: DutyItem[] } {
  const itemId = duty?.sessions[sessionId];
  return {
    started: !!itemId,
    startedBy: (itemId && duty?.items.find((i) => i.id === itemId)) || null,
    set: (duty?.items ?? []).filter((i) => i.setBy === sessionId),
  };
}

/**
 * The items in list order, each child right under its parent (2026-11-01: 自动打包 under 日常值守). `first` orders the
 * top-level ones (the panel: those on first); children keep their saved order.
 */
export function dutyTree(items: readonly DutyItem[], first?: (a: DutyItem, b: DutyItem) => number): Array<{ item: DutyItem; parent: DutyItem | null }> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const top = items.filter((i) => !i.parentId || !byId.has(i.parentId));
  return (first ? [...top].sort(first) : top).flatMap((p) => [{ item: p, parent: null }, ...items.filter((c) => c.parentId === p.id).map((c) => ({ item: c, parent: p }))]);
}
