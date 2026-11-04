import type { CanvasItem, ChecklistItem, ModelProfile, Session, SessionStatus, Task, TaskColumn, Topic, TopicDoc, Workspace } from "@amo-studio/protocol";
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
//
// 0.3 (2026-11-03, the user: a block can be a topic, not only a task — topic → task → session): several topics, each
// with its projects (the task's workspace; a project's status is a set of fields its topic's spec decides, the task
// count until someone writes them), its documents (the shelf), its own sessions (the 主控 spine, which tasks are
// proposed from) and the points found while working (decisions, questions, findings, notes: items too, on a round of a
// task or on the topic's board). What AMO does not record yet (project fields, who proposed a task, points) comes in
// through `extra`, written by hand in the preview and later by the topic's own agent (plans/userlayer/README.md「0.3」).

export const DATALAYER_SPEC = "amo.datalayer/0.3";

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
  /** 0.3: its topic and project (PanoramaProject id), and the topic session (spine item) that proposed it, if known. */
  topic: string;
  project: string;
  proposedBy: string | null;
}

/** 0.3: a topic, a block of its own. `goal`: one line from its description. */
export interface PanoramaTopic {
  id: string;
  title: string;
  short: string;
  goal: string | null;
  status: LaneStatus;
}

/** One line of a project's status: what its topic's spec asks to show (`tone`: how it stands). */
export interface ProjectField {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "info";
}

/**
 * 0.3: a project within a topic (the workspace its tasks run in; the same workspace in two topics is two of these, as
 * each topic's spec decides what to show). `status` is free-form fields; the task count is always the last line.
 */
export interface PanoramaProject {
  id: string;
  topic: string;
  workspace: string;
  title: string;
  short: string;
  status: ProjectField[];
  summary: string | null;
  updatedAt: string | null;
  /** Who wrote the fields (an agent, a person); null for the task count alone. */
  by: string | null;
}

/** 0.3: a topic document on the shelf: `spec` when it lays down rules (its title says 规范), else `doc`. */
export interface PanoramaDoc {
  id: string;
  topic: string;
  kind: "spec" | "doc";
  title: string;
  /** Its first lines (up to 240 characters; the shelf shows a line of them, the popup all), or "" when the body was not given. */
  summary: string;
  updatedAt: string;
}

export type ItemType = "session" | "decision" | "question" | "finding" | "note";

export interface PanoramaItem {
  id: string;
  /** #n for people, in lane order then time. */
  num: number;
  lane: string | null;
  /** Its place along the lane. */
  at: string;
  /**
   * `session` is an addition to spec 0.2's types: Studio's sessions are the first items. 0.3: the points found while
   * working (decision, question, finding, note) are items too.
   */
  type: ItemType;
  /** 0.3: its topic. `lane` is null for the topic's own sessions (the spine) and points on the topic's board. */
  topic: string;
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
  /**
   * 0.3 (11-03), a branch's last session: the round of the trunk its work went back into (the branch is drawn merging
   * there). Studio has no such thing yet: only `extra.merges` gives it (the preview's demo).
   */
  mergeInto: string | null;
  /** 0.3, a point: the session it came out of (its `round` is that one's), null on the topic's board. */
  of: string | null;
  /** 0.3, a point: its text. */
  body?: string;
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
  /** The first topic (the only one in Studio's page). */
  context: { id: string; title: string; goal?: string; updatedAt: string };
  now: string;
  topics: PanoramaTopic[];
  projects: PanoramaProject[];
  docs: PanoramaDoc[];
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
  /** The topic drawn; with `topics`, they all are (0.3), each a block. */
  topic: Topic;
  topics?: readonly Topic[];
  tasks: readonly Task[];
  sessions: readonly Session[];
  profiles?: readonly ModelProfile[];
  /** Every task's checklist steps (the page has them all; only the topic's tasks' are read). */
  checklist?: readonly ChecklistItem[];
  /** The topic canvas's dependencies (CanvasDoc.edges): `to` waits for `from`. */
  dependencies?: readonly { from: string; to: string }[];
  /** 0.3: the projects' names. */
  workspaces?: readonly Pick<Workspace, "id" | "name">[];
  /** 0.3: the topics' documents; `body` may be left out (the shelf shows the title then). */
  docs?: readonly (Pick<TopicDoc, "id" | "topicId" | "title" | "updatedAt"> & { body?: string })[];
  /** 0.3: review items laid out on the topics' canvases: points on each topic's board. */
  reviews?: readonly (Pick<CanvasItem, "id" | "num" | "title" | "status" | "sessionId"> & { topicId: string; body?: string; updatedAt?: string })[];
  extra?: PanoramaExtra;
  /**
   * Studio's 全景 (11-04): live tasks in no topic get a block of their own, 「没归专题的任务」, a band per project;
   * none, no block.
   */
  loose?: boolean;
  now: string;
}

