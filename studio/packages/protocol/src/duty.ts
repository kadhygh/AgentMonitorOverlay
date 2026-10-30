import type { Id, SessionOptions, Timestamp } from "./entities.js";

// 值守 (duty, 2026-10-31, plans/issues.md): the Host does something at set times or when there is something to do —
// starts a session with a set prompt, runs a command, or runs one of Studio's own jobs (问题页's, stage 3). The waiting,
// the counting and the clock are code: a model is started only when an item's action is a session. Named apart from
// Claude Code's /loop and Codex's goal on purpose (the user, 2026-10-31).

/** When an item runs: every so many seconds, or once a day at a local time. */
export type DutySchedule = { every: number } | { daily: string };

/** At least this many seconds between two runs of an item. */
export const DUTY_MIN_EVERY = 10;

export type DutyAction =
  /**
   * A session with `prompt`: in task `taskId`, or (without one) in a new task titled `taskTitle` in project
   * `workspaceId`. `options`: model, effort and permissions for `profileId` (its defaults otherwise; an unattended
   * run usually wants a permission that does not stop to ask). `fallbackProfileId`: used, with its own defaults, when
   * the first one's subscription is (nearly) used up.
   */
  | { kind: "session"; profileId: Id; prompt: string; taskId?: Id | null; workspaceId?: Id | null; taskTitle?: string; options?: SessionOptions; fallbackProfileId?: Id | null }
  /** A command line, run in project `workspaceId`'s folder (the common folder without one), below normal priority. */
  | { kind: "command"; command: string; workspaceId?: Id | null; timeoutSec?: number }
  /** One of Studio's own jobs, by name (DutyState.builtins lists them). */
  | { kind: "builtin"; name: string };

export interface DutyItem {
  id: Id;
  title: string;
  enabled: boolean;
  schedule: DutySchedule;
  action: DutyAction;
  /** Shipped by a feature (问题页's): the person can turn it on or off and change its times, not remove it. */
  builtin?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type DutyItemInput = Partial<Pick<DutyItem, "title" | "enabled" | "schedule" | "action">>;

export interface DutyRun {
  itemId: Id;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  /** null while it runs; a run that found nothing to do is ok. */
  ok: boolean | null;
  /** One line for the list: what it did, or why it did not. */
  summary: string;
  /** Skipped: the last run still going, the subscription used up… (not counted as a failure). */
  skipped?: boolean;
  sessionId?: Id;
  taskId?: Id;
}

export interface DutyState {
  items: DutyItem[];
  /** Newest first, a few per item. */
  runs: DutyRun[];
  /** Items running now. */
  running: Id[];
  /** When each enabled item runs next. */
  next: Record<Id, Timestamp>;
  /** The jobs a builtin action can name. */
  builtins: Array<{ name: string; label: string; description: string }>;
}
