import type { ChecklistItem, ModelProfile, Session, SessionStatus, Task, TaskColumn, Topic } from "@amo-studio/protocol";
import { SESSION_LOOK } from "../lib/status.js";

// 全景's data (2026-11-01): Studio's state turned into the datalayer's shape (studio/plans/userlayer/README.md, spec
// 0.2: lanes / items / now). The page draws only from this, never from Studio's state, so the drawing (the userlayer)
// can be swapped while the data stays — the point of the three layers. Pure, so it can move into the Host later.
//
// P1 (2026-11-02, plans/userlayer/panorama.md「节点的表达」): each task grows from its start towards its goal as a tree.
// Its main sessions are the trunk, one round each (第 N 轮); a branch session, or one another session of the task
// opened with session_start, forks off the round that opened it. The goal's state comes from the board column, its
// distance from the task's checklist. Dependencies drawn on the canvas link the lanes.
//
// Boundary (the user, 2026-11-02): 全景 may become a module of its own, only embedded in AMO, or be dropped. So this
// file is the only one of it that reads AMO (its state, @amo-studio/protocol, AMO's modules); the page, layout, engine
// and themes know only the shapes below, and whatever 全景 wants AMO to do (open a task…) goes through callbacks the
// page is given. The preview (preview.tsx), which runs the same drawing on a snapshot, keeps that honest.

export const DATALAYER_SPEC = "amo.datalayer/0.2";

export type LaneStatus = "running" | "waiting" | "done" | "parked";
export type ItemStatus = "needs_you" | "working" | "waiting" | "settled" | "parked";
/** Where the task stands against its goal: on the way, 待审阅 (waiting for the person to accept it), 完成. */
export type GoalState = "open" | "review" | "reached";

export interface PanoramaLane {
  id: string;
  kind: "task";
  title: string;
  /** At most 12 characters, for the lane's sign. */
  short: string;
  status: LaneStatus;
  column: TaskColumn;
  startAt: string;
  endAt?: string;
  /**
   * Addition to spec 0.2 (P1): the goal the tree grows towards. `checklist`: the task's checklist when it has one —
   * each step still open keeps the goal a stretch further away.
   */
  goal: { state: GoalState; checklist: { done: number; total: number } | null };
  /** Where it comes from in Studio (an addition to spec 0.2: the page opens the task with it). */
  ref: { taskId: string };
}

export interface PanoramaItem {
  id: string;
  /** #n for people, in lane order then time. */
  num: number;
  lane: string;
  /** Its place along the lane. */
  at: string;
  /** `session` is an addition to spec 0.2's types: Studio's sessions are the first items. */
  type: "session";
  status: ItemStatus;
  title: string;
  short: string;
  /** One line: what it waits for, or how it stands. */
  summary: string;
  /** Who has the ball: "human" while it waits on the person, else the session itself. */
  owner: string;
  updatedAt: string;
  /** P1: on the trunk, which round it is (1, 2…); null on a branch. */
  round: number | null;
  /** P1: on a branch, the item it forks from (spec 0.2 has forkFrom on branch lanes; here every branch is one item). */
  forkFrom: string | null;
  /** P1: a branch that stopped (archived, or its session completed): drawn still and dim. */
  ended: boolean;
  /**
   * How much work went into it (2026-11-02, for the skyline): `minutes` from its start to its end (archived), to now
   * while it runs or waits on the person, else to its last change (`updatedAt`) — Studio's state has no turn counts
   * (those are in the transcript); `weight` 0–1 is that on a log scale, ten hours and more being 1, so one very long
   * session does not flatten the others.
   */
  work: { minutes: number; weight: number };
  /** `statusLabel`: the session's status as Studio names it (「待批准」「运行中」…), or 「已归档」. */
  ref: { taskId: string; sessionId: string; sessionStatus: SessionStatus; statusLabel: string; kind: Session["kind"]; model: string; how: "round" | "fork" | "started" };
}

/** Spec 0.1's links, between lanes here (P1): a dependency drawn on the topic's canvas — `to` waits for `from`. */
export interface PanoramaLink {
  from: string;
  to: string;
  rel: "depends";
}

export interface PanoramaData {
  spec: typeof DATALAYER_SPEC;
  context: { id: string; title: string; goal?: string; updatedAt: string };
  now: string;
  lanes: PanoramaLane[];
  items: PanoramaItem[];
  links: PanoramaLink[];
}

/** Session statuses that wait on the person — the same three the board counts (lib/status.ts needsPerson). */
const WAITS: Partial<Record<SessionStatus, string>> = { "awaiting-approval": "等你批准", "awaiting-answer": "等你回答", "awaiting-review": "等你审阅" };

const ITEM_STATUS: Record<SessionStatus, ItemStatus> = {
  "awaiting-approval": "needs_you",
  "awaiting-answer": "needs_you",
  "awaiting-review": "needs_you",
  running: "working",
  idle: "settled",
  completed: "settled",
  // Stopped from outside or failed: not moving and not the person's to answer; shown apart from what went well.
  interrupted: "parked",
  error: "parked",
};

const SUMMARY: Record<SessionStatus, string> = {
  "awaiting-approval": "等你批准",
  "awaiting-answer": "等你回答",
  "awaiting-review": "等你审阅",
  running: "在跑",
  idle: "空闲，等下一条消息",
  completed: "已完成",
  interrupted: "被中断",
  error: "出错了",
};