/** The block of tasks in no topic (`loose`): its id, never a topic's (those start with tp-). */
export const LOOSE_TOPIC = "loose";
export const LOOSE_TITLE = "没归专题的任务";

/**
 * 0.3: what AMO does not record yet — written by hand for the preview, later by the topic's own agent following the
 * topic's spec. `projects` by `${topicId}/${workspaceId}`; `proposedBy` a task's id to the topic session that
 * proposed it; `cards` points found while working, on a session's round or (without one) on the topic's board.
 */
export interface PanoramaExtra {
  projects?: Record<string, { status: ProjectField[]; summary?: string; updatedAt?: string; by?: string }>;
  proposedBy?: Record<string, string>;
  /** A branch's last session → the trunk session its work went back into (`mergeInto`). */
  merges?: Record<string, string>;
  cards?: readonly { id: string; topicId: string; taskId?: string; sessionId?: string; type: Exclude<ItemType, "session">; title: string; body?: string; at: string; needsYou?: boolean }[];
}

const CARD_STATUS: Record<CanvasItem["status"], { type: Exclude<ItemType, "session">; status: ItemStatus }> = {
  confirmed: { type: "decision", status: "settled" },
  done: { type: "decision", status: "settled" },
  discuss: { type: "question", status: "waiting" },
  todo: { type: "finding", status: "waiting" },
  parked: { type: "note", status: "parked" },
};
const CARD_LABEL: Record<Exclude<ItemType, "session">, string> = { decision: "决定", question: "问题", finding: "发现", note: "便签" };
export const ITEM_LABEL: Record<ItemType, string> = { session: "会话", ...CARD_LABEL };

/**
 * The datalayer of one topic: its tasks (not archived), oldest first, each a lane; their main sessions and branches
 * (subagents are left out — there can be dozens and they belong to the session that started them) as items along it.
 */
