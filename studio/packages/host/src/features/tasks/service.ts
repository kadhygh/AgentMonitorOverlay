import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CanvasDoc, Id, NewSessionInput, Session, SessionOptions, Task, TaskColumn, Workspace, ChecklistItem, TaskTemplateChoice } from "@amo-studio/protocol";
import { isCommon, MAIN_CANVAS_ID, removeTask, TASK_COLUMNS, TASK_DESCRIPTION_MAX } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError, sessionOptions, LEGACY_COMMON_WORKSPACE_KEY, COMMON_NAME } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { fillDefaults, readModelPrefs } from "../../core/model-prefs.js";

/** Tasks: creating, renaming, moving, archiving, their sessions; bringing older data into structure v2. */
export class TasksFeature extends Feature {
  /**
   * Brings data from before structure v2 into shape, once per start (cheap when there is nothing to do): makes sure
   * the common space exists, gives tasks of the old cross-workspace area a workspace (and a topic when their sessions
   * ran in several projects), and turns the old global canvas into the first topic.
   */
  ensureStructure(): void {
    this.store.transaction(() => {
      this.ensureCommonWorkspace();
      for (const task of this.store.listTasksWithoutWorkspace()) this.resolveAreaTask(task);
      this.migrateGlobalCanvas();
    });
  }

  private ensureCommonWorkspace(): Workspace {
    const existing = this.store.listWorkspaces().find(isCommon);
    if (existing) return existing;
    const legacyId = this.store.getKv(LEGACY_COMMON_WORKSPACE_KEY)?.value;
    const legacy = legacyId ? this.store.getWorkspace(legacyId) : undefined;
    if (legacy) return this.store.setCommonWorkspace(legacy.id);
    const dbPath = this.store.path;
    const path = resolve(this.options.commonDir ?? (dbPath === ":memory:" ? join(tmpdir(), "amo-studio-common") : join(dirname(dbPath), "common")));
    mkdirSync(path, { recursive: true });
    const taken = this.store.findWorkspaceByPath(path);
    if (taken) return this.store.setCommonWorkspace(taken.id);
    return this.store.addWorkspace({ path, name: COMMON_NAME, builtin: "common" });
  }

  /**
   * A task from the old cross-workspace area: it takes the workspace of its first session (the common space when it
   * has none). When its sessions ran in several projects, a topic of the same name takes the task and the session
   * trees that ran elsewhere become that topic's sessions, so every task session runs in its task's workspace.
   */
  private resolveAreaTask(task: Task): void {
    const sessions = this.store.listSessions({ taskId: task.id });
    const roots = sessions.filter((s) => !s.parentId);
    const workspaceId = roots[0]?.workspaceId ?? sessions[0]?.workspaceId ?? this.commonWorkspace().id;
    const elsewhere = roots.filter((s) => s.workspaceId !== workspaceId);
    let topicId: Id | null = null;
    if (elsewhere.length) {
      const ids = [...new Set(roots.map((s) => s.workspaceId))].filter((id) => !isCommon(this.store.getWorkspace(id)));
      topicId = this.store.createTopic({ title: task.title || "跨项目任务", workspaceIds: ids }).id;
      for (const root of elsewhere) this.store.moveSessionTreeToTopic(root.id, topicId);
    }
    this.store.updateTask(task.id, { workspaceId, ...(topicId ? { topicId } : {}) });
  }

  /** The single canvas from before topics becomes a topic holding the tasks placed on it. */
  private migrateGlobalCanvas(): void {
    const doc = this.store.getCanvas(MAIN_CANVAS_ID);
    if (!doc) return;
    if (doc.groups.length || doc.nodes.length) {
      const topic = this.store.createTopic({ title: "专题 1" });
      const placed = doc.nodes.flatMap((n) => (n.kind === "task" ? [n.taskId] : []));
      let next: CanvasDoc = { ...doc, id: topic.id };
      for (const taskId of placed) {
        const task = this.store.getTask(taskId);
        // A task can be in one topic only; one that already got a topic above leaves this canvas.
        if (task && !task.topicId) this.store.updateTask(taskId, { topicId: topic.id });
        else next = removeTask(next, taskId);
      }
      this.store.putCanvas(next);
    }
    this.store.deleteCanvas(MAIN_CANVAS_ID);
  }