const GOAL: Record<TaskColumn, GoalState> = { todo: "open", doing: "open", review: "review", done: "reached" };

export function cut(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s;
}

export interface PanoramaInput {
  topic: Topic;
  tasks: readonly Task[];
  sessions: readonly Session[];
  profiles?: readonly ModelProfile[];
  /** Every task's checklist steps (the page has them all; only the topic's tasks' are read). */
  checklist?: readonly ChecklistItem[];
  /** The topic canvas's dependencies (CanvasDoc.edges): `to` waits for `from`. */
  dependencies?: readonly { from: string; to: string }[];
  now: string;
}

/**
 * The datalayer of one topic: its tasks (not archived), oldest first, each a lane; their main sessions and branches
 * (subagents are left out — there can be dozens and they belong to the session that started them) as items along it.
 */
export function toPanorama(input: PanoramaInput): PanoramaData {
  const { topic, now } = input;
  const tasks = input.tasks.filter((t) => t.topicId === topic.id && !t.archivedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const profile = new Map((input.profiles ?? []).map((p) => [p.id, p.label]));
  const lanes: PanoramaLane[] = [];
  const items: PanoramaItem[] = [];
  let num = 0;
  for (const task of tasks) {
    const sessions = input.sessions
      .filter((s) => s.taskId === task.id && s.kind !== "sub")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const drawn = new Set(sessions.map((s) => s.id));
    const live = sessions.filter((s) => !s.archivedAt);
    const title = task.title.trim() || "未命名任务";
    const steps = (input.checklist ?? []).filter((c) => c.taskId === task.id);
    lanes.push({
      id: task.id,
      kind: "task",
      title,
      short: cut(title, 12),
      status: laneStatus(task.column, live),
      column: task.column,
      startAt: task.createdAt,
      ...(task.column === "done" ? { endAt: task.updatedAt } : {}),
      goal: { state: GOAL[task.column], checklist: steps.length ? { done: steps.filter((c) => c.done).length, total: steps.length } : null },
      ref: { taskId: task.id },
    });
    let round = 0;
    for (const s of sessions) {
      // A branch forks off the session that opened it, when that one is drawn: a branch session off its parent, one
      // opened with session_start off the session that started it. Anything else is a round of the trunk.
      const forkFrom = s.kind === "fork" && s.parentId && drawn.has(s.parentId) ? s.parentId : s.startedBy && drawn.has(s.startedBy) ? s.startedBy : null;
      const how = forkFrom ? (s.kind === "fork" ? "fork" : "started") : "round";
      // An archived session is history: it no longer runs or waits, whatever it last said.
      const status: ItemStatus = s.archivedAt ? "settled" : ITEM_STATUS[s.status];
      const stitle = s.title.trim() || (s.kind === "fork" ? "分支会话" : "会话");
      items.push({
        id: s.id,
        num: ++num,
        lane: task.id,
        at: s.createdAt,
        type: "session",
        status,
        title: stitle,
        short: cut(stitle, 12),
        summary: s.archivedAt ? "已归档" : SUMMARY[s.status],
        owner: status === "needs_you" ? "human" : s.id,
        updatedAt: s.updatedAt,
        round: forkFrom ? null : ++round,
        forkFrom,
        ended: !!forkFrom && (!!s.archivedAt || s.status === "completed"),
        work: workOf(s, now),
        ref: { taskId: task.id, sessionId: s.id, sessionStatus: s.status, statusLabel: s.archivedAt ? "已归档" : SESSION_LOOK[s.status].label, kind: s.kind, model: s.options.model || profile.get(s.profileId) || "", how },
      });
    }
  }
  const laneIds = new Set(lanes.map((l) => l.id));
  const links: PanoramaLink[] = (input.dependencies ?? []).filter((d) => laneIds.has(d.from) && laneIds.has(d.to) && d.from !== d.to).map((d) => ({ from: d.from, to: d.to, rel: "depends" }));
  return {
    spec: DATALAYER_SPEC,
    context: { id: topic.id, title: topic.title, ...(topic.description ? { goal: topic.description } : {}), updatedAt: topic.updatedAt },
    now,
    lanes,
    items,
    links,
  };
}

const WORK_CAP = 600;

export function workOf(s: Pick<Session, "createdAt" | "updatedAt" | "archivedAt" | "status">, now: string): PanoramaItem["work"] {
  const live = !s.archivedAt && (s.status === "running" || !!WAITS[s.status]);
  const end = s.archivedAt ?? (live ? now : s.updatedAt);
  const minutes = Math.max(0, (Date.parse(end) - Date.parse(s.createdAt)) / 60_000);
  return { minutes: Math.round(minutes), weight: Math.min(1, Math.log1p(minutes) / Math.log1p(WORK_CAP)) };
}

/** done when the person moved it to 完成; running while a session runs or waits on the person; else waiting on someone to carry it on. */
function laneStatus(column: TaskColumn, live: readonly Session[]): LaneStatus {
  if (column === "done") return "done";
  if (live.some((s) => s.status === "running" || WAITS[s.status])) return "running";
  return "waiting";
}

/** The items that wait on the person, oldest wait first (the order 「N 件等你」 visits them in). */
export function needsYou(data: PanoramaData): PanoramaItem[] {
  return data.items.filter((i) => i.status === "needs_you").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.num - b.num);
}
