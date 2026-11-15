import type { Id } from "./entities.js";

// 脉络的楼 (2026-11-15, plans/tracks.md, plans/collab-framework.md; the user: 我们就直接走v7的流程…允许前面每轮楼板上有信息缺失):
// one session as a building — a floor per round, the sub-sessions it started as regions on the floor that started them,
// what waits for someone on the roof, lines up the front for what is still going on. The Host puts it together from
// what it already keeps (rows, sessions, 中转 sessions); the session's own AI only adds a round's title and one line,
// and the points the person stressed (track_note). A round the AI wrote nothing for has a title made from its text.

/** Whom a thing waits for: `you` the person, `other` someone else, `ai` the AI works on it, `done`, `inter` said but not taken up. */
export type TowerMarkState = "you" | "other" | "ai" | "done" | "inter";
export interface TowerMark {
  s: TowerMarkState;
  t: string;
}

export interface TowerRound {
  /** 1-based, as the floors are numbered. */
  n: number;
  /** When it began, HH:MM (MM-DD HH:MM when not today). */
  time: string;
  title: string;
  desc: string;
  /** The AI wrote the title (track_note); else it is made from the round's text. */
  labelled: boolean;
  /** What the person said (or what came in, for a round a report or a reply started). */
  you: string;
  /** What it did, a line per step. */
  work: string[];
  /** Its reply, cut to a few thousand characters. */
  ai: string;
  items?: TowerMark[];
  /** The round's first row, to show it in the conversation. */
  itemId?: Id;
  /** A sub-session's round: the main session's floor at that time. */
  at?: number;
}

export interface TowerSession {
  /** A, B, C… in the order they were started. */
  key: string;
  sessionId: Id;
  title: string;
  /** The main session's floor that started it. */
  at: number;
  /** Its latest rounds (at most TOWER_SESSION_ROUNDS); `n` is the round's real number. */
  rounds: TowerRound[];
  /** How many rounds it has in all. */
  total: number;
  state: TowerMark;
}

/** What came back into the main session: a sub-session's report, a 中转 reply. A small card on the floor it arrived at. */
export interface TowerReport {
  key: string;
  /** The card it came from: a sub-session's round (A2) or the main round that asked (m7). */
  from: string;
  /** "main", or the sub-session's key. */
  sess: string;
  round: number;
  floor: number;
  title: string;
  desc: string;
  meta: string;
  itemId?: Id;
}

export interface TowerRoof {
  key: string;
  s: TowerMarkState;
  /** The card it comes from. */
  origin: string;
  title: string;
  desc: string;
  /** On the sign over the roof card, for what waits for the person. */
  sign?: string;
  /** The line (TowerLine.key) that goes on up to it: something asked that was answered once and waits again. */
  line?: string;
  sessionId?: Id;
  itemId?: Id;
}

/** Something the main session itself started and that came back on a later floor (a 中转 session answered): a line up the front between the two. */
export interface TowerLine {
  key: string;
  origin: string;
  from: number;
  to: number;
  s: TowerMarkState;
  title: string;
  /** Keys of the reports on it. */
  reps: string[];
}

/** What the person stressed or what was settled, as the AI noted it (track_note). */
export interface TowerPoint {
  id: string;
  text: string;
  done?: boolean;
  /** The floor it was noted on. */
  round?: number;
  at: string;
}

export interface TowerData {
  sessionId: Id;
  /** 脉络会话: the session opens as its building, and its AI is asked to title its rounds. */
  on: boolean;
  title: string;
  rounds: TowerRound[];
  sessions: TowerSession[];
  reports: TowerReport[];
  roof: TowerRoof[];
  lines: TowerLine[];
  /** The latest compaction: after which floor, and when. */
  compact: { after: number; time: string } | null;
  points: TowerPoint[];
  now: string;
}

export const TOWER_SESSION_ROUNDS = 4;
export const TOWER_TITLE_MAX = 24;
export const TOWER_DESC_MAX = 60;
export const TOWER_POINT_MAX = 120;
export const TOWER_POINTS_MAX = 60;