  /**
   * A task in a project (the common space when none is given), optionally in a topic. With `firstSession` its first
   * session starts at once; without, the task is only filed (待办 unless another column is given).
   */
  async createTask(input: {
    title?: string;
    workspaceId?: Id | null;
    topicId?: Id | null;
    column?: TaskColumn;
    lead?: boolean;
    firstSession?: NewSessionInput;
    template?: TaskTemplateChoice;
  }): Promise<{ task: Task; session: Session | null }> {
    const workspace = input.workspaceId ? this.requireLiveWorkspace(input.workspaceId) : this.commonWorkspace();
    const topic = input.topicId ? this.requireLiveTopic(input.topicId) : null;
    if (input.firstSession) {
      this.requireProfile(input.firstSession.profileId);
      if (input.firstSession.workspaceId && input.firstSession.workspaceId !== workspace.id) throw new HostError("bad_request", "a task's sessions run in the task's own workspace");
    }
    if (input.column !== undefined && !TASK_COLUMNS.includes(input.column)) throw new HostError("bad_request", `unknown column ${String(input.column)}`);
    const template = input.template ? this.f.extensions.packTemplate(workspace.id, input.template) : null;
    const base = input.title?.trim() || input.firstSession?.text?.trim().slice(0, 60) || template?.title || "";
    const title = template?.titlePrefix && !base.startsWith(template.titlePrefix.trim()) ? `${template.titlePrefix}${base}` : base;
    const column = input.firstSession ? "doing" : (input.column ?? "todo");
    const task = this.store.createTask({ title, workspaceId: workspace.id, topicId: topic?.id ?? null, column, lead: input.lead === true });
    this.publish({ type: "task.upserted", task });
    if (template && input.template) {
      template.steps.forEach((text, position) => {
        const item: ChecklistItem = { id: newId("chk"), taskId: task.id, position, text, done: false, doneBySessionId: null, doneAt: null, source: `${input.template!.pack}/${template.id}` };
        this.store.putChecklistItem(item);
        this.publish({ type: "checklist.upserted", item });
      });
    }
    const session = input.firstSession ? await this.startSession({ taskId: task.id, topicId: null }, workspace, input.firstSession) : null;
    return { task: this.store.getTask(task.id)!, session };
  }

  /**
   * Renames, moves between columns, changes the project (only before the first session) or transfers the task to
   * another topic (or out of its topic): it leaves the old topic's canvas with its dependencies there, and a reference
   * card to it on the new topic's canvas becomes its own card.
   */
  updateTask(id: Id, patch: { title?: unknown; description?: unknown; lead?: unknown; relayAuto?: unknown; column?: unknown; workspaceId?: unknown; topicId?: unknown }): Task {
    const current = this.requireTask(id);
    const clean: Partial<Pick<Task, "title" | "column" | "workspaceId" | "topicId" | "description" | "lead" | "relayAuto">> = {};
    if (patch.lead !== undefined) {
      if (typeof patch.lead !== "boolean") throw new HostError("bad_request", "lead must be true or false");
      clean.lead = patch.lead;
    }
    if (patch.relayAuto !== undefined) {
      if (typeof patch.relayAuto !== "boolean") throw new HostError("bad_request", "relayAuto must be true or false");
      clean.relayAuto = patch.relayAuto;
    }
    if (patch.title !== undefined) clean.title = String(patch.title).trim();
    if (patch.description !== undefined) {
      if (current.archivedAt) throw new HostError("read_only", "archived tasks cannot be changed");
      const description = String(patch.description ?? "").trim();
      if (description.length > TASK_DESCRIPTION_MAX) throw new HostError("bad_request", `a description is limited to ${TASK_DESCRIPTION_MAX} characters`);
      clean.description = description;
    }
    if (current.archivedAt && (patch.column !== undefined || patch.workspaceId !== undefined || patch.topicId !== undefined)) throw new HostError("read_only", "archived tasks cannot be moved");
    if (patch.column !== undefined) {
      if (!TASK_COLUMNS.includes(patch.column as TaskColumn)) throw new HostError("bad_request", `unknown column ${String(patch.column)}`);
      clean.column = patch.column as TaskColumn;
    }
    if (patch.workspaceId !== undefined) {
      const workspaceId = patch.workspaceId === null || patch.workspaceId === "" ? this.commonWorkspace().id : this.requireLiveWorkspace(String(patch.workspaceId)).id;
      if (workspaceId !== current.workspaceId && this.store.listSessions({ taskId: id }).length) throw new HostError("conflict", "a task's project cannot change once it has sessions");
      clean.workspaceId = workspaceId;
    }
    if (patch.topicId !== undefined) {
      const topicId = patch.topicId === null || patch.topicId === "" ? null : this.requireLiveTopic(String(patch.topicId)).id;
      if (topicId !== current.topicId) {
        clean.topicId = topicId;
        if (current.topicId) this.f.canvases.leaveCanvas(current.topicId, id);
      }
    }
    const task = this.store.updateTask(id, clean);
    this.publish({ type: "task.upserted", task });
    // A reference card to it on its new topic's canvas becomes its own card there.
    if (clean.topicId) this.f.canvases.joinCanvas(clean.topicId, id);
    return task;
  }

