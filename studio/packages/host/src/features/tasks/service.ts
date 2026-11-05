import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CanvasDoc, Id, NewSessionInput, OutsideSessionList, OutsideSessionPreview, Session, SessionOptions, Task, TaskColumn, Workspace } from "@amo-studio/protocol";
import { inTurn, isCommon, MAIN_CANVAS_ID, removeTask, TASK_COLUMNS, TASK_DESCRIPTION_MAX, TASK_FIRST_MESSAGE_MAX } from "@amo-studio/protocol";
import { HostError, sessionOptions, sessionMoving, LEGACY_COMMON_WORKSPACE_KEY, COMMON_NAME, SCHEDULER_TASK_KEY } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { fillDefaults, readModelPrefs } from "../../core/model-prefs.js";
import { checkSetups } from "../sessions/setups.js";

/** Tasks: creating, renaming, moving, archiving, their sessions; bringing older data into structure v2. */
export class TasksFeature extends Feature<"canvases" | "config" | "mcp" | "remote" | "sessions"> {
  /** How long a task's sessions must all have stood still before it moves to 待审阅 (a turn often follows another at once). */
  reviewSettleMs = 4000;
  private readonly movingBefore = new Map<Id, boolean>();
  private readonly settling = new Map<Id, NodeJS.Timeout>();

  /**
   * 进行中 ⇄ 待审阅 by the sessions (2026-10-26, the person asked for it; Studio moves the card, never an agent): when a
   * session of a 进行中 task stops moving and none of the task's sessions moves any more, the task goes to 待审阅; when a
   * session of a 待审阅 task starts moving again (the person talks to it), the task goes back to 进行中. Only a session
   * starting or stopping counts, so a card the person moved stays where it is until then; 待办 and 完成 are never
   * touched, nor the scheduler's task.
   */
  watchColumns(): void {
    for (const s of this.store.listSessions()) this.movingBefore.set(s.id, sessionMoving(s));
    this.host.on("event", (e) => {
      if (e.type !== "session.upserted") return;
      const s = e.session;
      const moving = sessionMoving(s);
      const before = this.movingBefore.get(s.id) ?? false;
      this.movingBefore.set(s.id, moving);
      if (moving === before || !s.taskId) return;
      if (moving) this.sessionStarted(s.taskId);
      else this.sessionStopped(s.taskId);
    });
  }

  private sessionStarted(taskId: Id): void {
    clearTimeout(this.settling.get(taskId));
    this.settling.delete(taskId);
    if (this.followsSessions(taskId, "review")) this.updateTask(taskId, { column: "doing" });
  }

  private sessionStopped(taskId: Id): void {
    clearTimeout(this.settling.get(taskId));
    const timer = setTimeout(() => {
      this.settling.delete(taskId);
      try {
        if (!this.followsSessions(taskId, "doing")) return;
        if (this.store.listSessions({ taskId }).some(sessionMoving)) return;
        this.updateTask(taskId, { column: "review" });
      } catch {
        // The Host is closing (its database already is).
      }
    }, this.reviewSettleMs);
    timer.unref?.();
    this.settling.set(taskId, timer);
  }

