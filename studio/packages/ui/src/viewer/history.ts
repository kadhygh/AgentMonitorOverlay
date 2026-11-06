import { useSyncExternalStore } from "react";

// 查看器的返回 (2026-11-06): the viewer window is reused for the next file (until 锁定), so a link followed in a page
// used to leave no way back (the user clicked a picture in an HTML report). The window keeps the files it showed, in
// memory only: ← in its title bar, Alt+←, the mouse's back button. A rendered page also comes back where it was scrolled.

/** Where a rendered file was scrolled to, by its path (a 查看包 has several files: only the same one takes it). */
export type ScrollMark = { path: string; y: number };

type Entry = { hash: string; scroll: ScrollMark | null };

const MAX = 50;
const stack: Entry[] = [];
let current: string | null = null;
let goingBack = false;
let pending: ScrollMark | null = null;
let reader: (() => ScrollMark | null) | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** The window's first hash. */
export function startHistory(hash: string): void {
  current = hash;
}

/** A new hash arrived: the one it replaces goes on the stack, with its scroll (unless this is the way back). */
export function hashArrived(hash: string): void {
  if (hash === current) return;
  if (goingBack) goingBack = false;
  else if (current?.startsWith("#viewer")) {
    stack.push({ hash: current, scroll: reader?.() ?? null });
    if (stack.length > MAX) stack.shift();
    pending = null;
  }
  current = hash;
  changed();
}

/** Back to the file shown before; false when there is none. */
export function goBack(): boolean {
  const e = stack.pop();
  if (!e) return false;
  goingBack = true;
  pending = e.scroll;
  changed();
  location.hash = e.hash;
  return true;
}

export const canGoBack = () => stack.length > 0;

export function useCanGoBack(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    canGoBack,
  );
}

/** The rendered file on show tells where it is scrolled; returns the way to stop (when it goes). */
export function readScrollWith(read: () => ScrollMark | null): () => void {
  reader = read;
  return () => {
    if (reader === read) reader = null;
  };
}

/** Where `path` was left, once, when the window came back to it. */
export function takeScroll(path: string): number | null {
  if (!pending || pending.path !== path) return null;
  const y = pending.y;
  pending = null;
  return y;
}

/** Alt+← and the mouse's back button (in the window; a page's frame forwards its own). */
export const isBackKey = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key === "ArrowLeft";