  /** Archives the task with all its sessions (forks and subagents included). */
  async archiveTask(id: Id): Promise<Task> {
    const task = this.requireTask(id);
    if (task.archivedAt) return task;
    const archived = this.store.updateTask(id, { archivedAt: new Date().toISOString() });
    this.publish({ type: "task.upserted", task: archived });
    await this.archiveSessions(this.store.listSessions({ taskId: id }));
    return this.store.getTask(id)!;
  }

  /** Restores the task and the sessions that were archived with it (not the ones archived earlier on their own). */
  async unarchiveTask(id: Id): Promise<Task> {
    const task = this.requireTask(id);
    if (!task.archivedAt) return task;
    if (task.topicId && this.store.getTopic(task.topicId)?.archivedAt) throw new HostError("conflict", "its topic is archived; restore the topic or move the task out of it first");
    const since = task.archivedAt;
    const restored = this.store.updateTask(id, { archivedAt: null });
    this.publish({ type: "task.upserted", task: restored });
    await this.unarchiveSessions(this.store.listSessions({ taskId: id }), since);
    return this.store.getTask(id)!;
  }

  async addSession(taskId: Id, input: NewSessionInput): Promise<Session> {
    const task = this.requireTask(taskId);
    if (task.archivedAt) throw new HostError("read_only", "archived tasks cannot get new sessions");
    if (input.workspaceId && input.workspaceId !== task.workspaceId) throw new HostError("bad_request", "a task's sessions run in the task's own workspace");
    this.requireProfile(input.profileId);
    return this.startSession({ taskId: task.id, topicId: null }, this.requireWorkspace(task.workspaceId), input);
  }

  /** What nothing was chosen for, from 设置 → 模型 (the CLI's own defaults when the person set none). */
  private async withDefaults(profileId: Id, options: SessionOptions): Promise<SessionOptions> {
    const prefs = readModelPrefs(this.store)[profileId];
    if (!prefs || (options.model && options.effort && options.permission)) return options;
    try {
      return fillDefaults(options, await this.f.config.choices(profileId), prefs);
    } catch {
      // Without the list the choice cannot be checked; the CLI's defaults apply.
      return options;
    }
  }

  async archiveSessions(sessions: readonly Session[]): Promise<void> {
    // Archiving a root takes its forks and subagents with it.
    for (const s of sessions.filter((x) => !x.parentId && !x.archivedAt)) await this.wrap(() => this.runtime.archive(s.id));
  }

  /** Restores the sessions archived at or after `since` (by the cascade), root by root. */
  async unarchiveSessions(sessions: readonly Session[], since: string): Promise<void> {
    for (const s of sessions.filter((x) => !x.parentId && x.archivedAt && x.archivedAt >= since)) await this.wrap(() => this.runtime.unarchive(s.id));
  }

  async startSession(owner: { taskId: Id | null; topicId: Id | null }, workspace: Workspace, input: NewSessionInput): Promise<Session> {
    const options = await this.withDefaults(input.profileId, sessionOptions(input.options));
    const session = await this.wrap(() => this.runtime.startSession({ ...owner, profileId: input.profileId, workspace, ...(input.text ? { text: input.text } : {}), options }));
    // The owner's updatedAt moves with its sessions so the board can sort by activity.
    if (owner.taskId) this.publish({ type: "task.upserted", task: this.store.updateTask(owner.taskId, {}) });
    else if (owner.topicId) this.publish({ type: "topic.upserted", topic: this.store.updateTopic(owner.topicId, {}) });
    return session;
  }
}
