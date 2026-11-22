import type { Id } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// 协作 (2026-11-23, plans/cowork.md): what a session in a 协作 is told with the person's next message — that it was brought
// in (once), and 「协作里有 N 条新的」 when people talked there without @-ing it (other chat wakes no agent: the plan's
// 「它下次醒来时由 Host 带一句」). teamrelay/cowork.ts writes the lines; the person's send (sessions/service.ts) and a
// delivery from the 协作 take them. In kv, so it does not tie the sessions feature to teamrelay.

const KEY = "teamrelay.cowork.tell";

interface Tell {
  /** Lines waiting to be said, by what they are about (a newer line about the same thing replaces the older). */
  pending: Record<Id, Record<string, { line: string; n: number }>>;
  /** What was last said, by the same keys: the unread count it told (so the same count is not said twice). */
  told: Record<Id, Record<string, number>>;
}

function read(store: Store): Tell {
  try {
    const v = JSON.parse(store.getKv(KEY)?.value ?? "{}") as Partial<Tell>;
    return { pending: v.pending ?? {}, told: v.told ?? {} };
  } catch {
    return { pending: {}, told: {} };
  }
}

function write(store: Store, t: Tell): void {
  store.setKv(KEY, JSON.stringify(t));
}

/** Says `line` with the session's next message (null: nothing to say about `key` any more). `n`: the count it tells. */
export function setCoworkTell(store: Store, sessionId: Id, key: string, line: string | null, n = 0): void {
  const t = read(store);
  const mine = { ...(t.pending[sessionId] ?? {}) };
  if (line) mine[key] = { line, n };
  else delete mine[key];
  if (Object.keys(mine).length) t.pending[sessionId] = mine;
  else delete t.pending[sessionId];
  write(store, t);
}

/** What was last told about `key` (an unread count), 0 when nothing. */
export function coworkTold(store: Store, sessionId: Id, key: string): number {
  return read(store).told[sessionId]?.[key] ?? 0;
}

/** Forget what was told about `key` (it read them: the next new ones are told again). */
export function resetCoworkTold(store: Store, sessionId: Id, key: string): void {
  const t = read(store);
  if (t.told[sessionId]?.[key] === undefined) return;
  delete t.told[sessionId]![key];
  write(store, t);
}

/** The lines for the session's next message; `told()` once they went with it. */
export function coworkHint(store: Store, sessionId: Id): { lines: string[]; told: () => void } | null {
  const pending = read(store).pending[sessionId];
  if (!pending || !Object.keys(pending).length) return null;
  const entries = Object.entries(pending);
  return {
    lines: entries.map(([, v]) => v.line),
    told: () => {
      const t = read(store);
      const told = { ...(t.told[sessionId] ?? {}) };
      for (const [k, v] of entries) told[k] = v.n;
      t.told[sessionId] = told;
      const left = { ...(t.pending[sessionId] ?? {}) };
      for (const [k] of entries) delete left[k];
      if (Object.keys(left).length) t.pending[sessionId] = left;
      else delete t.pending[sessionId];
      write(store, t);
    },
  };
}