  /** Whether the task is live, in `column`, and not the scheduler's own task (which always stays 进行中). */
  private followsSessions(taskId: Id, column: TaskColumn): boolean {
    const task = this.store.getTask(taskId);
    // A copy of a remote task (远程 step 2) has the column its own computer gives it.
    return !!task && !task.archivedAt && !task.remote && task.column === column && this.store.getKv(SCHEDULER_TASK_KEY)?.value !== taskId;
  }

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
    /** Filed without a session: the sentence its first session will take (2026-11-05). */
    firstMessage?: string;
  }): Promise<{ task: Task; session: Session | null }> {
    const workspace = input.workspaceId ? this.requireLiveWorkspace(input.workspaceId) : this.commonWorkspace();
    const topic = input.topicId ? this.requireLiveTopic(input.topicId) : null;
    if (input.firstSession) {
      this.requireProfile(input.firstSession.profileId);
      if (input.firstSession.workspaceId && input.firstSession.workspaceId !== workspace.id) throw new HostError("bad_request", "a task's sessions run in the task's own workspace");
      this.firstImages(input.firstSession);
      const resumeFrom = this.resumeFrom(input.firstSession);
      // 接续已有会话: refused before the task is made (the session is gone, already taken on, not the subscription).
      if (resumeFrom) await this.wrap(() => this.runtime.checkResume?.(input.firstSession!.profileId, resumeFrom) ?? Promise.resolve());
    }
    // 子会话设定 named in the first message (2026-11-05: @ 开子会话… on the new-task page), checked before the task is made.
    const setups = checkSetups(input.firstSession?.subsessions);
    for (const s of setups) this.requireProfile(s.profileId);
    if (input.column !== undefined && !TASK_COLUMNS.includes(input.column)) throw new HostError("bad_request", `unknown column ${String(input.column)}`);
    const firstMessage = input.firstSession ? "" : firstMessageOf(input.firstMessage);
    const title = input.title?.trim() || input.firstSession?.text?.trim().slice(0, 60) || firstMessage.split("\n")[0]!.slice(0, 60);
    const column = input.firstSession ? "doing" : (input.column ?? "todo");
    const task = this.store.createTask({ title, workspaceId: workspace.id, topicId: topic?.id ?? null, column, lead: input.lead === true, ...(firstMessage ? { firstMessage } : {}) });
    this.publish({ type: "task.upserted", task });
    const { subsessions: _setups, ...first } = input.firstSession ?? { profileId: "" };
    const session = input.firstSession ? await this.startSession({ taskId: task.id, topicId: null }, workspace, first) : null;
    if (session && setups.length) this.f.sessions.rememberSetups(session.id, setups);
    return { task: this.store.getTask(task.id)!, session };
  }

  /**
   * Renames, moves between columns, changes the project (only before the first session) or transfers the task to
   * another topic (or out of its topic): it leaves the old topic's canvas with its dependencies there, and a reference
   * card to it on the new topic's canvas becomes its own card.
   */
  /** PATCH /api/tasks/:id: a remote task's copy takes a new name, renamed on its own computer (2026-10-30). */
  patchTask(id: Id, patch: Parameters<TasksFeature["updateTask"]>[1]): Task | Promise<Task> {
    const current = this.requireTask(id);
    const onlyTitle = patch.title !== undefined && Object.entries(patch).every(([k, v]) => k === "title" || v === undefined);
    if (current.remote && onlyTitle) {
      const title = String(patch.title).trim();
      if (!title) throw new HostError("bad_request", "title must not be empty");
      return this.f.remote.renameCopy(current, title.slice(0, 200));
    }
    return this.updateTask(id, patch);
  }

  updateTask(id: Id, patch: { title?: unknown; description?: unknown; firstMessage?: unknown; lead?: unknown; relayAuto?: unknown; column?: unknown; workspaceId?: unknown; topicId?: unknown }): Task {
    const current = this.requireTask(id);
    if (current.remote) throw new HostError("read_only", `这是 ${current.remote.name} 上的远程任务：状态、说明和专题跟着那台电脑走，这里不能改（名字可以改，会改到那边）`);
    const clean: Partial<Pick<Task, "title" | "column" | "workspaceId" | "topicId" | "description" | "firstMessage" | "lead" | "relayAuto">> = {};
    // The first session took it into its composer, or the person cleared it ("").
    if (patch.firstMessage !== undefined) clean.firstMessage = firstMessageOf(patch.firstMessage);
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
    // A copy of a remote task (远程 step 2): it goes from this computer, the task stays where it runs.
    if (task.remote) {
      this.f.remote.dropCopy(task);
      return { ...task, archivedAt: new Date().toISOString() };
    }
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
    // A copy of a remote task (远程 step 2): the session starts where the task runs, on a model allowed there.
    if (task.remote) return this.f.remote.startCopySession(task, input);
    if (input.workspaceId && input.workspaceId !== task.workspaceId) throw new HostError("bad_request", "a task's sessions run in the task's own workspace");
    this.requireProfile(input.profileId);
    this.firstImages(input);
    return this.startSession({ taskId: task.id, topicId: null }, this.requireWorkspace(task.workspaceId), input);
  }

  /** The images the first message carries, checked before anything is created; DSH sessions take none. */
  private firstImages(input: NewSessionInput): Id[] {
    if (input.attachments === undefined) return [];
    const ids = this.f.sessions.images(input.attachments).map((a) => a.id);
    return ids;
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
    // MCP 设置 (2026-11-04): no level of its own for a task; a new session goes on with the task's latest choices.
    if (!options.mcp) {
      const inherited = this.f.mcp.inherited(owner.taskId);
      if (inherited) options.mcp = inherited;
    }
    const images = this.firstImages(input);
    // A first message with images goes as an ordinary message once the session exists (the runtimes start with text only).
    const resumeFrom = this.resumeFrom(input);
    const session = await this.wrap(() => this.runtime.startSession({ ...owner, profileId: input.profileId, workspace, ...(input.text && !images.length ? { text: input.text } : {}), options, ...(resumeFrom ? { resumeFrom } : {}) }));
    if (images.length) await this.f.sessions.sendMessage(session.id, input.text ?? "", images);
    // The owner's updatedAt moves with its sessions so the board can sort by activity.
    if (owner.taskId) this.publish({ type: "task.upserted", task: this.store.updateTask(owner.taskId, {}) });
    else if (owner.topicId) this.publish({ type: "topic.upserted", topic: this.store.updateTopic(owner.topicId, {}) });
    return session;
  }

  /** 接续已有会话 (2026-11-05): Claude sessions started outside Studio that a new task can go on from. */
  outsideSessions(): Promise<OutsideSessionList> {
    return this.wrap(() => this.runtime.outsideSessions?.() ?? Promise.resolve({ sessions: [], unavailable: "这个 Studio 没有 Claude" }));
  }

  async outsidePreview(ref: string): Promise<OutsideSessionPreview> {
    const preview = await this.wrap(() => this.runtime.outsidePreview?.(ref) ?? Promise.resolve(null));
    if (!preview) throw new HostError("not_found", "找不到这个会话的对话记录");
    return preview;
  }

  /** 接续已有会话 (2026-11-05): the outside Claude session a new one goes on from, checked; undefined when none. */
  private resumeFrom(input: NewSessionInput): string | undefined {
    if (input.resumeFrom === undefined || input.resumeFrom === null) return undefined;
    if (typeof input.resumeFrom !== "string" || !/^[0-9a-f-]{36}$/i.test(input.resumeFrom)) throw new HostError("bad_request", "resumeFrom must be a Claude session id");
    if (this.requireProfile(input.profileId).runtime !== "claude") throw new HostError("bad_request", "接续已有会话只能用 Claude");
    return input.resumeFrom;
  }
}

/** A filed task's first sentence, checked: text, at most TASK_FIRST_MESSAGE_MAX; "" when none. */
function firstMessageOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HostError("bad_request", "firstMessage must be text");
  const text = v.trim();
  if (text.length > TASK_FIRST_MESSAGE_MAX) throw new HostError("bad_request", `a first message is limited to ${TASK_FIRST_MESSAGE_MAX} characters`);
  return text;
}
