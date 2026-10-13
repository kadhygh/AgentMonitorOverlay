import { join } from "node:path";
import type { CanvasDoc, Id, Task } from "@amo-studio/protocol";
import { addDependency, addGroupAuto, CanvasLayoutError, canvasOutline, emptyCanvas, isCommon, placeTask, removeTask, validateCanvas } from "@amo-studio/protocol";
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
    const doc = input as CanvasDoc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.groups) || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
      throw new HostError("bad_request", "canvas needs groups, nodes and edges arrays");
    }
    if (this.requireTopic(topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    const current = this.canvas(topicId);
    if (doc.version !== current.version) {
      throw new HostError("conflict", `canvas changed elsewhere (version ${current.version}, yours ${String(doc.version)}); reload and retry`);
    }
    // Archived tasks keep their cards and dependencies (hidden while archived, back on restore), so they count too:
    // refusing them made every later save of that canvas fail (S11-A: an empty group that would not go away).
    const known = this.store.listTasks().filter((t) => t.topicId === topicId);
    const errors = validateCanvas(doc, new Set(known.map((t) => t.id)));
    if (errors.length) throw new HostError("bad_request", errors.slice(0, 5).join("; "));
    const next: CanvasDoc = {
      id: topicId,
      version: current.version + 1,
      groups: doc.groups,
      nodes: doc.nodes,
      edges: doc.edges,
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

  canvasPlaceTask(taskId: unknown, groupId: unknown): { taskId: Id; groupId: Id | null } {
    const task = this.requireTask(String(taskId));
    if (!task.topicId) throw new HostError("bad_request", "the task is not in a topic, so it has no canvas");
    const group = typeof groupId === "string" && groupId ? groupId : null;
    this.mutateCanvas(task.topicId, (doc) => placeTask(doc, task.id, group, newId("n")));
    return { taskId: task.id, groupId: group };
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
    return canvasOutline(this.canvas(topicId), this.topicTasks(topicId), this.store.listWorkspaces(), this.store.listSessions());
  }
}
