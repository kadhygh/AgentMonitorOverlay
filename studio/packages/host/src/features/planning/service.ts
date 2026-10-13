import type { Id, TodoItem, Session, Task, ScheduleProposal } from "@amo-studio/protocol";
import { workspacesActivity, isCommon } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { schedulerBrief } from "../../scheduler/brief.js";
import { HostError, boundedText, MAX_NOTE_CHARS, MAX_QUESTION_CHARS, PROPOSALS_PER_ROUND, SCHEDULER_TASK_KEY } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Whole-picture todos, the scheduler and its proposals (stage 7). */
export class PlanningFeature extends Feature {
  /** Todos being turned into tasks right now. */
  private readonly converting = new Set<Id>();

  todos(): TodoItem[] {
    return this.store.listTodos();
  }

  addTodo(input: { text?: unknown; workspaceId?: unknown }): TodoItem {
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!text) throw new HostError("bad_request", "text is required");
    const todo: TodoItem = { id: newId("td"), text, done: false, workspaceId: this.optionalWorkspace(input.workspaceId), taskId: null, createdAt: new Date().toISOString() };
    this.store.putTodo(todo);
    this.publish({ type: "todo.upserted", todo });
    return todo;
  }

  updateTodo(id: Id, patch: { text?: unknown; done?: unknown; workspaceId?: unknown }): TodoItem {
    const current = this.store.getTodo(id);
    if (!current) throw new HostError("not_found", `todo ${id} not found`);
    const next: TodoItem = { ...current };
    if (patch.text !== undefined) {
      const text = typeof patch.text === "string" ? patch.text.trim() : "";
      if (!text) throw new HostError("bad_request", "text is required");
      next.text = text;
    }
    if (patch.done !== undefined) next.done = patch.done === true;
    if (patch.workspaceId !== undefined) next.workspaceId = this.optionalWorkspace(patch.workspaceId);
    this.store.putTodo(next);
    this.publish({ type: "todo.upserted", todo: next });
    if (next.done) this.expireProposals(id);
    return next;
  }

  /**
   * Turns a todo into a task in its workspace (or the one given; the common space when neither), with one session and
   * no first message (no model call). Converted on a topic's canvas, the task joins that topic and is placed on it, in
   * the group bound to its workspace if there is one (else ungrouped). The todo is done and points at it.
   */
  async convertTodo(id: Id, input: { workspaceId?: unknown; profileId?: unknown; text?: unknown; topicId?: unknown }): Promise<{ todo: TodoItem; task: Task; session: Session }> {
    const todo = this.store.getTodo(id);
    if (!todo) throw new HostError("not_found", `todo ${id} not found`);
    if (todo.taskId) throw new HostError("conflict", "this todo is already a task");
    const workspaceId = this.optionalWorkspace(input?.workspaceId) ?? todo.workspaceId ?? this.commonWorkspace().id;
    if (typeof input?.profileId !== "string") throw new HostError("bad_request", "profileId is required");
    const topicId = typeof input.topicId === "string" && input.topicId ? this.requireLiveTopic(input.topicId).id : null;
    // Starting the session awaits the runtime; a second convert (or approval) meanwhile must not make a second task.
    if (this.converting.has(id)) throw new HostError("conflict", "this todo is being turned into a task");
    this.converting.add(id);
    try {
      return await this.convertTodoNow(todo, workspaceId, input.profileId, input.text, topicId);
    } finally {
      this.converting.delete(id);
    }
  }

  private async convertTodoNow(todo: TodoItem, workspaceId: Id, profileId: string, textIn: unknown, topicId: Id | null = null): Promise<{ todo: TodoItem; task: Task; session: Session }> {
    const text = typeof textIn === "string" && textIn.trim() ? textIn.trim() : undefined;
    const { task, session } = await this.f.tasks.createTask({
      title: todo.text.slice(0, 100),
      workspaceId,
      topicId,
      firstSession: { profileId, ...(text ? { text } : {}) },
    });
    // Created on the canvas: always shown there.
    const group = topicId ? this.f.canvases.canvas(topicId).groups.find((g) => g.workspaceId === workspaceId) : undefined;
    if (topicId) this.f.canvases.canvasPlaceTask(task.id, group?.id ?? null);
    const next: TodoItem = { ...todo, workspaceId, taskId: task.id, done: true };
    this.store.putTodo(next);
    this.publish({ type: "todo.upserted", todo: next });
    return { todo: next, task, session: session! };
  }

  proposals(filter: { state?: ScheduleProposal["state"] } = {}): ScheduleProposal[] {
    return this.store.listProposals(filter);
  }

  propose(input: { todoId?: unknown; workspaceId?: unknown; profileId?: unknown; prompt?: unknown; reason?: unknown }, sessionId: Id | null = null): ScheduleProposal {
    const todo = typeof input?.todoId === "string" ? this.store.getTodo(input.todoId) : undefined;
    if (!todo) throw new HostError("not_found", `todo ${String(input?.todoId)} not found`);
    if (todo.done || todo.taskId) throw new HostError("conflict", "this todo is already done or a task");
    if (this.store.listProposals({ state: "pending", todoId: todo.id }).length) throw new HostError("conflict", "this todo already has a pending proposal");
    if (sessionId && this.store.listProposals().filter((p) => p.sessionId === sessionId).length >= PROPOSALS_PER_ROUND) {
      throw new HostError("bad_request", `at most ${PROPOSALS_PER_ROUND} proposals per scheduler round`);
    }
    const workspaceId = this.optionalWorkspace(input.workspaceId) ?? todo.workspaceId;
    if (!workspaceId) throw new HostError("bad_request", "workspaceId is required for a todo without one");
    if (typeof input.profileId !== "string") throw new HostError("bad_request", "profileId is required");
    this.requireProfile(input.profileId);
    const prompt = boundedText(input.prompt, "prompt", MAX_NOTE_CHARS);
    const reason = input.reason === undefined || input.reason === "" ? "" : boundedText(input.reason, "reason", MAX_QUESTION_CHARS);
    const p: ScheduleProposal = { id: newId("prop"), todoId: todo.id, workspaceId, profileId: input.profileId, prompt, reason, state: "pending", sessionId, taskId: null, createdAt: new Date().toISOString(), decidedAt: null };
    this.store.putProposal(p);
    this.publish({ type: "proposal.upserted", proposal: p });
    return p;
  }

  /** The fixed cross-workspace task the scheduler's sessions live in (made on first use). */
  schedulerTask(): Task {
    const id = this.store.getKv(SCHEDULER_TASK_KEY)?.value;
    const existing = id ? this.store.getTask(id) : undefined;
    if (existing) return existing;
    const task = this.store.createTask({ title: "调度", workspaceId: this.commonWorkspace().id, column: "doing" });
    this.store.setKv(SCHEDULER_TASK_KEY, task.id);
    this.publish({ type: "task.upserted", task });
    return task;
  }

  isSchedulerSession(sessionId: Id): boolean {
    const id = this.store.getKv(SCHEDULER_TASK_KEY)?.value;
    return !!id && this.store.getSession(sessionId)?.taskId === id;
  }

  /**
   * One scheduler round, started by the person: a new session in the scheduler task whose first message is the brief
   * (open todos, which projects are free, models, presets, rules). It can only propose; the person approves.
   */
  async runScheduler(input: { profileId?: unknown } = {}): Promise<{ task: Task; session: Session }> {
    if (typeof input?.profileId !== "string") throw new HostError("bad_request", "profileId is required");
    this.requireProfile(input.profileId);
    const workspaces = this.store.listWorkspaces().filter((w) => !isCommon(w));
    // The scheduler runs in the common space: it only reads Studio through the MCP and is told not to touch files.
    const task = this.schedulerTask();
    const text = schedulerBrief({
      todos: this.store.listTodos(),
      workspaces,
      activity: workspacesActivity(workspaces, this.store.listSessions()),
      profiles: this.profiles,
      packs: workspaces.flatMap((w) => this.f.extensions.packs(w.id).map((p) => ({ ...p, workspaceId: w.id }))),
      perRound: PROPOSALS_PER_ROUND,
    });
    const session = await this.f.tasks.addSession(task.id, { profileId: input.profileId, text });
    return { task: this.store.getTask(task.id)!, session };
  }

  /** Approves a proposal, with the person's edits: the todo becomes a task and its first session starts with the prompt. */
  async approveProposal(id: Id, edits: { prompt?: unknown; profileId?: unknown } = {}): Promise<{ proposal: ScheduleProposal; task: Task; session: Session }> {
    const p = this.pendingProposal(id);
    const prompt = edits.prompt === undefined ? p.prompt : boundedText(edits.prompt, "prompt", MAX_NOTE_CHARS);
    const profileId = typeof edits.profileId === "string" ? this.requireProfile(edits.profileId).id : p.profileId;
    const todo = this.store.getTodo(p.todoId);
    if (!todo || todo.done || todo.taskId) {
      this.decideProposal(p, "expired");
      throw new HostError("conflict", "the todo is gone or already handled; the proposal expired");
    }
    const { task, session } = await this.convertTodo(todo.id, { workspaceId: p.workspaceId, profileId, text: prompt });
    const proposal = this.decideProposal({ ...p, prompt, profileId, taskId: task.id }, "approved");
    return { proposal, task, session };
  }

  rejectProposal(id: Id): ScheduleProposal {
    return this.decideProposal(this.pendingProposal(id), "rejected");
  }

  private pendingProposal(id: Id): ScheduleProposal {
    const p = this.store.getProposal(id);
    if (!p) throw new HostError("not_found", `proposal ${id} not found`);
    if (p.state !== "pending") throw new HostError("conflict", `this proposal is already ${p.state}`);
    return p;
  }

  private decideProposal(p: ScheduleProposal, state: ScheduleProposal["state"]): ScheduleProposal {
    const next: ScheduleProposal = { ...p, state, decidedAt: new Date().toISOString() };
    this.store.putProposal(next);
    this.publish({ type: "proposal.upserted", proposal: next });
    return next;
  }

  private expireProposals(todoId: Id): void {
    for (const p of this.store.listProposals({ state: "pending", todoId })) this.decideProposal(p, "expired");
  }

  deleteTodo(id: Id): void {
    if (!this.store.getTodo(id)) throw new HostError("not_found", `todo ${id} not found`);
    this.store.deleteTodo(id);
    this.publish({ type: "todo.removed", todoId: id });
    this.expireProposals(id);
  }
}
