import { CANVAS_COLORS, CANVAS_LINK_LABEL_MAX, CANVAS_SIDES, isCanvasColor, isReviewStatus, REVIEW_BODY_MAX, REVIEW_STATUSES, REVIEW_TITLE_MAX, type CanvasCallout, type CanvasColor, type CanvasDoc, type CanvasLink, type CanvasNode, type Id, type ReviewStatus, type Session, type SessionStatus, type Task, type Topic, type Workspace } from "./entities.js";
import { taskWhere } from "./scope.js";

// Canvas rules shared by Host (validation on save), UI ("agent 视角") and the read-only MCP in stage 4.
// Coordinates are presentation only: the outline below describes structure (groups, tasks, notes, dependencies).

/** Id of the single global canvas from before topics; migrated into the first topic (design/structure.md). */
export const MAIN_CANVAS_ID = "main";

/** An empty canvas for a topic (its id is the topic's id). */
export function emptyCanvas(id: Id = MAIN_CANVAS_ID, at = new Date(0).toISOString()): CanvasDoc {
  return { id, version: 0, groups: [], nodes: [], edges: [], links: [], updatedAt: at };
}

/** The document without 连线 whose card is gone (a card taken off the canvas takes its lines with it). */
export function pruneLinks(doc: CanvasDoc): CanvasDoc {
  if (!doc.links?.length) return doc;
  const nodes = new Set(doc.nodes.map((n) => n.id));
  const links = doc.links.filter((l) => nodes.has(l.from) && nodes.has(l.to));
  return links.length === doc.links.length ? doc : { ...doc, links };
}

const finite = (...n: number[]) => n.every((x) => typeof x === "number" && Number.isFinite(x));

/** The largest side a card may be dragged to (2026-10-29): a typo'd document must not make one cover the canvas. */
export const CANVAS_CARD_MAX = 4000;

/**
 * Returns problems with a canvas document; empty when it may be saved. `taskIds`: the topic's own tasks (archived ones
 * included). A reference card may point at any other task, even one that is gone (it shows as such); a reference to a
 * task of this topic is refused (place its own card instead), and so is a second reference to the same task.
 */
