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
  const pending = read(store).pending[sessionId] ?? {};
  if (!Object.keys(pending).length) return null;
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

// ---- the role in each 协作 (2026-11-24, plans/collab-agent-spec.md §1: 「amo_whoami 也给这一段」)

const CARDS_KEY = "teamrelay.cowork.cards";

/** What amo_whoami says of the session in a 协作: its role, its card and its 待我处理 count (teamrelay writes it on each refresh). */
export interface CoworkCard {
  coworkId: string;
  title: string;
  role: string;
  card: string;
  pending: number;
}

export function writeCoworkCards(store: Store, cards: Record<Id, CoworkCard[]>): void {
  const value = JSON.stringify(cards);
  if (store.getKv(CARDS_KEY)?.value !== value) store.setKv(CARDS_KEY, value);
}

export function coworkCards(store: Store, sessionId: Id): CoworkCard[] {
  try {
    return (JSON.parse(store.getKv(CARDS_KEY)?.value ?? "{}") as Record<Id, CoworkCard[]>)[sessionId] ?? [];
  } catch {
    return [];
  }
}

// ---- after a compaction (2026-11-24, plans/collab-agent-spec.md §6)

/**
 * Said with the next message once the session was compacted, while it is in a 协作 — followed by its whole current role
 * card (sessions/service.ts roleUpdate, 2026-11-25: the card in its instructions is the one it started with, and what
 * changed since was only in messages the compaction dropped).
 */
export const COMPACTED_LINE = "你的上下文刚被压缩，之前的对话不在了。先用 cowork_read 按三层接上：不带参数看待你处理和概况，要动的事项带 threadId 看细节；然后在回复开头用一两句写现在到哪了、该你做什么，再接着做。不要凭记忆接着做；已经做过的（开过的事项、派过的执行、问过的人）看事项细节，不要再做一遍。你现在的角色卡：";
const COMPACTED_KEY = "teamrelay.cowork.compacted:";

/** The newest compaction not told yet while the session is in a 协作; `told()` once the message saying so went out. */
export function coworkCompaction(store: Store, sessionId: Id): { told: () => void } | null {
  if (!coworkCards(store, sessionId).length) return null;
  const [compaction] = store.findItems(sessionId, "compaction", {}, { newest: true, limit: 1 });
  if (!compaction) return null;
  const told = Number(store.getKv(`${COMPACTED_KEY}${sessionId}`)?.value ?? 0);
  if (compaction.seq <= told) return null;
  return { told: () => store.setKv(`${COMPACTED_KEY}${sessionId}`, String(compaction.seq)) };
}

/** Joining a 协作: a compaction from before is not news to it. */
export function compactionKnown(store: Store, sessionId: Id): void {
  const [compaction] = store.findItems(sessionId, "compaction", {}, { newest: true, limit: 1 });
  if (compaction) store.setKv(`${COMPACTED_KEY}${sessionId}`, String(compaction.seq));
}
