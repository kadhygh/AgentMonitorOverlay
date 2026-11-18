import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CanvasDoc, Id, Session, Task, Workspace } from "@amo-studio/protocol";
import { isCommon } from "@amo-studio/protocol";
import { HostError, sessionMoving } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Projects (workspaces): registering, archiving and removing them. */
export class ProjectsFeature extends Feature<"tasks"> {
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

  /**
   * project_add (2026-11-18, the user: ai 可以添加工程): the folder as a project, with the name and note it was given;
   * a folder already registered gives back that project unchanged rather than a second one. An archived one is refused
   * as 添加项目 refuses it: restoring it brings its tasks back, which is the person's to do in 设置 → 数据管理.
   */
  ensureWorkspace(input: { path: string; name?: string; description?: string }): { workspace: Workspace; added: boolean } {
    if (!input.path?.trim()) throw new HostError("bad_request", "path is required");
    // An agent may write the folder in another case or with / (Windows folders do not care): the same project.
    const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
    const want = norm(input.path.trim());
    const known = this.store.findWorkspaceByPath(resolve(input.path.trim())) ?? this.store.listWorkspaces().find((w) => norm(w.path) === want);
    if (known?.archivedAt) throw new HostError("conflict", `这个文件夹是已归档的项目「${known.name}」：请人到 设置 → 数据管理 里恢复它（它的任务会一起恢复）`);
    if (known) return { workspace: known, added: false };
    // Checked before the folder is registered, so a refused name or note leaves nothing behind.
    if ((input.name?.trim().length ?? 0) > 80) throw new HostError("bad_request", "name is too long (80 at most)");
    if ((input.description?.length ?? 0) > 2000) throw new HostError("bad_request", "description is too long (2000 at most)");
    const ws = this.addWorkspace({ path: input.path, ...(input.name !== undefined ? { name: input.name } : {}) });
    return { workspace: input.description?.trim() ? this.updateWorkspace(ws.id, { description: input.description }) : ws, added: true };
  }

  /**
   * What 归档项目 takes with it (project_remove's approval and refusal, 2026-11-18): the project's tasks not archived
   * yet, and the sessions going with them — its tasks' and the topic sessions that run in it — that are still at work.
   */
  archiveFacts(id: Id): { workspace: Workspace; tasks: Task[]; moving: Session[] } {
    const workspace = this.requireWorkspace(id);
    const tasks = this.store.listTasks().filter((t) => t.workspaceId === id && !t.archivedAt);
    const taskIds = new Set(tasks.map((t) => t.id));
    const moving = this.store.listSessions().filter((s) => ((s.taskId && taskIds.has(s.taskId)) || (s.topicId && s.workspaceId === id)) && sessionMoving(s));
    return { workspace, tasks, moving };
  }

  /**
   * project_remove (2026-11-18, the user: ai 可以删除工程): what the person's 归档项目 in the left column does — the
   * project leaves every list, its tasks and their sessions are archived, 设置 → 数据管理 restores it — and never
   * the folder. Refused while one of those sessions is at work (in a turn, waiting for the person, on a /loop or a
   * usage limit, in a terminal): archiving would cut it off, the asking session's own turn included; session_archive
   * refuses the same.
   */
  async archiveForAgent(id: Id): Promise<{ workspace: Workspace; tasks: Task[] }> {
    const { workspace, moving } = this.archiveFacts(id);
    if (isCommon(workspace)) throw new HostError("conflict", "公共空间不是项目，不能移除");
    if (workspace.archivedAt) throw new HostError("conflict", `项目「${workspace.name}」已经归档了`);
    if (moving.length) {
      const named = moving.slice(0, 5).map((s) => `「${s.title || "未命名会话"}」`).join("、");
      throw new HostError("conflict", `项目「${workspace.name}」里还有 ${moving.length} 个会话在运行或等人（${named}${moving.length > 5 ? " 等" : ""}）：移除会打断它们。等它们停下再移除；你自己的会话也在其中时，请人在左栏右键这个项目「归档项目」。`);
    }
    return this.archiveWorkspace(id);
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