export function validateCanvas(doc: CanvasDoc, taskIds: ReadonlySet<Id>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const unique = (id: unknown, what: string) => {
    if (typeof id !== "string" || !id) errors.push(`${what} has no id`);
    else if (ids.has(id)) errors.push(`duplicate id ${id}`);
    else ids.add(id);
  };
  const groups = new Set<string>();
  for (const g of doc.groups ?? []) {
    unique(g.id, "group");
    groups.add(g.id);
    if (typeof g.title !== "string") errors.push(`group ${g.id} has no title`);
    if (!g.rect || !finite(g.rect.x, g.rect.y, g.rect.w, g.rect.h) || g.rect.w <= 0 || g.rect.h <= 0) errors.push(`group ${g.id} has an invalid rect`);
    if (g.color !== undefined && !isCanvasColor(g.color)) errors.push(`group ${g.id} has an unknown colour ${String(g.color)}`);
  }
  const placed = new Set<string>();
  const referenced = new Set<string>();
  const numbers = new Set<number>();
  for (const n of doc.nodes ?? []) {
    unique(n.id, "node");
    if (!n.pos || !finite(n.pos.x, n.pos.y)) errors.push(`node ${n.id} has an invalid position`);
    if (n.groupId !== null && !groups.has(n.groupId)) errors.push(`node ${n.id} points at a missing group ${n.groupId}`);
    if (n.color !== undefined && !isCanvasColor(n.color)) errors.push(`node ${n.id} has an unknown colour ${String(n.color)}`);
    if (n.size !== undefined && (!n.size || !finite(n.size.w, n.size.h) || n.size.w <= 0 || n.size.h <= 0 || n.size.w > CANVAS_CARD_MAX || n.size.h > CANVAS_CARD_MAX)) errors.push(`node ${n.id} has an invalid size`);
    if (n.kind === "task") {
      if (!taskIds.has(n.taskId)) errors.push(`node ${n.id} points at a missing task ${n.taskId}`);
      if (placed.has(n.taskId)) errors.push(`task ${n.taskId} is placed twice`);
      placed.add(n.taskId);
    } else if (n.kind === "note") {
      if (typeof n.text !== "string") errors.push(`note ${n.id} has no text`);
    } else if (n.kind === "ref") {
      if (typeof n.taskId !== "string" || !n.taskId) errors.push(`reference ${n.id} has no task`);
      else if (taskIds.has(n.taskId)) errors.push(`reference ${n.id} points at task ${n.taskId} of this topic; place its own card instead`);
      else if (referenced.has(n.taskId)) errors.push(`task ${n.taskId} is referenced twice`);
      referenced.add(n.taskId);
    } else if (n.kind === "item") {
      if (typeof n.title !== "string" || !n.title.trim() || n.title.length > REVIEW_TITLE_MAX) errors.push(`item ${n.id} needs a title of at most ${REVIEW_TITLE_MAX} characters`);
      if (n.body !== undefined && (typeof n.body !== "string" || n.body.length > REVIEW_BODY_MAX)) errors.push(`item ${n.id} has an invalid body`);
      if (n.conclusion !== undefined && (typeof n.conclusion !== "string" || n.conclusion.length > REVIEW_BODY_MAX)) errors.push(`item ${n.id} has an invalid conclusion`);
      if (!isReviewStatus(n.status)) errors.push(`item ${n.id} has an unknown status ${String(n.status)}`);
      if (!Number.isInteger(n.num) || n.num < 1) errors.push(`item ${n.id} has an invalid number`);
      else if (numbers.has(n.num)) errors.push(`item number #${n.num} is used twice`);
      numbers.add(n.num);
    } else {
      errors.push(`node ${(n as { id: string }).id} has an unknown kind`);
    }
  }
  const pairs = new Set<string>();
  for (const e of doc.edges ?? []) {
    unique(e.id, "edge");
    if (e.kind !== "depends") errors.push(`edge ${e.id} has an unknown kind`);
    if (!taskIds.has(e.from) || !taskIds.has(e.to)) errors.push(`edge ${e.id} must connect two existing tasks`);
    if (e.from === e.to) errors.push(`edge ${e.id} connects a task to itself`);
    const key = `${e.from}>${e.to}`;
    if (pairs.has(key)) errors.push(`duplicate dependency ${key}`);
    pairs.add(key);
  }
  const nodeIds = new Set((doc.nodes ?? []).map((n) => n.id));
  for (const l of doc.links ?? []) {
    unique(l.id, "link");
    if (!nodeIds.has(l.from) || !nodeIds.has(l.to)) errors.push(`link ${l.id} must connect two cards on the canvas`);
    if (l.from === l.to) errors.push(`link ${l.id} connects a card to itself`);
    if (!CANVAS_SIDES.includes(l.fromSide) || !CANVAS_SIDES.includes(l.toSide)) errors.push(`link ${l.id} has an unknown side`);
    if (l.label !== undefined && (typeof l.label !== "string" || l.label.length > CANVAS_LINK_LABEL_MAX)) errors.push(`link ${l.id} has an invalid label`);
  }
  const cycle = findCycle(doc.edges ?? []);
  if (cycle) errors.push(`dependencies form a cycle: ${cycle.join(" → ")}`);
  return errors;
}

