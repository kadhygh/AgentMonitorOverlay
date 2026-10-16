import { CANVAS_COLORS, isCanvasColor, type CanvasColor, type CanvasDoc, type Id, type Session, type SessionStatus, type Task, type Topic, type Workspace } from "./entities.js";
import { taskWhere } from "./scope.js";

// Canvas rules shared by Host (validation on save), UI ("agent 视角") and the read-only MCP in stage 4.
// Coordinates are presentation only: the outline below describes structure (groups, tasks, notes, dependencies).

/** Id of the single global canvas from before topics; migrated into the first topic (design/structure.md). */
export const MAIN_CANVAS_ID = "main";

/** An empty canvas for a topic (its id is the topic's id). */
export function emptyCanvas(id: Id = MAIN_CANVAS_ID, at = new Date(0).toISOString()): CanvasDoc {
  return { id, version: 0, groups: [], nodes: [], edges: [], updatedAt: at };
}

const finite = (...n: number[]) => n.every((x) => typeof x === "number" && Number.isFinite(x));

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
  for (const n of doc.nodes ?? []) {
    unique(n.id, "node");
    if (!n.pos || !finite(n.pos.x, n.pos.y)) errors.push(`node ${n.id} has an invalid position`);
    if (n.groupId !== null && !groups.has(n.groupId)) errors.push(`node ${n.id} points at a missing group ${n.groupId}`);
    if (n.color !== undefined && !isCanvasColor(n.color)) errors.push(`node ${n.id} has an unknown colour ${String(n.color)}`);
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

export interface CanvasOutline {
  groups: Array<{ id: Id; title: string; workspace: string | null; color?: CanvasColor; tasks: OutlineTask[]; refs: OutlineRef[]; notes: OutlineNote[] }>;
  ungrouped: { tasks: OutlineTask[]; refs: OutlineRef[]; notes: OutlineNote[] };
  /** Tasks of the topic that are not placed on its canvas yet. */
  unplaced: OutlineTask[];
  dependencies: Array<{ from: Id; to: Id }>;
}

const URGENCY: SessionStatus[] = ["awaiting-approval", "awaiting-answer", "awaiting-review", "error", "running", "idle", "completed"];

/**
 * The structure an agent needs, without coordinates: groups with their tasks, reference cards and notes, dependencies,
 * and tasks not yet placed. `tasks` are the topic's live tasks; `others` all tasks (archived too) and topics, to say
 * what reference cards point at. Returns both a readable outline and the same data as JSON.
 */
export function canvasOutline(
  doc: CanvasDoc,
  tasks: readonly Task[],
  workspaces: readonly Workspace[],
  sessions: readonly Session[] = [],
  others: { tasks: readonly Task[]; topics: readonly Topic[] } = { tasks: [], topics: [] },
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
  const colorOf = new Map(doc.nodes.flatMap((n) => (n.color && n.kind !== "note" ? [[n.taskId, n.color] as const] : [])));
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
  const placed = new Set(doc.nodes.filter((n) => n.kind === "task").map((n) => (n as { taskId: Id }).taskId));

  const json: CanvasOutline = {
    groups: doc.groups.map((g) => withColor({ id: g.id, title: g.title, workspace: wsName(g.workspaceId), tasks: tasksIn(g.id), refs: refsIn(g.id), notes: notesIn(g.id) }, g.color)),
    ungrouped: { tasks: tasksIn(null), refs: refsIn(null), notes: notesIn(null) },
    unplaced: tasks.filter((t) => !placed.has(t.id)).map(toOutline),
    dependencies: deps,
  };

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
  const section = (heading: string, list: OutlineTask[], notes: OutlineNote[], refs: OutlineRef[] = []) =>
    [
      heading,
      ...list.map(line),
      ...refs.map(refLine),
      ...notes.map((n) => `  - ${mark(n.color)}便签：${oneLine(n.text)}`),
      ...(list.length || refs.length || notes.length ? [] : ["  （空）"]),
    ].join("\n");
  const parts = [
    ...json.groups.map((g) => section(`${mark(g.color)}分组「${g.title}」${g.workspace ? `（工作区 ${g.workspace}）` : ""}`, g.tasks, g.notes, g.refs)),
    section("未分组", json.ungrouped.tasks, json.ungrouped.notes, json.ungrouped.refs),
    ...(json.unplaced.length ? [section("还没放到画布上的任务", json.unplaced, [])] : []),
  ];
  return { outline: parts.join("\n\n"), json };
}
