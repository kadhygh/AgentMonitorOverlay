import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CanvasDoc, Id, Workspace } from "@amo-studio/protocol";
import { isCommon } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Projects (workspaces): registering and removing them. */
export class ProjectsFeature extends Feature {
  addWorkspace(input: { path: string; name?: string }): Workspace {
    if (!input.path?.trim()) throw new HostError("bad_request", "path is required");
    const path = resolve(input.path.trim());
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new HostError("bad_request", `not a directory: ${path}`);
    if (this.store.findWorkspaceByPath(path)) throw new HostError("conflict", `workspace already registered: ${path}`);
    const ws = this.store.addWorkspace({ path, name: input.name?.trim() || basename(path) || path });
    this.publish({ type: "workspace.upserted", workspace: ws });
    return ws;
  }

  removeWorkspace(id: Id): void {
    const ws = this.store.getWorkspace(id);
    if (!ws) throw new HostError("not_found", `workspace ${id} not found`);
    if (isCommon(ws)) throw new HostError("conflict", "the common space cannot be removed");
    try {
      this.store.removeWorkspace(id);
    } catch (err) {
      throw new HostError("conflict", (err as Error).message);
    }
    this.publish({ type: "workspace.removed", workspaceId: id });
    // Todos, topics and canvas groups only point at a workspace as a hint; drop the hint rather than leave it dangling.
    for (const todo of this.store.listTodos().filter((t) => t.workspaceId === id)) {
      const next = { ...todo, workspaceId: null };
      this.store.putTodo(next);
      this.publish({ type: "todo.upserted", todo: next });
    }
    for (const topic of this.store.listTopics()) {
      if (topic.workspaceIds.includes(id)) this.publish({ type: "topic.upserted", topic: this.store.updateTopic(topic.id, { workspaceIds: topic.workspaceIds.filter((w) => w !== id) }) });
      const canvas = this.store.getCanvas(topic.id);
      if (!canvas?.groups.some((g) => g.workspaceId === id)) continue;
      const next: CanvasDoc = {
        ...canvas,
        version: canvas.version + 1,
        groups: canvas.groups.map((g) => (g.workspaceId === id ? { ...g, workspaceId: null } : g)),
        updatedAt: new Date().toISOString(),
      };
      this.store.putCanvas(next);
      this.publish({ type: "canvas.updated", canvas: next });
    }
  }
}