/** A cycle in the dependency graph as a list of task ids, or null. */
export function findCycle(edges: ReadonlyArray<{ from: Id; to: Id }>): Id[] | null {
  const next = new Map<Id, Id[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<Id, 1 | 2>(); // 1 = on the stack, 2 = done
  const stack: Id[] = [];
  const visit = (id: Id): Id[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const to of next.get(id) ?? []) {
      if (state.get(to) === 1) return [...stack.slice(stack.indexOf(to)), to];
      if (!state.has(to)) {
        const found = visit(to);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of next.keys()) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

/** Would adding from → to create a cycle? Used by the UI before offering a dependency. */
export function wouldCycle(edges: ReadonlyArray<{ from: Id; to: Id }>, from: Id, to: Id): boolean {
  return from === to || findCycle([...edges, { from, to }]) !== null;
}

export interface OutlineTask {
  id: Id;
  title: string;
  column: Task["column"];
  status: SessionStatus | null;
  /** "alpha", or "跨工作区（alpha、beta）". */
  /** The task's project, "未指定项目" for the common space. */
  workspace: string | null;
  dependsOn: Id[];
  /** The task's own description. */
  description?: string;
  /** Its card's colour mark on this canvas. */
  color?: CanvasColor;
}

/** A reference card: a task of another topic (or of none), with where it belongs. */
export interface OutlineRef {
  taskId: Id;
  /** The title, or "任务已归档" / "任务不存在" with `gone` set. */
  title: string;
  /** The task's own topic, null when it is in none. */
  topic: string | null;
  /** The task's project, "未指定项目" for the common space. */
  workspace: string | null;
  column: Task["column"] | null;
  status: SessionStatus | null;
  gone: "archived" | "missing" | null;
  color?: CanvasColor;
}

export interface OutlineNote {
  id: Id;
  text: string;
  color?: CanvasColor;
}

/** 审阅条目 (画布审阅). */
export interface OutlineItem {
  id: Id;
  num: number;
  title: string;
  status: ReviewStatus;
  /** The body, cut to a few hundred characters. */
  summary?: string;
  conclusion?: string;
  refs?: string[];
  /** Sessions talking this item over (就这条展开聊). */
  threads?: Id[];
  color?: CanvasColor;
}

/** A remark or question on a card that is not put away yet, with the person's answer once there is one. */
export interface OutlineCallout {
  id: Id;
  /** The card it is on, in a few words ("#3 …", "「task title」", "分组「…」"). */
  on: string;
  target: Id;
  kind: CanvasCallout["kind"];
  text: string;
  state: CanvasCallout["state"];
  answer?: string;
  /** Written by the session reading this outline. */
  mine?: boolean;
}

export interface CanvasOutline {
  groups: Array<{ id: Id; title: string; workspace: string | null; color?: CanvasColor; tasks: OutlineTask[]; refs: OutlineRef[]; notes: OutlineNote[]; items: OutlineItem[] }>;
  ungrouped: { tasks: OutlineTask[]; refs: OutlineRef[]; notes: OutlineNote[]; items: OutlineItem[] };
  /** Remarks and questions still out (open or answered), oldest first. */
  callouts: OutlineCallout[];
  /** Tasks of the topic that are not placed on its canvas yet. */
  unplaced: OutlineTask[];
  dependencies: Array<{ from: Id; to: Id }>;
  /** 连线 between cards: what each end is (a task's title, a note's text, a reference's task) and the label. */
  links: Array<{ from: string; to: string; label?: string }>;
}

const URGENCY: SessionStatus[] = ["awaiting-approval", "awaiting-answer", "awaiting-review", "error", "running", "idle", "completed"];

/**
 * The structure an agent needs, without coordinates: groups with their tasks, reference cards and notes, dependencies,
 * and tasks not yet placed. `tasks` are the topic's live tasks; `others` all tasks (archived too) and topics, to say
 * what reference cards point at. Returns both a readable outline and the same data as JSON. 画布审阅: review items in
 * their groups, and the `callouts` still out (`reader`: the session asking, whose own ones are marked).
 */
export function canvasOutline(
  doc: CanvasDoc,
  tasks: readonly Task[],
  workspaces: readonly Workspace[],
  sessions: readonly Session[] = [],
  others: { tasks: readonly Task[]; topics: readonly Topic[] } = { tasks: [], topics: [] },
  callouts: readonly CanvasCallout[] = [],
  reader: Id | null = null,
): { outline: string; json: CanvasOutline } {
  const wsName = (id: Id | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? null) : null);
  const deps = (doc.edges ?? []).map((e) => ({ from: e.from, to: e.to }));
  const toOutline = (task: Task): OutlineTask => {
    const live = sessions.filter((s) => s.taskId === task.id && !s.archivedAt);
    return {
      id: task.id,
      title: task.title || "未命名任务",
      column: task.column,
      status: URGENCY.find((u) => live.some((s) => s.status === u)) ?? null,
      workspace: taskWhere(task, workspaces),
      dependsOn: deps.filter((d) => d.to === task.id).map((d) => d.from),
      ...(task.description ? { description: task.description } : {}),
    };
  };
  const withColor = <T extends object>(o: T, color: CanvasColor | undefined): T => (color ? { ...o, color } : o);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const tasksIn = (groupId: Id | null) =>
    doc.nodes
      .filter((n) => n.kind === "task" && n.groupId === groupId && byId.has(n.taskId))
      .map((n) => withColor(toOutline(byId.get((n as { taskId: Id }).taskId)!), n.color));
  const anyTask = new Map(others.tasks.map((t) => [t.id, t]));
  const toRef = (taskId: Id): OutlineRef => {
    const task = anyTask.get(taskId);
    if (!task || task.archivedAt) {
      return { taskId, title: task ? "任务已归档" : "任务不存在", topic: null, workspace: null, column: null, status: null, gone: task ? "archived" : "missing" };
    }
    const { column, status, workspace } = toOutline(task);
    const topic = task.topicId ? (others.topics.find((t) => t.id === task.topicId)?.title ?? null) : null;
    return { taskId, title: task.title || "未命名任务", topic, workspace, column, status, gone: null };
  };
  const refsIn = (groupId: Id | null) => doc.nodes.flatMap((n) => (n.kind === "ref" && n.groupId === groupId ? [withColor(toRef(n.taskId), n.color)] : []));
  const notesIn = (groupId: Id | null): OutlineNote[] => doc.nodes.flatMap((n) => (n.kind === "note" && n.groupId === groupId ? [withColor({ id: n.id, text: n.text }, n.color)] : []));
  const itemsIn = (groupId: Id | null): OutlineItem[] =>
    doc.nodes
      .flatMap((n) => (n.kind === "item" && n.groupId === groupId ? [n] : []))
      .sort((a, b) => a.num - b.num)
      .map((n) =>
        withColor(
          {
            id: n.id,
            num: n.num,
            title: n.title,
            status: n.status,
            ...(n.body ? { summary: n.body.length > 300 ? `${n.body.slice(0, 300)}…` : n.body } : {}),
            ...(n.conclusion ? { conclusion: n.conclusion } : {}),
            ...(n.refs?.length ? { refs: n.refs } : {}),
            ...(n.threads?.length ? { threads: n.threads } : {}),
          },
          n.color,
        ),
      );
  const placed = new Set(doc.nodes.filter((n) => n.kind === "task").map((n) => (n as { taskId: Id }).taskId));

  const json: CanvasOutline = {
    groups: doc.groups.map((g) => withColor({ id: g.id, title: g.title, workspace: wsName(g.workspaceId), tasks: tasksIn(g.id), refs: refsIn(g.id), notes: notesIn(g.id), items: itemsIn(g.id) }, g.color)),
    ungrouped: { tasks: tasksIn(null), refs: refsIn(null), notes: notesIn(null), items: itemsIn(null) },
    callouts: [],
    unplaced: tasks.filter((t) => !placed.has(t.id)).map(toOutline),
    dependencies: deps,
    links: [],
  };
  // What a card is, in a few words, for the 连线 lines and the callouts.
  const nodeName = (n: CanvasNode): string => {
    if (n.kind === "note") return `便签「${n.text.replace(/\s+/g, " ").trim().slice(0, 40)}」`;
    if (n.kind === "item") return `#${n.num}「${n.title.slice(0, 40)}」`;
    const task = byId.get(n.taskId) ?? anyTask.get(n.taskId);
    return n.kind === "ref" ? `引用「${task?.title || n.taskId}」` : `「${task?.title || n.taskId}」`;
  };
  const cardName = (nodeId: Id): string | null => {
    const n = doc.nodes.find((x) => x.id === nodeId);
    return n ? nodeName(n) : null;
  };
  const targetName = (target: Id): string => {
    const n = doc.nodes.find((x) => x.id === target || (x.kind === "task" && x.taskId === target));
    if (n) return nodeName(n);
    const g = doc.groups.find((x) => x.id === target);
    return g ? `分组「${g.title}」` : "（卡片已不在画布上）";
  };
  json.callouts = callouts
    .filter((c) => c.state !== "closed")
    .map((c) => ({
      id: c.id,
      on: targetName(c.target),
      target: c.target,
      kind: c.kind,
      text: c.text,
      state: c.state,
      ...(c.answer ? { answer: c.answer.text } : {}),
      ...(reader && c.sessionId === reader ? { mine: true } : {}),
    }));
  json.links = (doc.links ?? []).flatMap((l: CanvasLink) => {
    const from = cardName(l.from);
    const to = cardName(l.to);
    return from && to ? [{ from, to, ...(l.label ? { label: l.label } : {}) }] : [];
  });

  const title = (id: Id) => byId.get(id)?.title || id;
  const mark = (color: CanvasColor | undefined) => (color ? `【${CANVAS_COLORS.find((c) => c.id === color)?.label ?? color}】` : "");
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const line = (t: OutlineTask) => {
    const bits = [t.column, t.status, t.workspace].filter(Boolean).join(" · ");
    const after = t.dependsOn.length ? `；依赖：${t.dependsOn.map(title).join("、")}` : "";
    const about = t.description ? `\n    说明：${oneLine(t.description).slice(0, 300)}` : "";
    return `  - ${mark(t.color)}${t.title}（${bits}）${after}${about}`;
  };
  // "引用：导入器重试（专题 掉落表 / 项目 alpha · doing · running）": a task that lives elsewhere.
  const refLine = (r: OutlineRef) => {
    if (r.gone) return `  - ${mark(r.color)}引用：${r.title}（${r.taskId}）`;
    const where = `${r.topic ? `专题 ${r.topic}` : "不在专题里"} / 项目 ${r.workspace}`;
    return `  - ${mark(r.color)}引用：${r.title}（${[where, r.column, r.status].filter(Boolean).join(" · ")}）`;
  };
  const statusLabel = (s: ReviewStatus) => REVIEW_STATUSES.find((x) => x.id === s)?.label ?? s;
  // "#3【已确认】协议改了（item id n-…）": a review item, its conclusion under it.
  const itemLine = (i: OutlineItem) =>
    [`  - ${mark(i.color)}#${i.num}【${statusLabel(i.status)}】${i.title}（条目 ${i.id}${i.threads?.length ? `；${i.threads.length} 个子对话` : ""}）`, ...(i.conclusion ? [`    结论：${oneLine(i.conclusion).slice(0, 300)}`] : [])].join("\n");
  const section = (heading: string, list: OutlineTask[], notes: OutlineNote[], refs: OutlineRef[] = [], items: OutlineItem[] = []) =>
    [
      heading,
      ...list.map(line),
      ...refs.map(refLine),
      ...items.map(itemLine),
      ...notes.map((n) => `  - ${mark(n.color)}便签：${oneLine(n.text)}`),
      ...(list.length || refs.length || notes.length || items.length ? [] : ["  （空）"]),
    ].join("\n");
  const calloutLine = (c: OutlineCallout) => {
    const what = c.kind === "question" ? (c.state === "answered" ? "问题（人已回答）" : "问题（等人回答）") : "说明";
    return [`  - ${c.on} · ${what}${c.mine ? " · 你写的" : ""}（${c.id}）：${oneLine(c.text).slice(0, 200)}`, ...(c.answer ? [`    人的回答：${oneLine(c.answer).slice(0, 500)}`] : [])].join("\n");
  };
  const parts = [
    ...json.groups.map((g) => section(`${mark(g.color)}分组「${g.title}」${g.workspace ? `（工作区 ${g.workspace}）` : ""}`, g.tasks, g.notes, g.refs, g.items)),
    section("未分组", json.ungrouped.tasks, json.ungrouped.notes, json.ungrouped.refs, json.ungrouped.items),
    ...(json.unplaced.length ? [section("还没放到画布上的任务", json.unplaced, [])] : []),
    ...(json.links.length ? [["连线", ...json.links.map((l) => `  - ${l.from} → ${l.to}${l.label ? `：${oneLine(l.label)}` : ""}`)].join("\n")] : []),
    ...(json.callouts.length ? [["卡片上的说明和问题（没收起的）", ...json.callouts.map(calloutLine)].join("\n")] : []),
  ];
  return { outline: parts.join("\n\n"), json };
}
