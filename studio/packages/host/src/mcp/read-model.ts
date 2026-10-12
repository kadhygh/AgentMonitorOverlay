import { buildSessionTree, taskWhere, type Id, type ModelProfile, type Session, type SessionNode, type SessionStatus, type Task, type TaskColumn } from "@amo-studio/protocol";
import type { HostService } from "../service.js";

// What agents read through the AMO MCP: plain structures, no coordinates, no full transcripts. Read-only by design;
// writing tools come in stage 5.

const URGENCY: SessionStatus[] = ["awaiting-approval", "awaiting-review", "error", "running", "idle", "completed"];
const EXCERPT = 300;

export class NotFoundError extends Error {}

export class ReadModel {
  constructor(private readonly service: HostService) {}

  private get store() {
    return this.service.store;
  }

  private live(taskId: Id): Session[] {
    return this.store.listSessions({ taskId }).filter((s) => !s.archivedAt);
  }

  private status(taskId: Id): SessionStatus | null {
    const live = this.live(taskId);
    return URGENCY.find((u) => live.some((s) => s.status === u)) ?? null;
  }

  private where(task: Task): string {
    return taskWhere(task, this.store.listSessions(), this.store.listWorkspaces());
  }

  private model(profileId: Id): string {
    const p: ModelProfile | undefined = this.service.profiles.find((x) => x.id === profileId);
    return p ? `${p.runtime === "codex" ? "Codex" : "Claude"} · ${p.label}` : profileId;
  }

  private requireTask(taskId: Id): Task {
    const t = this.store.getTask(taskId);
    if (!t) throw new NotFoundError(`task ${taskId} not found`);
    return t;
  }

  /** Workspace by id or name. */
  private workspaceId(ref: string): Id {
    const ws = this.store.listWorkspaces().find((w) => w.id === ref || w.name === ref);
    if (!ws) throw new NotFoundError(`workspace ${ref} not found`);
    return ws.id;
  }

  /** Tasks on the board, most recently active first. */
  boardList(filter: { workspace?: string; column?: TaskColumn } = {}) {
    const wsId = filter.workspace ? this.workspaceId(filter.workspace) : null;
    const tasks = this.store
      .listTasks()
      .filter((t) => !filter.column || t.column === filter.column)
      .filter((t) => !wsId || (t.scope.kind === "workspace" ? t.scope.workspaceId === wsId : this.live(t.id).some((s) => s.workspaceId === wsId)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title || "未命名任务",
        column: t.column,
        status: this.status(t.id),
        workspace: this.where(t),
        sessions: this.live(t.id).length,
        updatedAt: t.updatedAt,
      })),
    };
  }

  /**
   * One task: its latest handoff summary (first: it is what a session taking over needs), where it stands, what it
   * depends on, its group on the canvas, recent progress notes and its sessions (no transcripts).
   */
  taskGet(taskId: Id) {
    const t = this.requireTask(taskId);
    const notes = this.store.listTaskNotes(t.id);
    const author = (sessionId: Id | null) => (sessionId ? this.store.getSession(sessionId)?.title || "会话" : "person");
    const handoff = [...notes].reverse().find((n) => n.kind === "handoff");
    const canvas = this.service.canvas();
    const title = (id: Id) => this.store.getTask(id)?.title || "未命名任务";
    const node = canvas.nodes.find((n) => n.kind === "task" && n.taskId === t.id);
    const group = node?.groupId ? (canvas.groups.find((g) => g.id === node.groupId)?.title ?? null) : null;
    return {
      id: t.id,
      title: t.title || "未命名任务",
      handoff: handoff ? { text: handoff.text, by: author(handoff.sessionId), at: handoff.createdAt } : null,
      column: t.column,
      status: this.status(t.id),
      workspace: this.where(t),
      crossWorkspace: t.scope.kind === "area",
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      canvasGroup: group,
      dependsOn: canvas.edges.filter((e) => e.to === t.id).map((e) => ({ id: e.from, title: title(e.from) })),
      dependents: canvas.edges.filter((e) => e.from === t.id).map((e) => ({ id: e.to, title: title(e.to) })),
      recentNotes: notes.filter((n) => n.kind === "progress").slice(-5).map((n) => ({ text: n.text, by: author(n.sessionId), at: n.createdAt })),
      sessions: this.live(t.id).map((s) => ({ id: s.id, kind: s.kind, parentId: s.parentId, title: s.title, status: s.status, model: this.model(s.profileId) })),
    };
  }

  /** The task's sessions as a tree, each with an excerpt of its latest reply. */
  sessionTree(taskId: Id) {
    this.requireTask(taskId);
    const wsName = (id: Id) => this.store.getWorkspace(id)?.name ?? null;
    const toNode = (n: SessionNode): Record<string, unknown> => {
      const s = n.session;
      const last = [...this.store.listItems(s.id)].reverse().find((i) => i.type === "agent");
      const reply = last && last.type === "agent" ? last.markdown.trim() : "";
      return {
        id: s.id,
        kind: s.kind,
        title: s.title,
        status: s.status,
        model: this.model(s.profileId),
        workspace: wsName(s.workspaceId),
        writer: s.writer,
        lastReply: reply.length > EXCERPT ? `${reply.slice(0, EXCERPT)}…` : reply,
        children: n.children.map(toNode),
      };
    };
    return { taskId, sessions: buildSessionTree(this.live(taskId)).map(toNode) };
  }

  /** Registered workspaces; with one named, also its open tasks. */
  projectContext(workspace?: string) {
    const all = this.store.listWorkspaces();
    if (!workspace) {
      return {
        workspaces: all.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          openTasks: this.store.listTasks().filter((t) => t.column !== "done" && t.scope.kind === "workspace" && t.scope.workspaceId === w.id).length,
        })),
      };
    }
    const id = this.workspaceId(workspace);
    const w = all.find((x) => x.id === id)!;
    return { workspace: { id: w.id, name: w.name, path: w.path }, openTasks: this.boardList({ workspace: id }).tasks.filter((t) => t.column !== "done") };
  }

  /** The canvas as structure: groups, tasks, notes, dependencies; no coordinates. */
  canvasRead() {
    return this.service.canvasOutline();
  }
}
