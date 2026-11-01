import type { Id, SessionOptions, Timestamp } from "./entities.js";

// 值守 (duty, 2026-10-31, plans/issues.md): the Host does something at set times or when there is something to do —
// starts a session with a set prompt, runs a command, or runs one of Studio's own jobs (问题页's, stage 3). The waiting,
// the counting and the clock are code: a model is started only when an item's action is a session. Named apart from
// Claude Code's /loop and Codex's goal on purpose (the user, 2026-10-31).

/** When an item runs: every so many seconds, or once a day at a local time. */
export type DutySchedule = { every: number } | { daily: string };

/** At least this many seconds between two runs of an item. */
export const DUTY_MIN_EVERY = 10;

/**
 * A line a command (an item's command, or a session item's check) prints to say the watch is over: the item is turned
 * off after this run (2026-10-31: the script decides; with other output, a check still starts its session once).
 */
export const DUTY_DONE_MARK = "AMO_DUTY_DONE";

/**
 * What a session item checks before it starts a model (2026-10-31, the user: "每次都先走脚本，有问题才拉起ai"): a
 * command line, or one of Studio's own checks (DutyState.checks). A command says there is something to do by printing
 * it and exiting 0; nothing printed = nothing to do; another exit code = the check failed. What the check found is
 * put under the prompt. The same finding that already started a session does not start another one.
 */
export type DutyCheckOne = { kind: "command"; command: string; workspaceId?: Id | null; timeoutSec?: number } | { kind: "builtin"; name: string };
/**
 * `all` (2026-10-31, plans/release.md: the day's 维护 looks at 问题页 and at what is due for release, one session at a
 * time in the 值守 directory): each in turn; what they found together; failed only when every one failed (one that
 * failed beside a finding is said under it); the watch is over only when every one says so.
 */
export type DutyCheck = DutyCheckOne | { kind: "all"; checks: DutyCheckOne[] };
export const DUTY_CHECKS_MAX = 5;

export type DutyAction =
  /**
   * A session with `prompt`: in task `taskId`, or (without one) in a new task titled `taskTitle` in project
   * `workspaceId`. `options`: model, effort and permissions for `profileId` (its defaults otherwise; an unattended
   * run usually wants a permission that does not stop to ask). `fallbackProfileId`: used, with its own defaults, when
   * the first one's subscription is (nearly) used up. `untilDone`: the session is told it may turn the item off
   * (duty_stop) once what the item watches for is done.
   */
  | { kind: "session"; profileId: Id; prompt: string; taskId?: Id | null; workspaceId?: Id | null; taskTitle?: string; options?: SessionOptions; fallbackProfileId?: Id | null; check?: DutyCheck | null; untilDone?: boolean }
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
  /** Last saved by an agent (duty_save), not in 设置 → 值守. */
  by?: "agent";
  /** The session that saved it (duty_save): marked 设了值守 in its task's session list. */
  setBy?: Id;
  /**
   * The item it hangs under (2026-11-01, the user: 打包值守挂在维护值守下面，只表现关系；停了父的子的也停). One level:
   * a child has no children. Turning the parent off turns its children off; a child is turned on only with its parent on.
   */
  parentId?: Id;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** parentId null: no longer under another item. */
export type DutyItemInput = Partial<Pick<DutyItem, "title" | "enabled" | "schedule" | "action">> & { parentId?: Id | null };

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
  /** The sessions 值守 started (the latest few hundred) → the item that started each: marked in the session list. */
  sessions: Record<Id, Id>;
  /** When each enabled item runs next. */
  next: Record<Id, Timestamp>;
  /** The jobs a builtin action can name. */
  builtins: Array<{ name: string; label: string; description: string }>;
  /** The checks a session item can run first. */
  checks: Array<{ name: string; label: string; description: string }>;
}
