import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CanvasDoc, GitExcludeState, Id, Task, Workspace } from "@amo-studio/protocol";
import { isCommon } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { addGitExclude, readGitExclude } from "./git-exclude.js";

/** Projects (workspaces): registering, archiving and removing them. */
export class ProjectsFeature extends Feature {
  addWorkspace(input: { path: string; name?: string }): Workspace {
    if (!input.path?.trim()) throw new HostError("bad_request", "path is required");
    const path = resolve(input.path.trim());
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new HostError("bad_request", `not a directory: ${path}`);
    const known = this.store.findWorkspaceByPath(path);
    if (known?.archivedAt) throw new HostError("conflict", `这个文件夹是已归档的项目「${known.name}」，到 设置 → 数据管理 里恢复它`);
    if (known) throw new HostError("conflict", `workspace already registered: ${path}`);
    const ws = this.store.addWorkspace({ path, name: input.name?.trim() || basename(path) || path });
    this.publish({ type: "workspace.upserted", workspace: ws });
    return ws;
  }

  /** 编辑项目: the name shown in Studio (the folder is not renamed) and a note on the project, both optional. */
  updateWorkspace(id: Id, patch: { name?: unknown; description?: unknown }): Workspace {
    const ws = this.requireWorkspace(id);
    if (isCommon(ws)) throw new HostError("conflict", "the common space cannot be edited here");
    const clean: { name?: string; description?: string } = {};
    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || !patch.name.trim()) throw new HostError("bad_request", "name must be a non-empty string");
      if (patch.name.trim().length > 80) throw new HostError("bad_request", "name is too long (80 at most)");
      clean.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== "string") throw new HostError("bad_request", "description must be a string");
      if (patch.description.length > 2000) throw new HostError("bad_request", "description is too long (2000 at most)");
      clean.description = patch.description.trim();
    }
    const workspace = this.store.updateWorkspace(id, clean);
    this.publish({ type: "workspace.upserted", workspace });
    return workspace;
  }

  /**
   * Archives the project: it leaves every list, its tasks are archived with their sessions, and so are topic sessions
   * that run in it. Restoring brings back what was archived with it.
   */
  async archiveWorkspace(id: Id): Promise<{ workspace: Workspace; tasks: Task[] }> {
    const ws = this.requireWorkspace(id);
    if (isCommon(ws)) throw new HostError("conflict", "the common space cannot be archived");
    if (ws.archivedAt) return { workspace: ws, tasks: [] };
    const workspace = this.store.setWorkspaceArchived(id, new Date().toISOString());
    this.publish({ type: "workspace.upserted", workspace });
    const tasks: Task[] = [];
    for (const t of this.store.listTasks().filter((x) => x.workspaceId === id && !x.archivedAt)) tasks.push(await this.f.tasks.archiveTask(t.id));
    await this.f.tasks.archiveSessions(this.store.listSessions().filter((s) => s.topicId && s.workspaceId === id));
    return { workspace: this.store.getWorkspace(id)!, tasks };
  }

  async unarchiveWorkspace(id: Id): Promise<{ workspace: Workspace; tasks: Task[] }> {
    const ws = this.requireWorkspace(id);
    if (!ws.archivedAt) return { workspace: ws, tasks: [] };
    const since = ws.archivedAt;
    const workspace = this.store.setWorkspaceArchived(id, null);
    this.publish({ type: "workspace.upserted", workspace });
    const tasks: Task[] = [];
    for (const t of this.store.listTasks().filter((x) => x.workspaceId === id && x.archivedAt && x.archivedAt >= since)) {
      // A task whose topic is archived stays archived until the topic is restored.
      if (t.topicId && this.store.getTopic(t.topicId)?.archivedAt) continue;
      tasks.push(await this.f.tasks.unarchiveTask(t.id));
    }
    const topicSessions = this.store.listSessions().filter((s) => s.topicId && s.workspaceId === id && !this.store.getTopic(s.topicId)?.archivedAt);
    await this.f.tasks.unarchiveSessions(topicSessions, since);
    return { workspace: this.store.getWorkspace(id)!, tasks };
  }

  /** Whether git leaves the project's `.amo/` (extension packs) out. */
  gitExclude(id: Id): Promise<GitExcludeState> {
    return readGitExclude(this.requireWorkspace(id).path);
  }

  /** 一键忽略 .amo/: one line in the repository's `.git/info/exclude`, unless git leaves it out already. */
  async addGitExclude(id: Id): Promise<GitExcludeState> {
    const ws = this.requireWorkspace(id);
    if (isCommon(ws)) throw new HostError("conflict", "the common space has no git settings here");
    const state = await addGitExclude(ws.path);
    if (!state.git) throw new HostError("bad_request", "这个文件夹不在 git 仓库里");
    return state;
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
    this.dropHints(id);
  }

  /** Todos, topics and canvas groups only point at a workspace as a hint; drop the hint rather than leave it dangling. */
  dropHints(id: Id): void {
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
