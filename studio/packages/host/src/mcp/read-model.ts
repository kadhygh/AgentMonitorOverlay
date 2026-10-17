import { buildSessionTree, isCommon, RUNTIME_LABELS, taskWhere, topicWorkspaceIds, type Id, type ModelProfile, type Session, type SessionNode, type SessionStatus, type Task, type TaskColumn, type Topic } from "@amo-studio/protocol";
import type { HostService } from "../service.js";
import type { McpCaller } from "./tools.js";

// What agents read through the AMO MCP: plain structures, no coordinates, no full transcripts. Read-only by design;
// writing tools come in stage 5.

const URGENCY: SessionStatus[] = ["awaiting-approval", "awaiting-answer", "awaiting-review", "error", "running", "idle", "completed"];
const EXCERPT = 300;

export class NotFoundError extends Error {}

export class ReadModel {
  /** `caller`: the session asking, so "my topic" can be the default; null for anonymous reads. */
  constructor(
    private readonly service: HostService,
    private readonly caller: McpCaller | null = null,
  ) {}

  private get store() {
    return this.service.store;
  }

  private live(taskId: Id): Session[] {
    return this.store.listSessions({ taskId }).filter((s) => !s.archivedAt);
  }

  private liveTopicSessions(topicId: Id): Session[] {
    return this.store.listSessions({ topicId }).filter((s) => !s.archivedAt);
  }

  private status(taskId: Id): SessionStatus | null {
    const live = this.live(taskId);
    return URGENCY.find((u) => live.some((s) => s.status === u)) ?? null;
  }

  private where(task: Task): string {
    return taskWhere(task, this.store.listWorkspaces());
  }

  private topicTitle(id: Id | null): string | null {
    return id ? (this.store.getTopic(id)?.title ?? null) : null;
  }

  /** A topic by id or title; the caller's own topic when omitted (for the features' tools). */
  topicRef(ref?: string): Topic {
    return this.topic(ref);
  }

  /** A topic by id or title; the caller's own topic when omitted. */
  private topic(ref?: string): Topic {
    if (ref === undefined || ref === "") {
      const own = this.caller ? this.service.topics.topicOfSession(this.caller.sessionId) : null;
      if (!own) throw new NotFoundError("name a topic (id or title): you are not working in one");
      return own;
    }
    const t = this.store.listTopics().find((x) => x.id === ref || x.title === ref);
    if (!t) throw new NotFoundError(`topic ${ref} not found`);
    return t;
  }

  private model(profileId: Id): string {
    const p: ModelProfile | undefined = this.service.profiles.find((x) => x.id === profileId);
    return p ? `${RUNTIME_LABELS[p.runtime]} · ${p.label}` : profileId;
  }

  private requireTask(taskId: Id): Task {
    const t = this.store.getTask(taskId);
    if (!t) throw new NotFoundError(`task ${taskId} not found`);
    return t;
  }

  /** Project by id or name (the common space is not one). */
  private workspaceId(ref: string): Id {
    const ws = this.store.listWorkspaces().find((w) => !isCommon(w) && (w.id === ref || w.name === ref));
    if (!ws) throw new NotFoundError(`workspace ${ref} not found`);
    return ws.id;
  }

