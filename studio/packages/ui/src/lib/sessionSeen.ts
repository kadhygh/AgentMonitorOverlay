import { useEffect, useState } from "react";
import type { Session, Task } from "@amo-studio/protocol";
import { needsPerson } from "./status.js";

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
  if (entries.length > MAX_ENTRIES) {
    const sorted = entries.sort((a, b) => b[1].localeCompare(a[1]));
    data.seen = Object.fromEntries(sorted.slice(0, MAX_ENTRIES));
    // 2026-11-04: a session dropped here fell back to `since` and, ended after it, came back to Focus as 完成待审核
    // (the oldest looked-at ones, all at once). What was dropped was seen by then: `since` moves up to it.
    data.since = maxIso(data.since, sorted[MAX_ENTRIES]![1]);
  }
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
 * 2026-10-21: not while a subagent of theirs still runs — a Claude session ends its turn right after starting
 * background agents and takes a moment's turn as each one reports, which made Focus call it finished again and again.
 * When the last one ends counts as the session changing, so the person hears of it once, at the end.
 */
export function unseenSessions(sessions: readonly Session[], data: SeenData): Session[] {
  // 2026-10-27: only what reports back folds into its starter. A 委派 session that does not report (its result stays in
  // it, often one the person was meant to work in) is listed itself when it ends, so 完成待审核 opens it, not its starter.
  const under = hangsUnderOf(sessions);
  const folded = (s: Session) => !!under(s) && (s.kind === "sub" || s.reportTo === s.startedBy);
  const subs = new Map<string, Session[]>();
  for (const [up, list] of subsByParent(sessions)) {
    const kept = list.filter(folded);
    if (kept.length) subs.set(up, kept);
  }
  return sessions
    .filter((s) => !s.archivedAt && s.kind !== "sub" && !folded(s) && (s.status === "idle" || s.status === "completed" || s.status === "interrupted" || s.status === "error"))
    .filter((s) => !subs.get(s.id)?.some((x) => x.status === "running"))
    .filter((s) => lastChange(s, subs) > maxIso(data.since, data.seen[s.id]))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The subagents (and 委派 sessions) under this one cut off since the person last looked at it (2026-10-28): Focus marks
 * the entry red for them, the session itself having ended otherwise.
 */
export function interruptedSince(session: Session, sessions: readonly Session[], data: SeenData): Session[] {
  const after = maxIso(data.since, data.seen[session.id]);
  return (subsByParent(sessions).get(session.id) ?? []).filter((s) => s.status === "interrupted" && s.updatedAt > after);
}

/** Whether the workbench opening this session is the person coming to deal with it: it waits, or ended unseen. */
export function awaitsPerson(session: Session, sessions: readonly Session[], data: SeenData): boolean {
  return needsPerson(session.status) || unseenSessions([session, ...sessions.filter((s) => s.parentId === session.id || s.startedBy === session.id)], data).length > 0;
}

/**
 * The session a row hangs under rather than standing on its own: a subagent's parent, and (委派, 2026-10-22) the
 * session that started a session with session_start, while that one is live. Null for a session of its own.
 */
export function hangsUnderOf(sessions: readonly Session[]): (s: Session) => string | null {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return (s) => {
    if (s.kind === "sub") return s.parentId;
    if (s.parentId || !s.startedBy) return null;
    const starter = byId.get(s.startedBy);
    return starter && !starter.archivedAt ? starter.id : null;
  };
}

/** Live subagent sessions (and 委派 ones) by the id of the session they hang under. */
export function subsByParent(sessions: readonly Session[]): Map<string, Session[]> {
  const under = hangsUnderOf(sessions);
  const by = new Map<string, Session[]>();
  for (const s of sessions) {
    const up = s.archivedAt ? null : under(s);
    if (!up) continue;
    const list = by.get(up);
    if (list) list.push(s);
    else by.set(up, [s]);
  }
  return by;
}

/** A session's subagents still running. */
export function runningSubs(id: string, subs: ReadonlyMap<string, readonly Session[]>): Session[] {
  return (subs.get(id) ?? []).filter((s) => s.status === "running");
}

/** When the session or one of its subagents last changed. */
function lastChange(s: Session, subs: ReadonlyMap<string, readonly Session[]>): string {
  return (subs.get(s.id) ?? []).reduce((at, x) => (x.updatedAt > at ? x.updatedAt : at), s.updatedAt);
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
 * The seen record with what a copy of another computer's task (远程) had before it was granted here counted as seen
 * (问题 2026-11-04: after a task was granted to this computer, Focus here listed every session of it that had ended
 * long before as 完成待审核). Its sessions come with that computer's times, all after this one began keeping; what
 * ended there before the grant was never this computer's to review. Both times are that computer's clock.
 */
export function withGrants(data: SeenData, tasks: readonly Pick<Task, "id" | "remote">[], sessions: readonly Pick<Session, "id" | "taskId">[]): SeenData {
  const granted = new Map<string, string>();
  for (const t of tasks) if (t.remote?.grantedAt) granted.set(t.id, t.remote.grantedAt);
  if (!granted.size) return data;
  let seen: Record<string, string> | null = null;
  for (const s of sessions) {
    const at = s.taskId ? granted.get(s.taskId) : undefined;
    if (!at || at <= maxIso(data.since, data.seen[s.id])) continue;
    seen ??= { ...data.seen };
    seen[s.id] = at;
  }
  return seen ? { since: data.since, seen } : data;
}

/**
 * A session came back from the archive (问题 2026-11-03: restoring a done task flooded Focus). The Host stamps every
 * restored session with the time of restoring, so each one that had ended looked like a reply that just ended unseen
 * — the task's sessions, forks and 委派 ones all at once. Restoring is the person dealing with it, so it counts as
 * seen; with the session it hangs under, whose last change takes in its subagents' and 委派 sessions' (restored a
 * moment later each).
 */
export function noteRestored(session: Session): void {
  const under = session.kind === "sub" ? session.parentId : session.parentId ? null : session.startedBy;
  noteSeen(under ? [session.id, under] : [session.id]);
}

/**
 * The workbench shows this session. Opening it counts as seeing it (while the window is visible). A change while it
 * stays open — the reply ending, a failure — counts as seen only at the person's next sign of being there: the window
 * coming forward, or a click, key or wheel in it. Before 2026-10-20 the window merely being visible was enough, so a
 * reply that ended while the person was away, with Studio left on that session, never showed in Focus.
 */
export function useMarkSessionSeen(session: Pick<Session, "id" | "updatedAt" | "status"> | null): void {
  const id = session?.id ?? null;
  const version = session ? `${session.updatedAt}|${session.status}` : "";
  useEffect(() => {
    if (id && document.visibilityState === "visible") noteSeen([id]);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const ACTS = ["pointerdown", "keydown", "wheel"] as const;
    const stop = () => {
      window.removeEventListener("focus", mark);
      document.removeEventListener("visibilitychange", mark);
      for (const a of ACTS) window.removeEventListener(a, mark, true);
    };
    function mark() {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      noteSeen([id!]);
      // Once per change: typing on afterwards does not write the record again.
      stop();
    }
    window.addEventListener("focus", mark);
    document.addEventListener("visibilitychange", mark);
    for (const a of ACTS) window.addEventListener(a, mark, true);
    return stop;
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
