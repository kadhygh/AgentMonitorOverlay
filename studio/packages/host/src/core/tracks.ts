import { TOWER_DESC_MAX, TOWER_TITLE_MAX, type Id, type TowerPoint } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// 脉络会话 (2026-11-15, protocol/src/tower.ts): what Studio keeps for a session beside its rows — whether it opens as its
// building, the titles its AI gave its rounds, the points it noted. One kv row per session (`tracks:<sessionId>`); here
// rather than in features/tracks so the sessions feature can read it without depending on that one (which reads 中转,
// which reads sessions).

export interface TracksState {
  on: boolean;
  /** The seq of the session's last row when its AI was last told to title its rounds (0: not yet). */
  toldAt: number;
  /** By the id of a round's first row. */
  rounds: Record<Id, { title: string; desc: string }>;
  points: TowerPoint[];
}

const key = (sessionId: Id) => `tracks:${sessionId}`;

export function readTracks(store: Store, sessionId: Id): TracksState {
  const empty: TracksState = { on: false, toldAt: 0, rounds: {}, points: [] };
  const raw = store.getKv(key(sessionId))?.value;
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<TracksState>;
    return { on: v.on === true, toldAt: Number(v.toldAt) || 0, rounds: v.rounds && typeof v.rounds === "object" ? v.rounds : {}, points: Array.isArray(v.points) ? v.points : [] };
  } catch {
    return empty;
  }
}

export function writeTracks(store: Store, sessionId: Id, state: TracksState): void {
  store.setKv(key(sessionId), JSON.stringify(state));
}

/**
 * What a 脉络会话's AI is told with the person's next message — once after it is turned on, and again after each
 * compaction (it has forgotten by then). `told()` once the message went in. Empty when there is nothing to say.
 */
export function tracksHint(store: Store, sessionId: Id): { lines: string[]; told(): void } {
  const none = { lines: [], told: () => undefined };
  const state = readTracks(store, sessionId);
  if (!state.on) return none;
  const [compaction] = store.findItems(sessionId, "compaction", {}, { newest: true, limit: 1 });
  if (state.toldAt > 0 && (!compaction || compaction.seq < state.toldAt)) return none;
  return {
    lines: [
      `这个会话开了「脉络」：人把它当一栋楼看，每一轮是一层。每一轮快结束时调一次 track_note：title 写这一轮做了什么（${TOWER_TITLE_MAX / 2} 个字以内），desc 写一句结果或现状（${TOWER_DESC_MAX / 2} 个字以内）；人强调要做的事、谈定的结论，用 points 各记一句。只写这一轮新发生的，不要为它多跑一轮。`,
    ],
    told: () => {
      const last = store.listLastItems(sessionId, 1)[0];
      writeTracks(store, sessionId, { ...readTracks(store, sessionId), toldAt: last?.seq ?? 1 });
    },
  };
}