  /** Tasks on the board, most recently active first. */
  boardList(filter: { workspace?: string; topic?: string; column?: TaskColumn } = {}) {
    const wsId = filter.workspace ? this.workspaceId(filter.workspace) : null;
    const topicId = filter.topic ? this.topic(filter.topic).id : null;
    const tasks = this.store
      .listTasks()
      .filter((t) => !t.archivedAt)
      .filter((t) => !filter.column || t.column === filter.column)
      .filter((t) => !wsId || t.workspaceId === wsId)
      .filter((t) => !topicId || t.topicId === topicId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title || "未命名任务",
        column: t.column,
        status: this.status(t.id),
        workspace: this.where(t),
        topic: t.topicId ? { id: t.topicId, title: this.topicTitle(t.topicId) } : null,
        sessions: this.live(t.id).length,
        updatedAt: t.updatedAt,
      })),
    };
  }

  /** Live topics with their projects and how many tasks they hold. */
  topicList() {
    const tasks = this.store.listTasks();
    const workspaces = this.store.listWorkspaces();
    const name = (id: Id) => workspaces.find((w) => w.id === id)?.name ?? id;
    return {
      topics: this.store
        .listTopics()
        .filter((t) => !t.archivedAt)
        .map((t) => ({
          id: t.id,
          title: t.title,
          ...(t.description ? { description: t.description } : {}),
          projects: topicWorkspaceIds(t, tasks, workspaces).map(name),
          openTasks: tasks.filter((x) => x.topicId === t.id && !x.archivedAt && x.column !== "done").length,
          sessions: this.liveTopicSessions(t.id).length,
          updatedAt: t.updatedAt,
        })),
    };
  }

  /** One topic: projects, tasks, its own sessions (with the latest reply's excerpt) and its canvas outline. */
  topicGet(ref?: string) {
    const t = this.topic(ref);
    const workspaces = this.store.listWorkspaces();
    const name = (id: Id) => workspaces.find((w) => w.id === id)?.name ?? id;
    const { outline } = this.service.canvases.canvasOutline(t.id);
    return {
      id: t.id,
      title: t.title,
      ...(t.description ? { description: t.description } : {}),
      archived: !!t.archivedAt,
      projects: topicWorkspaceIds(t, this.store.listTasks(), workspaces).map(name),
      tasks: this.boardList({ topic: t.id }).tasks,
      sessions: this.liveTopicSessions(t.id).map((s) => ({ id: s.id, kind: s.kind, parentId: s.parentId, title: s.title, status: s.status, model: this.model(s.profileId), workspace: name(s.workspaceId), lastReply: this.lastReply(s.id) })),
      canvas: outline,
    };
  }

  private lastReply(sessionId: Id): string {
    const last = [...this.store.listItems(sessionId)].reverse().find((i) => i.type === "agent");
    const reply = last && last.type === "agent" ? last.markdown.trim() : "";
    return reply.length > EXCERPT ? `${reply.slice(0, EXCERPT)}…` : reply;
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
    const canvas = t.topicId ? this.service.canvases.canvas(t.topicId) : { nodes: [], groups: [], edges: [] };
    const title = (id: Id) => this.store.getTask(id)?.title || "未命名任务";
    const node = canvas.nodes.find((n) => n.kind === "task" && n.taskId === t.id);
    const group = node?.groupId ? (canvas.groups.find((g) => g.id === node.groupId)?.title ?? null) : null;
    return {
      id: t.id,
      title: t.title || "未命名任务",
      handoff: handoff ? { text: handoff.text, by: author(handoff.sessionId), at: handoff.createdAt } : null,
      // The steps from the task's template (empty when it has none); tick them with checklist_check.
      checklist: this.store.listChecklist(t.id).map((i) => ({ id: i.id, text: i.text, done: i.done, ...(i.done ? { by: author(i.doneBySessionId) } : {}) })),
      column: t.column,
      status: this.status(t.id),
      workspace: this.where(t),
      topic: t.topicId ? { id: t.topicId, title: this.topicTitle(t.topicId) } : null,
      archived: !!t.archivedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      canvasGroup: group,
      dependsOn: canvas.edges.filter((e) => e.to === t.id).map((e) => ({ id: e.from, title: title(e.from) })),
      dependents: canvas.edges.filter((e) => e.from === t.id).map((e) => ({ id: e.to, title: title(e.to) })),
      recentNotes: notes.filter((n) => n.kind === "progress").slice(-5).map((n) => ({ text: n.text, by: author(n.sessionId), at: n.createdAt })),
      sessions: this.live(t.id).map((s) => ({ id: s.id, kind: s.kind, parentId: s.parentId, title: s.title, status: s.status, model: this.model(s.profileId) })),
    };
  }

  /**
   * Extension packs of one workspace (id or name) or of all of them: what each offers (documents, task templates,
   * session presets), not the contents. Packs with errors are listed with their errors.
   */
  packList(workspace?: string) {
    const all = this.store.listWorkspaces();
    const list = workspace ? all.filter((w) => w.id === this.workspaceId(workspace)) : all;
    return {
      packs: list.flatMap((w) =>
        this.service.extensions.packs(w.id).map((p) => ({
          workspace: { id: w.id, name: w.name },
          pack: p.dirName,
          title: p.manifest?.title ?? null,
          ...(p.manifest?.description ? { description: p.manifest.description } : {}),
          ...(p.errors.length ? { errors: p.errors } : {}),
          docs: p.manifest?.docs.map((d) => ({ id: d.id, title: d.title, ...(d.summary ? { summary: d.summary } : {}) })) ?? [],
          templates: p.manifest?.templates.map((t) => ({ id: t.id, title: t.title, steps: t.steps.length })) ?? [],
          presets: p.manifest?.presets.map((x) => ({ id: x.id, title: x.title })) ?? [],
        })),
      ),
    };
  }

  /** One pack document's text. */
  packDoc(workspace: string, pack: string, doc: string) {
    return this.service.extensions.packDoc(this.workspaceId(workspace), pack, doc);
  }

  /** The task's sessions as a tree, each with an excerpt of its latest reply. */
  sessionTree(taskId: Id) {
    this.requireTask(taskId);
    const wsName = (id: Id) => this.store.getWorkspace(id)?.name ?? null;
    const toNode = (n: SessionNode): Record<string, unknown> => {
      const s = n.session;
      return {
        id: s.id,
        kind: s.kind,
        title: s.title,
        status: s.status,
        model: this.model(s.profileId),
        workspace: wsName(s.workspaceId),
        writer: s.writer,
        lastReply: this.lastReply(s.id),
        children: n.children.map(toNode),
      };
    };
    return { taskId, sessions: buildSessionTree(this.live(taskId)).map(toNode) };
  }

  /** Registered projects and the common folder; with a project named, also its open tasks. */
  projectContext(workspace?: string) {
    const all = this.store.listWorkspaces();
    if (!workspace) {
      const common = all.find(isCommon);
      return {
        workspaces: all
          .filter((w) => !isCommon(w))
          .map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path,
            ...(w.description ? { description: w.description } : {}),
            openTasks: this.store.listTasks().filter((t) => t.column !== "done" && !t.archivedAt && t.workspaceId === w.id).length,
          })),
        commonFolder: common?.path ?? null,
      };
    }
    const id = this.workspaceId(workspace);
    const w = all.find((x) => x.id === id)!;
    return { workspace: { id: w.id, name: w.name, path: w.path, ...(w.description ? { description: w.description } : {}) }, openTasks: this.boardList({ workspace: id }).tasks.filter((t) => t.column !== "done") };
  }

  /** A topic's canvas as structure: groups, tasks, notes, dependencies; no coordinates. */
  canvasRead(topic?: string) {
    return this.service.canvases.canvasOutline(this.topic(topic).id);
  }
}