export function toPanorama(input: PanoramaInput): PanoramaData {
  const { now } = input;
  const topicList = input.topics?.length ? input.topics : [input.topic];
  const profile = new Map((input.profiles ?? []).map((p) => [p.id, p.label]));
  const wsName = new Map((input.workspaces ?? []).map((w) => [w.id, w.name]));
  const extra = input.extra ?? {};
  const topics: PanoramaTopic[] = [];
  const projects: PanoramaProject[] = [];
  const docs: PanoramaDoc[] = [];
  const lanes: PanoramaLane[] = [];
  const items: PanoramaItem[] = [];
  let num = 0;
  const sessionItem = (s: Session, topic: string, lane: string | null, round: number | null, forkFrom: string | null): PanoramaItem => {
    // An archived session is history: it no longer runs or waits, whatever it last said.
    const status: ItemStatus = s.archivedAt ? "settled" : ITEM_STATUS[s.status];
    const stitle = s.title.trim() || (s.kind === "fork" ? "分支会话" : "会话");
    return {
      id: s.id,
      num: ++num,
      topic,
      lane,
      at: s.createdAt,
      type: "session",
      status,
      title: stitle,
      short: cut(stitle, 12),
      summary: s.archivedAt ? "已归档" : SUMMARY[s.status],
      owner: status === "needs_you" ? "human" : s.id,
      updatedAt: s.updatedAt,
      round,
      forkFrom,
      mergeInto: null,
      of: null,
      ended: !!forkFrom && (!!s.archivedAt || s.status === "completed"),
      work: workOf(s, now),
      ref: { taskId: s.taskId ?? "", sessionId: s.id, sessionStatus: s.status, statusLabel: s.archivedAt ? "已归档" : SESSION_LOOK[s.status].label, kind: s.kind, model: s.options.model || profile.get(s.profileId) || "", how: forkFrom ? (s.kind === "fork" ? "fork" : "started") : "round" },
    };
  };
  // A context with no topic at all names the loose block; it is drawn once, below.
  const blocks = topicList.filter((t) => t.id !== LOOSE_TOPIC).map((topic) => ({ topic, of: (t: Task) => t.topicId === topic.id }));
  if (input.loose && input.tasks.some((t) => !t.topicId && !t.archivedAt)) {
    const at = input.tasks.filter((t) => !t.topicId).map((t) => t.createdAt).sort()[0]!;
    blocks.push({ topic: { id: LOOSE_TOPIC, title: LOOSE_TITLE, workspaceIds: [], createdAt: at, updatedAt: at, archivedAt: null }, of: (t: Task) => !t.topicId });
  }
  for (const { topic, of } of blocks) {
    const tasks = input.tasks.filter((t) => of(t) && !t.archivedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    // The topic's own sessions (its 主控, later its own agent): the spine, a round each.
    const spine = input.sessions.filter((s) => s.topicId === topic.id && !s.taskId && s.kind !== "sub").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    spine.forEach((s, i) => items.push(sessionItem(s, topic.id, null, i + 1, null)));
    const spineIds = new Set(spine.map((s) => s.id));
    const topicLanes: PanoramaLane[] = [];
    for (const task of tasks) {
      const sessions = input.sessions
        .filter((s) => s.taskId === task.id && s.kind !== "sub")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const drawn = new Set(sessions.map((s) => s.id));
      const live = sessions.filter((s) => !s.archivedAt);
      const title = task.title.trim() || "未命名任务";
      const steps = (input.checklist ?? []).filter((c) => c.taskId === task.id);
      const by = extra.proposedBy?.[task.id];
      const lane: PanoramaLane = {
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
        topic: topic.id,
        project: `${topic.id}/${task.workspaceId}`,
        proposedBy: by && spineIds.has(by) ? by : null,
      };
      lanes.push(lane);
      topicLanes.push(lane);
      let round = 0;
      for (const s of sessions) {
        // A branch forks off the session that opened it, when that one is drawn: a branch session off its parent, one
        // opened with session_start off the session that started it. Anything else is a round of the trunk.
        const forkFrom = s.kind === "fork" && s.parentId && drawn.has(s.parentId) ? s.parentId : s.startedBy && drawn.has(s.startedBy) ? s.startedBy : null;
        items.push(sessionItem(s, topic.id, task.id, forkFrom ? null : ++round, forkFrom));
      }
      // Merges only from a branch session into a round of the same task's trunk.
      for (const it of items) {
        const to = it.lane === task.id && it.forkFrom ? extra.merges?.[it.id] : undefined;
        if (to && items.some((x) => x.id === to && x.lane === task.id && x.round !== null)) it.mergeInto = to;
      }
    }
    // Projects: the topic's own plus its tasks' workspaces, in the order their first task came; the fields its spec
    // asks for when someone wrote them, and the task count.
    const wsIds = [...new Set([...topicLanes.map((l) => l.project.slice(topic.id.length + 1)), ...topic.workspaceIds])];
    for (const ws of wsIds) {
      const id = `${topic.id}/${ws}`;
      const mine = topicLanes.filter((l) => l.project === id);
      const given = extra.projects?.[id];
      const count = `${mine.length} 个${mine.some((l) => l.status === "running") ? ` · ${mine.filter((l) => l.status === "running").length} 在跑` : ""}${mine.some((l) => l.status === "done") ? ` · ${mine.filter((l) => l.status === "done").length} 完成` : ""}`;
      const title = wsName.get(ws) ?? (ws ? ws : "公共文件夹");
      projects.push({ id, topic: topic.id, workspace: ws, title, short: cut(title, 14), status: [...(given?.status ?? []), { label: "任务", value: count }], summary: given?.summary ?? null, updatedAt: given?.updatedAt ?? null, by: given?.by ?? null });
    }
    for (const d of (input.docs ?? []).filter((d) => d.topicId === topic.id).sort((a, b) => a.title.localeCompare(b.title, "zh"))) docs.push({ id: d.id, topic: topic.id, kind: d.title.includes("规范") ? "spec" : "doc", title: d.title, summary: firstLines(d.body ?? "", 240), updatedAt: d.updatedAt });
    // Points: on the canvas as review items (the topic's board), and those given by hand (on a session's round or the board).
    const topicItems = new Map(items.filter((i) => i.topic === topic.id && i.type === "session").map((i) => [i.id, i]));
    const point = (id: string, type: Exclude<ItemType, "session">, title: string, body: string | undefined, at: string, status: ItemStatus, of: PanoramaItem | undefined): PanoramaItem => ({
      id,
      num: ++num,
      topic: topic.id,
      lane: of?.lane ?? null,
      at,
      type,
      status,
      title,
      short: cut(title, 12),
      summary: status === "needs_you" ? `等你：${CARD_LABEL[type]}` : CARD_LABEL[type],
      owner: status === "needs_you" ? "human" : (of?.id ?? topic.id),
      updatedAt: at,
      round: of?.lane ? of.round : null,
      forkFrom: null,
      mergeInto: null,
      of: of?.id ?? null,
      ...(body ? { body } : {}),
      ended: false,
      work: { minutes: 0, weight: 0 },
      ref: { taskId: of?.ref.taskId ?? "", sessionId: of?.id ?? "", sessionStatus: "idle", statusLabel: CARD_LABEL[type], kind: "main", model: "", how: "round" },
    });
    for (const r of (input.reviews ?? []).filter((r) => r.topicId === topic.id)) {
      const k = CARD_STATUS[r.status];
      items.push(point(r.id, k.type, `#${r.num} ${r.title}`, r.body, r.updatedAt ?? topic.updatedAt, k.status, undefined));
    }
    for (const c of (extra.cards ?? []).filter((c) => c.topicId === topic.id)) items.push(point(c.id, c.type, c.title, c.body, c.at, c.needsYou ? "needs_you" : c.type === "question" ? "waiting" : "settled", c.sessionId ? topicItems.get(c.sessionId) : undefined));
    const all = topicLanes.map((l) => l.status);
    topics.push({ id: topic.id, title: topic.title, short: cut(topic.title, 12), goal: topic.description ? firstLines(topic.description, 40) : null, status: all.includes("running") ? "running" : all.length && all.every((s) => s === "done") ? "done" : "waiting" });
  }
  const laneIds = new Set(lanes.map((l) => l.id));
  const links: PanoramaLink[] = (input.dependencies ?? []).filter((d) => laneIds.has(d.from) && laneIds.has(d.to) && d.from !== d.to).map((d) => ({ from: d.from, to: d.to, rel: "depends" }));
  const first = topicList[0]!;
  return {
    spec: DATALAYER_SPEC,
    context: { id: first.id, title: first.title, ...(first.description ? { goal: first.description } : {}), updatedAt: first.updatedAt },
    now,
    topics,
    projects,
    docs,
    lanes,
    items,
    links,
  };
}

/** The first lines of some Markdown (headings left out, marks taken off), as one line of at most n characters. */
function firstLines(md: string, n = 60): string {
  const text = md
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^#+\s*|^[-*>]\s+|[`*_]/g, "").trim())
    .filter(Boolean)
    .join(" ");
  return cut(text, n);
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
