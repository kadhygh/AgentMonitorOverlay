import { TOWER_DESC_MAX, TOWER_POINTS_MAX, TOWER_POINT_MAX, TOWER_TITLE_MAX, type Id, type TowerData, type TowerPoint } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { readTracks, writeTracks } from "../../core/tracks.js";
import { buildTower, splitRounds } from "./tower.js";

/** The sessions that are 脉络会话, so the workbench knows which to open as a building without asking for each. */
const ON_KEY = "tracks.on"; // a dot, not tracks:… — that prefix is the per-session key (core/tracks.ts), dropped with its session

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const words = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/**
 * 脉络的楼 (2026-11-15, protocol/src/tower.ts, plans/tracks.md; the user: 我们就直接走v7的流程，正好我用这个会话来迭代体验): a
 * session shown as a building. The building is put together from the session's rows each time it is asked for
 * (tower.ts), so nothing is kept for it but what the rows do not have: whether the session opens as its building, and
 * what its AI wrote about its rounds (track_note) — core/tracks.ts, which the sessions feature reads too.
 */
export class TracksFeature extends Feature<"teamRelay"> {
  get(sessionId: Id): TowerData {
    const session = this.requireSession(sessionId);
    // The sessions it started (session_start), archived ones too: they are part of what happened.
    const owner = session.taskId ? { taskId: session.taskId } : session.topicId ? { topicId: session.topicId } : null;
    const subs = owner ? this.store.listSessions(owner).filter((s) => s.startedBy === sessionId && s.kind !== "sub") : [];
    return buildTower({ session, items: this.store.listItems(sessionId), subs: subs.map((s) => ({ session: s, items: this.store.listItems(s.id) })), threads: this.f.teamRelay.threads(), state: readTracks(this.store, sessionId), now: Date.now() });
  }

  listOn(): Id[] {
    try {
      const ids = JSON.parse(this.store.getKv(ON_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(ids) ? ids.filter((id): id is Id => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  /** 脉络会话 on or off. Turned on, its AI is told with the person's next message (core/tracks.ts, tracksHint). */
  setOn(sessionId: Id, on: unknown): TowerData {
    this.requireSession(sessionId);
    if (typeof on !== "boolean") throw new HostError("bad_request", "on must be true or false");
    const state = readTracks(this.store, sessionId);
    if (state.on !== on) {
      writeTracks(this.store, sessionId, { ...state, on, toldAt: 0 });
      const rest = this.listOn().filter((id) => id !== sessionId);
      this.store.setKv(ON_KEY, JSON.stringify(on ? [...rest, sessionId] : rest));
      this.publish({ type: "tracks.changed", sessionId, on });
    }
    return this.get(sessionId);
  }

  /**
   * track_note: the session's AI titles its latest round (the floor the person sees it as), and notes what the person
   * stressed or what was settled. Answers with the floor and the points still open, so it can mark them done later.
   */
  note(sessionId: Id, input: { title?: unknown; desc?: unknown; points?: unknown; done?: unknown }): { floor: number; title: string; desc: string; open: Array<{ id: string; text: string }> } {
    this.requireSession(sessionId);
    const title = cut(words(input.title), TOWER_TITLE_MAX);
    const desc = cut(words(input.desc), TOWER_DESC_MAX);
    const added = (Array.isArray(input.points) ? input.points : []).map(words).filter(Boolean).map((p) => cut(p, TOWER_POINT_MAX));
    const done = new Set((Array.isArray(input.done) ? input.done : []).map((id) => String(id)));
    if (!title && !desc && !added.length && !done.size) throw new HostError("bad_request", "给 title（这一轮做了什么）、desc（一句结果）、points（要记下的事）或 done（做完的要点 id）中的至少一样");
    const round = splitRounds(this.store.listItems(sessionId)).rounds.at(-1);
    if (!round) throw new HostError("bad_request", "这个会话还没有一轮对话");
    const state = readTracks(this.store, sessionId);
    const was = state.rounds[round.firstId];
    const label = { title: title || was?.title || "", desc: desc || was?.desc || "" };
    const at = new Date().toISOString();
    let points: TowerPoint[] = state.points.map((p) => (done.has(p.id) ? { ...p, done: true } : p));
    let seq = points.reduce((max, p) => Math.max(max, Number(p.id.slice(1)) || 0), 0);
    for (const text of added) if (!points.some((p) => p.text === text)) points.push({ id: `p${++seq}`, text, round: round.n, at });
    // Past the limit the oldest go, the done ones first.
    while (points.length > TOWER_POINTS_MAX) {
      const drop = points.find((p) => p.done) ?? points[0]!;
      points = points.filter((p) => p !== drop);
    }
    writeTracks(this.store, sessionId, { ...state, rounds: label.title || label.desc ? { ...state.rounds, [round.firstId]: label } : state.rounds, points });
    this.publish({ type: "tracks.changed", sessionId, on: state.on });
    return { floor: round.n, ...label, open: points.filter((p) => !p.done).map((p) => ({ id: p.id, text: p.text })) };
  }
}
