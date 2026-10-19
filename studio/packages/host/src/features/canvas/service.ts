import { join } from "node:path";
import type { CanvasDoc, Id, Task } from "@amo-studio/protocol";
import { addDependency, addGroupAuto, CANVAS_COLORS, CanvasLayoutError, canvasOutline, emptyCanvas, isCanvasColor, pruneLinks, isCommon, placeTask, refsToCard, removeTask, unplaceTask, validateCanvas } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Each topic's canvas, and the canvas changes agents ask for. */
export class CanvasFeature extends Feature {
  canvas(topicId: Id): CanvasDoc {
    this.requireTopic(topicId);
    return this.store.getCanvas(topicId) ?? emptyCanvas(topicId);
  }

  saveCanvas(topicId: Id, input: unknown): CanvasDoc {
    let doc = input as CanvasDoc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.groups) || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
      throw new HostError("bad_request", "canvas needs groups, nodes and edges arrays");
    }
    if (doc.links !== undefined && !Array.isArray(doc.links)) throw new HostError("bad_request", "links must be an array");
    if (this.requireTopic(topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    const current = this.canvas(topicId);
    if (doc.version !== current.version) {
      throw new HostError("conflict", `canvas changed elsewhere (version ${current.version}, yours ${String(doc.version)}); reload and retry`);
    }
    // Archived tasks keep their cards and dependencies (hidden while archived, back on restore), so they count too:
    // refusing them made every later save of that canvas fail (S11-A: an empty group that would not go away).
    const known = this.store.listTasks().filter((t) => t.topicId === topicId);
    // 连线 to a card that was just taken off go with it (the page need not remember to drop them).
    doc = pruneLinks(doc);
    const errors = validateCanvas(doc, new Set(known.map((t) => t.id)));
    if (errors.length) throw new HostError("bad_request", errors.slice(0, 5).join("; "));
    const next: CanvasDoc = {
      id: topicId,
      version: current.version + 1,
      groups: doc.groups,
      nodes: doc.nodes,
      edges: doc.edges,
      links: doc.links ?? [],
      updatedAt: new Date().toISOString(),
    };
    this.store.putCanvas(next);
    this.publish({ type: "canvas.updated", canvas: next });
    return next;
  }

  /** The topic's live tasks (the ones its canvas may show). */
  private topicTasks(topicId: Id): Task[] {
    return this.store.listTasks().filter((t) => t.topicId === topicId && !t.archivedAt);
  }

  /** A task leaving a topic takes its card and its dependencies off that topic's canvas. */
  leaveCanvas(topicId: Id, taskId: Id): void {
    const current = this.store.getCanvas(topicId);
    if (!current || !current.nodes.some((n) => n.kind === "task" && n.taskId === taskId)) return;
    const next: CanvasDoc = { ...removeTask(current, taskId), version: current.version + 1, updatedAt: new Date().toISOString() };
    this.store.putCanvas(next);
    this.publish({ type: "canvas.updated", canvas: next });
  }

  /**
   * A task joining a topic: a reference card to it on that topic's canvas becomes its own card, in the same place (a
   * reference to one of the topic's own tasks is not allowed); further references to it there go.
   */
  joinCanvas(topicId: Id, taskId: Id): void {
    const current = this.store.getCanvas(topicId);
    if (!current || !current.nodes.some((n) => n.kind === "ref" && n.taskId === taskId)) return;
    const next: CanvasDoc = { ...refsToCard(current, taskId), version: current.version + 1, updatedAt: new Date().toISOString() };
    this.store.putCanvas(next);
    this.publish({ type: "canvas.updated", canvas: next });
  }

  canvasCreateGroup(topicId: Id, input: { title?: unknown; workspace?: unknown }): { groupId: Id; title: string } {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new HostError("bad_request", "title is required");
    let workspaceId: Id | null = null;
    if (typeof input.workspace === "string" && input.workspace) {
      const ws = this.store.listWorkspaces().find((w) => !isCommon(w) && (w.id === input.workspace || w.name === input.workspace));
      if (!ws) throw new HostError("bad_request", `workspace ${input.workspace} not found`);
      workspaceId = ws.id;
    }
    const id = newId("g");
    this.mutateCanvas(topicId, (doc) => addGroupAuto(doc, { id, title, workspaceId }));
    return { groupId: id, title };
  }

  canvasAddDependency(fromTaskId: unknown, toTaskId: unknown): { from: Id; to: Id } {
    const from = this.requireTask(String(fromTaskId));
    const to = this.requireTask(String(toTaskId));
    if (!from.topicId || from.topicId !== to.topicId) throw new HostError("bad_request", "dependencies connect two tasks of the same topic");
    this.mutateCanvas(from.topicId, (doc) => addDependency(doc, from.id, to.id, newId("e")));
    return { from: from.id, to: to.id };
  }

  /**
   * A colour mark on the canvas (2026-10-17): `target` is a group's or a note's id, or a task with a card (its own or a
   * reference) there; `color` one of CANVAS_COLORS, or "none" to take the mark off.
   */
  canvasSetColor(topicId: Id, input: { target?: unknown; color?: unknown }): { target: Id; color: string } {
    const target = typeof input.target === "string" ? input.target.trim() : "";
    const color = input.color === "none" || input.color === null || input.color === "" ? null : input.color;
    if (!target) throw new HostError("bad_request", "target is required: a group or note id, or a task id");
    if (color !== null && !isCanvasColor(color)) throw new HostError("bad_request", `color must be one of ${CANVAS_COLORS.map((c) => c.id).join(", ")} or none`);
    const paint = <T extends { color?: unknown }>(o: T): T => {
      const { color: _old, ...rest } = o;
      return (color ? { ...rest, color } : rest) as T;
    };
    this.mutateCanvas(topicId, (doc) => {
      if (doc.groups.some((g) => g.id === target)) return { ...doc, groups: doc.groups.map((g) => (g.id === target ? paint(g) : g)) };
      const node = doc.nodes.find((n) => n.id === target || (n.kind !== "note" && n.taskId === target));
      if (!node) throw new HostError("bad_request", `nothing on this canvas is ${target}: give a group or note id, or a task with a card here`);
      return { ...doc, nodes: doc.nodes.map((n) => (n === node ? paint(n) : n)) };
    });
    return { target, color: color ?? "none" };
  }

  canvasPlaceTask(taskId: unknown, groupId: unknown): { taskId: Id; groupId: Id | null } {
    const task = this.requireTask(String(taskId));
    if (!task.topicId) throw new HostError("bad_request", "the task is not in a topic, so it has no canvas");
    const group = typeof groupId === "string" && groupId ? groupId : null;
    this.mutateCanvas(task.topicId, (doc) => placeTask(doc, task.id, group, newId("n")));
    return { taskId: task.id, groupId: group };
  }

  /**
   * Shows or hides a task's card on its topic's canvas ("显示在画布上"). Shown, a task not on the canvas yet goes below
   * everything ungrouped; hidden, only its card goes (it stays in the topic, with its dependencies).
   */
  setTaskOnCanvas(taskId: Id, input: { onCanvas?: unknown }): CanvasDoc {
    const task = this.requireTask(taskId);
    if (!task.topicId) throw new HostError("bad_request", "the task is not in a topic, so it has no canvas");
    if (typeof input.onCanvas !== "boolean") throw new HostError("bad_request", "onCanvas must be true or false");
    const placed = this.canvas(task.topicId).nodes.some((n) => n.kind === "task" && n.taskId === task.id);
    if (placed === input.onCanvas) return this.canvas(task.topicId);
    return this.mutateCanvas(task.topicId, (doc) => (input.onCanvas ? placeTask(doc, task.id, null, newId("n")) : unplaceTask(doc, task.id)));
  }

  /** Applies a change to the latest canvas and saves it (one synchronous read-modify-write, so no version race here). */
  private mutateCanvas(topicId: Id, change: (doc: CanvasDoc) => CanvasDoc): CanvasDoc {
    const current = this.canvas(topicId);
    let next: CanvasDoc;
    try {
      next = change(current);
    } catch (err) {
      if (err instanceof CanvasLayoutError) throw new HostError("bad_request", err.message);
      throw err;
    }
    return this.saveCanvas(topicId, { ...next, version: current.version });
  }

  canvasOutline(topicId: Id) {
    return canvasOutline(this.canvas(topicId), this.topicTasks(topicId), this.store.listWorkspaces(), this.store.listSessions(), {
      tasks: this.store.listTasks(),
      topics: this.store.listTopics(),
    });
  }
}
