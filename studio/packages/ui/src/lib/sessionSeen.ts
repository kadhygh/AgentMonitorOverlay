import { useEffect, useState } from "react";
import type { Session } from "@amo-studio/protocol";

// When the person last looked at each session in the workbench (2026-10-15). Focus lists a session whose reply ended,
// or that failed, after that: 「完成待审核」/「出错」, until the person opens it in the main window (or in Focus).
// Kept in localStorage, which the workbench and Focus share (same origin), so Focus follows the main window at once
// through `storage` events; it is per machine, like the windows.

const KEY = "amo.sessionSeen";
/** Entries kept at most; the oldest go first. */
const MAX_ENTRIES = 500;

export interface SeenData {
  /** When this started being kept: what ended before it counts as seen (no flood of old sessions on first use). */
  since: string;
  /** Session id → when the person last looked at it. */
  seen: Record<string, string>;
}

export function readSeen(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): SeenData {
  try {
    const raw = storage?.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw) as Partial<SeenData>;
      if (typeof data.since === "string" && data.seen && typeof data.seen === "object") return { since: data.since, seen: data.seen };
    }
  } catch {
    // unreadable: start again
  }
  const fresh: SeenData = { since: new Date().toISOString(), seen: {} };
  try {
    storage?.setItem(KEY, JSON.stringify(fresh));
  } catch {
    // no storage: nothing is remembered
  }
  return fresh;
}

/** The person looked at these sessions now. */
export function markSeen(ids: readonly string[], at = new Date().toISOString(), storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): SeenData {
  const data = readSeen(storage);
  for (const id of ids) data.seen[id] = at;
  const entries = Object.entries(data.seen);
  if (entries.length > MAX_ENTRIES) data.seen = Object.fromEntries(entries.sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_ENTRIES));
  try {
    storage?.setItem(KEY, JSON.stringify(data));
  } catch {
    // no storage
  }
  return data;
}

/**
 * Sessions whose last reply ended (idle / completed) or failed since the person last looked: live main and fork
 * sessions only (a subagent ending is part of its parent's turn). Newest first.
 */
export function unseenSessions(sessions: readonly Session[], data: SeenData): Session[] {
  return sessions
    .filter((s) => !s.archivedAt && s.kind !== "sub" && (s.status === "idle" || s.status === "completed" || s.status === "error"))
    .filter((s) => s.updatedAt > maxIso(data.since, data.seen[s.id]))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The seen record, following changes made by the other windows. */
export function useSessionSeen(): SeenData {
  const [data, setData] = useState(() => readSeen());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) setData(readSeen());
    };
    const onLocal = () => setData(readSeen());
    window.addEventListener("storage", onStorage);
    window.addEventListener(LOCAL_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LOCAL_EVENT, onLocal);
    };
  }, []);
  return data;
}

/** `storage` events reach the other windows only; this tells this one. */
const LOCAL_EVENT = "amo:session-seen";

/** Marks sessions seen and tells this window's own listeners. */
export function noteSeen(ids: readonly string[]): void {
  if (!ids.length) return;
  markSeen(ids);
  window.dispatchEvent(new Event(LOCAL_EVENT));
}

/**
 * The workbench shows this session: it counts as seen while the window is visible (not minimised or fully covered) —
 * again whenever the session changes, and when the window shows again.
 */
export function useMarkSessionSeen(session: Pick<Session, "id" | "updatedAt" | "status"> | null): void {
  const id = session?.id ?? null;
  const version = session ? `${session.updatedAt}|${session.status}` : "";
  useEffect(() => {
    if (!id) return;
    const mark = () => {
      if (document.visibilityState === "visible") noteSeen([id]);
    };
    mark();
    window.addEventListener("focus", mark);
    document.addEventListener("visibilitychange", mark);
    return () => {
      window.removeEventListener("focus", mark);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [id, version]);
}

function maxIso(a: string, b: string | undefined): string {
  return b && b > a ? b : a;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
