import { useSyncExternalStore } from "react";
import type { Scope } from "../board/Board.js";
import type { View } from "./views.js";
import { samePlace as sameReadPlace, type ReadPlace } from "../task/readPlace.js";

// 后退 / 前进 (2026-10-19, after VS Code's Go Back): the places the workbench has been, so Alt+← returns to the session
// that was being read — at the place it was read to — after Focus or a bookmark took the person elsewhere. A place is
// a view (a task page with its session, the board, the canvas…) with the scope; scrolling and panning are not steps.
// Kept for this window's life only, at most MAX places back.

export interface Place {
  view: View;
  scope: Scope;
  /** A task page's conversation: where it was read (task/readPlace), noted as it scrolls. */
  scroll?: ReadPlace;
}

export const MAX = 50;

const scopeKey = (s: Scope) => (s.kind === "all" ? "all" : `${s.kind}:${s.id}`);

/** Whether two places are the same step (a task page with another session is another step). */
export function samePlace(a: Place, b: Place): boolean {
  if (a.view.kind !== b.view.kind || scopeKey(a.scope) !== scopeKey(b.scope)) return false;
  if (a.view.kind === "task" && b.view.kind === "task") return a.view.taskId === b.view.taskId && (a.view.sessionId ?? null) === (b.view.sessionId ?? null);
  if (a.view.kind === "packs" && b.view.kind === "packs") return a.view.workspaceId === b.view.workspaceId;
  return true;
}

export interface NavState {
  back: Place[];
  current: Place | null;
  forward: Place[];
  /**
   * A session a task page picked before its place was recorded (a page's effects run before the shell's): the place
   * gets it when it comes.
   */
  picked?: { taskId: string; sessionId: string };
}

export const EMPTY: NavState = { back: [], current: null, forward: [] };

/** Going somewhere: the place left goes on the back list (the forward list is dropped, as in a browser). */
export function visit(s: NavState, arriving: Place): NavState {
  const { picked, ...rest } = s;
  s = rest;
  const place =
    arriving.view.kind === "task" && !arriving.view.sessionId && picked?.taskId === arriving.view.taskId ? { ...arriving, view: { ...arriving.view, sessionId: picked.sessionId } } : arriving;
  if (!s.current) return { ...s, current: place };
  if (samePlace(s.current, place)) return { ...s, current: { ...place, ...(s.current.scroll !== undefined && place.scroll === undefined ? { scroll: s.current.scroll } : {}) } };
  return { back: [...s.back, s.current].slice(-MAX), current: place, forward: [] };
}

/**
 * The task page picked a session: the place it was opened as gets it (opened without one), or, when it had another,
 * this is a step of its own.
 */
export function pickSession(s: NavState, taskId: string, sessionId: string): NavState {
  const cur = s.current;
  if (!cur || cur.view.kind !== "task" || cur.view.taskId !== taskId) return { ...s, picked: { taskId, sessionId } };
  if (cur.view.sessionId === sessionId) return s;
  if (!cur.view.sessionId) return { ...s, current: { ...cur, view: { ...cur.view, sessionId } } };
  const { passage: _passage, ...view } = cur.view;
  return visit(s, { view: { ...view, sessionId }, scope: cur.scope });
}

/** How far the current place's conversation is read (only while it is that session's). */
export function noteScroll(s: NavState, sessionId: string, scroll: ReadPlace): NavState {
  const cur = s.current;
  if (!cur || cur.view.kind !== "task" || cur.view.sessionId !== sessionId || sameReadPlace(cur.scroll, scroll)) return s;
  return { ...s, current: { ...cur, scroll } };
}

/**
 * One step back (dir -1) or forward (1), skipping places that are gone (`alive` false: a deleted task); null when
 * there is nowhere to go.
 */
export function step(s: NavState, dir: -1 | 1, alive: (p: Place) => boolean): { state: NavState; place: Place } | null {
  if (!s.current) return null;
  const from = dir < 0 ? [...s.back] : [...s.forward];
  const to = dir < 0 ? [...s.forward] : [...s.back];
  let next = from.pop();
  // A gone place is dropped on the way.
  while (next && !alive(next)) next = from.pop();
  if (!next) return null;
  to.push(s.current);
  return { state: dir < 0 ? { back: from, current: next, forward: to } : { back: to, current: next, forward: from }, place: next };
}

// ---- the window's history --------------------------------------------------------------------------------------

let state: NavState = EMPTY;
const listeners = new Set<() => void>();
const set = (next: NavState) => {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
};

export const navHistory = {
  get: () => state,
  visit: (place: Place) => set(visit(state, place)),
  pickSession: (taskId: string, sessionId: string) => set(pickSession(state, taskId, sessionId)),
  noteScroll: (sessionId: string, scroll: ReadPlace) => set(noteScroll(state, sessionId, scroll)),
  /** Moves and returns the place to show, or null. */
  step(dir: -1 | 1, alive: (p: Place) => boolean): Place | null {
    const r = step(state, dir, alive);
    if (!r) return null;
    set(r.state);
    return r.place;
  },
  reset: () => set(EMPTY),
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Whether there is somewhere to go back or forward to (the top bar's arrows). */
export function useNavHistory(): { canBack: boolean; canForward: boolean } {
  const s = useSyncExternalStore(subscribe, () => state);
  return { canBack: s.back.length > 0, canForward: s.forward.length > 0 };
}
