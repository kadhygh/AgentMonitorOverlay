import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  Annotation,
  CanvasDoc,
  ApprovalDecision,
  HostErrorCode,
  HostEvent,
  Id,
  ModelProfile,
  NewAnnotationInput,
  NewSessionInput,
  Scratchpad,
  TodoItem,
  TaskNote,
  MailMessage,
  MailRecipient,
  DecisionRequest,
  Session,
  SessionItem,
  StateSnapshot,
  Task,
  TerminalAttach,
  TaskColumn,
  TaskScope,
  Workspace,
  WorkspacePack,
  PackDocContent,
  ChecklistItem,
  TaskTemplateChoice,
  PackTemplate,
  PresetDraft,
  ScheduleProposal,
} from "@amo-studio/protocol";
import { PACKS_DIR, workspacesActivity, addDependency, addGroupAuto, CanvasLayoutError, canvasOutline, composeAnnotationMessage, emptyCanvas, MAIN_CANVAS_ID, placeTask, TASK_COLUMNS, validateCanvas } from "@amo-studio/protocol";
import { newId, type HostEventInput, type Store } from "./store/store.js";
import type { SendMode, SessionRuntimeApi } from "./runtime/runtime.js";
import type { TerminalHandle, TerminalLauncher } from "./terminal/launcher.js";
import { PackError, PackLoader } from "./packs/pack-loader.js";
import { presetDraft } from "./packs/presets.js";
import { schedulerBrief } from "./scheduler/brief.js";

/** Env var that carries the app-server token into an attached terminal; never put the token itself on a command line. */
export const TERMINAL_TOKEN_ENV = "AMO_STUDIO_CODEX_TOKEN";

const SCRATCHPAD_KEY = "scratchpad";

// Application layer behind the Host API. HTTP handlers stay thin and call into this.

export class HostError extends Error {
  constructor(readonly code: HostErrorCode, message: string) {
    super(message);
    this.name = "HostError";
  }
}

export interface HostServiceEvents {
  event: [HostEvent];
}

// Agents write notes, mail and questions through the AMO MCP; a runaway turn must not fill the store or the Focus
// window, so these texts are bounded (a handoff summary fits easily).
const MAX_NOTE_CHARS = 8000;
const MAX_QUESTION_CHARS = 2000;
const MAX_OPTION_CHARS = 200;
/** Proposals one scheduler session (one round) may make (design/scheduler.md). */
export const PROPOSALS_PER_ROUND = 3;
const SCHEDULER_TASK_KEY = "scheduler:task";

function boundedText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HostError("bad_request", `${field} is required`);
  if (text.length > max) throw new HostError("bad_request", `${field} is too long (${text.length} characters; at most ${max})`);
  return text;
}

export class HostService extends EventEmitter<HostServiceEvents> {
  /** Terminals that hold a Claude session (handoff); closing one gives the session back. */
  private readonly handoffs = new Map<Id, TerminalHandle>();
  /** One reclaim at a time per session, or the terminal's additions would be imported twice. */
  private readonly reclaiming = new Map<Id, Promise<Session>>();
  private readonly packLoader = new PackLoader();

  constructor(
    readonly store: Store,
    readonly runtime: SessionRuntimeApi,
    readonly profiles: readonly ModelProfile[],
    private readonly options: { launcher?: TerminalLauncher } = {},
  ) {
    super();
    runtime.on("event", (e) => this.emit("event", e));
  }

  snapshot(): StateSnapshot {
    return {
      workspaces: this.store.listWorkspaces(),
      tasks: this.store.listTasks(),
      sessions: this.store.listSessions(),
      profiles: [...this.profiles],
      eventSeq: this.store.lastEventSeq(),
    };
  }

  // Workspaces

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
    if (!this.store.getWorkspace(id)) throw new HostError("not_found", `workspace ${id} not found`);
    try {
      this.store.removeWorkspace(id);
    } catch (err) {
      throw new HostError("conflict", (err as Error).message);
    }
    this.publish({ type: "workspace.removed", workspaceId: id });
    // Todos and canvas groups only point at a workspace as a hint; drop the hint rather than leave it dangling.
    for (const todo of this.store.listTodos().filter((t) => t.workspaceId === id)) {
      const next = { ...todo, workspaceId: null };
      this.store.putTodo(next);
      this.publish({ type: "todo.upserted", todo: next });
    }
    const canvas = this.canvas();
    if (canvas.groups.some((g) => g.workspaceId === id)) {
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

  // Tasks

  async createTask(input: { title?: string; scope: TaskScope; firstSession: NewSessionInput; template?: TaskTemplateChoice }): Promise<{ task: Task; session: Session }> {
    const scope = this.validScope(input.scope);
    const workspace = this.sessionWorkspace(scope, input.firstSession.workspaceId);
    this.requireProfile(input.firstSession.profileId);
    const template = input.template ? this.packTemplate(scope, input.template) : null;
    const base = input.title?.trim() || input.firstSession.text?.trim().slice(0, 60) || template?.title || "";
    const title = template?.titlePrefix && !base.startsWith(template.titlePrefix.trim()) ? `${template.titlePrefix}${base}` : base;
    const task = this.store.createTask({ title, scope, column: "doing" });
    this.publish({ type: "task.upserted", task });
    if (template && input.template) {
      template.steps.forEach((text, position) => {
        const item: ChecklistItem = { id: newId("chk"), taskId: task.id, position, text, done: false, doneBySessionId: null, doneAt: null, source: `${input.template!.pack}/${template.id}` };
        this.store.putChecklistItem(item);
        this.publish({ type: "checklist.upserted", item });
      });
    }
    const session = await this.startSession(task, workspace, input.firstSession);
    return { task: this.store.getTask(task.id)!, session };
  }

  updateTask(id: Id, patch: { title?: string; column?: TaskColumn }): Task {
    this.requireTask(id);
    if (patch.column !== undefined && !TASK_COLUMNS.includes(patch.column)) throw new HostError("bad_request", `unknown column ${String(patch.column)}`);
    const clean: { title?: string; column?: TaskColumn } = {};
    if (patch.title !== undefined) clean.title = String(patch.title).trim();
    if (patch.column !== undefined) clean.column = patch.column;
    const task = this.store.updateTask(id, clean);
    this.publish({ type: "task.upserted", task });
    return task;
  }

  async addSession(taskId: Id, input: NewSessionInput): Promise<Session> {
    const task = this.requireTask(taskId);
    const workspace = this.sessionWorkspace(task.scope, input.workspaceId);
    this.requireProfile(input.profileId);
    return this.startSession(task, workspace, input);
  }

  // Sessions

  items(sessionId: Id, afterSeq = 0): SessionItem[] {
    this.requireSession(sessionId);
    return this.store.listItems(sessionId, afterSeq);
  }

  async sendMessage(sessionId: Id, text: string): Promise<{ mode: SendMode }> {
    this.requireSession(sessionId);
    if (!text?.trim()) throw new HostError("bad_request", "text is required");
    return this.wrap(() => this.runtime.sendMessage(sessionId, text));
  }

  async interrupt(sessionId: Id): Promise<void> {
    this.requireSession(sessionId);
    await this.wrap(() => this.runtime.interrupt(sessionId));
  }

  async fork(sessionId: Id, profileId?: Id): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be forked");
    if (profileId) this.requireProfile(profileId);
    return this.wrap(() => this.runtime.fork(sessionId, profileId));
  }

  async archive(sessionId: Id): Promise<Session[]> {
    this.requireSession(sessionId);
    return this.wrap(() => this.runtime.archive(sessionId));
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    this.requireSession(sessionId);
    return this.wrap(() => this.runtime.unarchive(sessionId));
  }

  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.requireSession(sessionId);
    if (decision !== "accept" && decision !== "decline") throw new HostError("bad_request", `unknown decision ${String(decision)}`);
    await this.wrap(() => this.runtime.respondApproval(sessionId, approvalId, decision), "conflict");
  }

  /**
   * Codex: opens the real TUI on the same app-server (`codex --remote … resume`). Both sides keep writing, so the
   * session becomes "terminal-shared". With `launch: false` only the command is returned (tests, copy to clipboard).
   */
  async terminal(sessionId: Id, launch: boolean): Promise<TerminalAttach> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be opened in a terminal");
    if (s.runtime === "claude") return this.handToTerminal(s, launch);
    const info = await this.wrap(() => this.runtime.attachInfo(sessionId));
    const command = `codex --remote ${info.url} --remote-auth-token-env ${TERMINAL_TOKEN_ENV} resume ${info.threadId}`;
    if (launch) {
      if (!this.options.launcher) throw new HostError("bad_request", "no terminal launcher configured");
      const ws = this.store.getWorkspace(s.workspaceId);
      this.options.launcher.launch({
        command,
        cwd: ws?.path ?? process.cwd(),
        env: { [TERMINAL_TOKEN_ENV]: info.token },
        title: `AMO Studio · ${s.title || "会话"}`,
      });
      this.runtime.setWriter(sessionId, "terminal-shared");
    }
    return { command, envVar: TERMINAL_TOKEN_ENV, launched: launch };
  }

  /**
   * Claude: `claude --resume` in a terminal holds the session alone (two writers would lose turns), so Studio turns
   * read-only and takes the session back when the terminal closes — or at once with "立即收回", which closes it.
   */
  private async handToTerminal(s: Session, launch: boolean): Promise<TerminalAttach> {
    if (!launch) throw new HostError("bad_request", "a Claude session can only be handed to a terminal directly");
    if (s.kind === "sub") throw new HostError("read_only", "a Claude subagent cannot be opened in a terminal");
    const launcher = this.options.launcher;
    if (!launcher) throw new HostError("bad_request", "no terminal launcher configured");
    if (!this.runtime.handoff) throw new HostError("bad_request", "this Host cannot hand Claude sessions to a terminal");
    const plan = await this.wrap(() => this.runtime.handoff!(s.id), "conflict");
    let handle: TerminalHandle | undefined;
    try {
      // The complete environment: nothing Claude-related from the Host's own environment leaks into the terminal.
      handle = launcher.launch({ command: plan.command, cwd: plan.cwd, env: plan.env, envMode: "replace", track: true, title: `AMO Studio · ${s.title || "Claude 会话"}` });
    } catch (err) {
      await this.reclaim(s.id).catch(() => undefined);
      throw err;
    }
    if (handle) {
      this.handoffs.set(s.id, handle);
      handle.onExit(() => {
        if (this.handoffs.get(s.id) !== handle) return;
        this.handoffs.delete(s.id);
        void this.reclaim(s.id).catch(() => undefined);
      });
    }
    return { command: plan.command, envVar: null, launched: true };
  }

  /**
   * Back to workbench-only writing: after closing a Codex TUI, or taking a Claude handoff back (closing its terminal
   * if it is still open, then importing what it added).
   */
  async reclaim(sessionId: Id): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be reclaimed");
    const pending = this.reclaiming.get(sessionId);
    if (pending) return pending;
    const run = (async () => {
      const handle = this.handoffs.get(sessionId);
      if (handle?.running) {
        this.handoffs.delete(sessionId);
        const exited = new Promise<void>((r) => handle.onExit(r));
        handle.kill();
        // The terminal's Claude process must be gone before Studio starts its own for the same session id.
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      }
      return this.wrap(() => (this.runtime.reclaim ? this.runtime.reclaim(sessionId) : Promise.resolve(this.runtime.setWriter(sessionId, "workbench"))));
    })();
    this.reclaiming.set(sessionId, run);
    try {
      return await run;
    } finally {
      this.reclaiming.delete(sessionId);
    }
  }

  // Whole-picture todos

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
   * Turns a todo into a task in its workspace (or the one given), with one session and no first message (no model
   * call). The task goes into the canvas group bound to that workspace, if any; the todo is done and points at it.
   */
  async convertTodo(id: Id, input: { workspaceId?: unknown; profileId?: unknown; text?: unknown }): Promise<{ todo: TodoItem; task: Task; session: Session }> {
    const todo = this.store.getTodo(id);
    if (!todo) throw new HostError("not_found", `todo ${id} not found`);
    if (todo.taskId) throw new HostError("conflict", "this todo is already a task");
    const workspaceId = this.optionalWorkspace(input?.workspaceId) ?? todo.workspaceId;
    if (!workspaceId) throw new HostError("bad_request", "choose a workspace for the task");
    if (typeof input?.profileId !== "string") throw new HostError("bad_request", "profileId is required");
    const text = typeof input.text === "string" && input.text.trim() ? input.text.trim() : undefined;
    const { task, session } = await this.createTask({
      title: todo.text.slice(0, 100),
      scope: { kind: "workspace", workspaceId },
      firstSession: { profileId: input.profileId, ...(text ? { text } : {}) },
    });
    const group = this.canvas().groups.find((g) => g.workspaceId === workspaceId);
    if (group) this.canvasPlaceTask(task.id, group.id);
    const next: TodoItem = { ...todo, workspaceId, taskId: task.id, done: true };
    this.store.putTodo(next);
    this.publish({ type: "todo.upserted", todo: next });
    return { todo: next, task, session };
  }

  // Scheduler proposals (stage 7, design/scheduler.md): proposed by the scheduler session (or through the API), started
  // only when the person approves.

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
    const task = this.store.createTask({ title: "调度", scope: { kind: "area" }, column: "doing" });
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
    const workspaces = this.store.listWorkspaces();
    // A session needs a working directory; the scheduler only reads Studio through the MCP and is told not to touch
    // files, so the first registered workspace serves.
    if (!workspaces.length) throw new HostError("bad_request", "register a workspace first");
    const task = this.schedulerTask();
    const text = schedulerBrief({
      todos: this.store.listTodos(),
      workspaces,
      activity: workspacesActivity(workspaces, this.store.listSessions()),
      profiles: this.profiles,
      packs: workspaces.flatMap((w) => this.packs(w.id).map((p) => ({ ...p, workspaceId: w.id }))),
      perRound: PROPOSALS_PER_ROUND,
    });
    const session = await this.addSession(task.id, { profileId: input.profileId, workspaceId: workspaces[0]!.id, text });
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

  private optionalWorkspace(value: unknown): Id | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !this.store.getWorkspace(value)) throw new HostError("bad_request", `workspace ${String(value)} not found`);
    return value;
  }

  // Collaboration (stage 5). The `from…`/`…FromSession` methods are what the AMO MCP calls for the session behind a
  // tool call; the others serve the workbench.

  taskNotes(taskId: Id): TaskNote[] {
    this.requireTask(taskId);
    return this.store.listTaskNotes(taskId);
  }

  /** A note on a task, by the person (`sessionId` null) or by a session of that task. */
  addTaskNote(taskId: Id, input: { text?: unknown; kind?: TaskNote["kind"] }, sessionId: Id | null = null): TaskNote {
    this.requireTask(taskId);
    const text = boundedText(input?.text, "text", MAX_NOTE_CHARS);
    if (sessionId && this.requireSession(sessionId).taskId !== taskId) throw new HostError("bad_request", "a session can only write to its own task");
    const note: TaskNote = { id: newId("note"), taskId, sessionId, kind: input.kind === "handoff" ? "handoff" : "progress", text, createdAt: new Date().toISOString() };
    this.store.addTaskNote(note);
    this.publish({ type: "task.note.added", note });
    return note;
  }

  /** Mail by recipient; `forTaskId`: everything left for that task or for any of its sessions. */
  mail(filter: { sessionId?: Id; taskId?: Id; forTaskId?: Id; states?: MailMessage["state"][] } = {}): MailMessage[] {
    const { forTaskId, ...rest } = filter;
    if (!forTaskId) return this.store.listMail(rest);
    const sessions = new Set(this.store.listSessions({ taskId: forTaskId }).map((s) => s.id));
    return this.store
      .listMail(rest.states ? { states: rest.states } : {})
      .filter((m) => (m.to.kind === "task" ? m.to.taskId === forTaskId : sessions.has(m.to.sessionId)));
  }

  /** Leaves a message for a session or a task. `fromSessionId` null: from the person. */
  sendMail(fromSessionId: Id | null, to: unknown, textIn: unknown): MailMessage {
    const text = boundedText(textIn, "text", MAX_NOTE_CHARS);
    const recipient = this.validRecipient(to);
    const from = fromSessionId ? this.requireSession(fromSessionId) : null;
    if (from && recipient.kind === "session" && recipient.sessionId === from.id) throw new HostError("bad_request", "a session cannot leave mail for itself");
    const mail: MailMessage = {
      id: newId("mail"),
      fromSessionId: from?.id ?? null,
      fromTaskId: from?.taskId ?? null,
      to: recipient,
      text,
      state: "unread",
      createdAt: new Date().toISOString(),
      handledAt: null,
    };
    this.store.putMail(mail);
    this.publish({ type: "mail.upserted", mail });
    return mail;
  }

  updateMail(id: Id, state: unknown): MailMessage {
    if (state !== "read" && state !== "dismissed") throw new HostError("bad_request", "state must be read or dismissed");
    return this.setMailState(this.requireMail(id), state);
  }

  /** The person puts a message into a conversation; it goes in as a user message, marked as coming from AMO mail. */
  async forwardMail(id: Id, input: { sessionId?: unknown } = {}): Promise<MailMessage> {
    const mail = this.requireMail(id);
    if (mail.state === "forwarded") throw new HostError("conflict", "this message was already forwarded");
    const target = mail.to.kind === "session" ? mail.to.sessionId : typeof input.sessionId === "string" ? input.sessionId : null;
    if (!target) throw new HostError("bad_request", "name the session to forward this task message to");
    const session = this.requireSession(target);
    if (mail.to.kind === "task" && session.taskId !== mail.to.taskId) throw new HostError("bad_request", "that session is not part of the task the message was left for");
    await this.sendMessage(target, this.mailAsMessage(mail));
    return this.setMailState(mail, "forwarded");
  }

  /** Mail an agent reads for itself (`mailbox_read`): its own and its task's unread messages, then marked read. */
  readMailFromSession(sessionId: Id): MailMessage[] {
    const s = this.requireSession(sessionId);
    const unread = this.store.listMail({ sessionId, taskId: s.taskId, states: ["unread"] });
    return unread.map((m) => this.setMailState(m, "read"));
  }

  decisions(filter: { state?: DecisionRequest["state"] } = {}): DecisionRequest[] {
    return this.store.listDecisions(filter);
  }

  requestDecisionFromSession(sessionId: Id, questionIn: unknown, optionsIn: unknown): DecisionRequest {
    const s = this.requireSession(sessionId);
    const question = boundedText(questionIn, "question", MAX_QUESTION_CHARS);
    const options = Array.isArray(optionsIn) ? optionsIn.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, MAX_OPTION_CHARS)).slice(0, 6) : [];
    const d: DecisionRequest = { id: newId("dec"), sessionId, taskId: s.taskId, question, options, state: "open", answer: null, createdAt: new Date().toISOString(), answeredAt: null };
    this.store.putDecision(d);
    this.publish({ type: "decision.upserted", decision: d });
    return d;
  }

  answerDecision(id: Id, answerIn: unknown): DecisionRequest {
    const d = this.store.getDecision(id);
    if (!d) throw new HostError("not_found", `decision ${id} not found`);
    if (d.state !== "open") throw new HostError("conflict", "this decision was already answered");
    const answer = boundedText(answerIn, "answer", MAX_QUESTION_CHARS);
    const next: DecisionRequest = { ...d, state: "answered", answer, answeredAt: new Date().toISOString() };
    this.store.putDecision(next);
    this.publish({ type: "decision.upserted", decision: next });
    this.sendMail(null, { kind: "session", sessionId: d.sessionId }, `针对你的问题「${d.question}」，我的决定：${answer}`);
    return next;
  }

  private mailAsMessage(mail: MailMessage): string {
    if (!mail.fromSessionId) return `[AMO 留言] 来自我：\n\n${mail.text}`;
    const from = this.store.getSession(mail.fromSessionId);
    const task = mail.fromTaskId ? this.store.getTask(mail.fromTaskId) : undefined;
    return `[AMO 留言] 来自任务「${task?.title || "未命名任务"}」的会话「${from?.title || "会话"}」：\n\n${mail.text}`;
  }

  private setMailState(mail: MailMessage, state: MailMessage["state"]): MailMessage {
    if (mail.state === state) return mail;
    const next: MailMessage = { ...mail, state, handledAt: new Date().toISOString() };
    this.store.putMail(next);
    this.publish({ type: "mail.upserted", mail: next });
    return next;
  }

  private requireMail(id: Id): MailMessage {
    const m = this.store.getMail(id);
    if (!m) throw new HostError("not_found", `mail ${id} not found`);
    return m;
  }

  private validRecipient(to: unknown): MailRecipient {
    const r = to as Partial<{ kind: string; sessionId: string; taskId: string }> | null;
    if (r?.kind === "session" && typeof r.sessionId === "string") {
      this.requireSession(r.sessionId);
      return { kind: "session", sessionId: r.sessionId };
    }
    if (r?.kind === "task" && typeof r.taskId === "string") {
      this.requireTask(r.taskId);
      return { kind: "task", taskId: r.taskId };
    }
    throw new HostError("bad_request", "to must be { kind: \"session\", sessionId } or { kind: \"task\", taskId }");
  }

  // Canvas (one global document)

  canvas(): CanvasDoc {
    return this.store.getCanvas(MAIN_CANVAS_ID) ?? emptyCanvas();
  }

  saveCanvas(input: unknown): CanvasDoc {
    const doc = input as CanvasDoc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.groups) || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
      throw new HostError("bad_request", "canvas needs groups, nodes and edges arrays");
    }
    const current = this.canvas();
    if (doc.version !== current.version) {
      throw new HostError("conflict", `canvas changed elsewhere (version ${current.version}, yours ${String(doc.version)}); reload and retry`);
    }
    const errors = validateCanvas(doc, new Set(this.store.listTasks().map((t) => t.id)));
    if (errors.length) throw new HostError("bad_request", errors.slice(0, 5).join("; "));
    const next: CanvasDoc = {
      id: MAIN_CANVAS_ID,
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

  // Canvas changes asked for by agents (AMO MCP): structure only, Studio lays out.

  canvasCreateGroup(input: { title?: unknown; workspace?: unknown }): { groupId: Id; title: string } {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new HostError("bad_request", "title is required");
    let workspaceId: Id | null = null;
    if (typeof input.workspace === "string" && input.workspace) {
      const ws = this.store.listWorkspaces().find((w) => w.id === input.workspace || w.name === input.workspace);
      if (!ws) throw new HostError("bad_request", `workspace ${input.workspace} not found`);
      workspaceId = ws.id;
    }
    const id = newId("g");
    this.mutateCanvas((doc) => addGroupAuto(doc, { id, title, workspaceId }));
    return { groupId: id, title };
  }

  canvasAddDependency(fromTaskId: unknown, toTaskId: unknown): { from: Id; to: Id } {
    const from = this.requireTask(String(fromTaskId)).id;
    const to = this.requireTask(String(toTaskId)).id;
    this.mutateCanvas((doc) => addDependency(doc, from, to, newId("e")));
    return { from, to };
  }

  canvasPlaceTask(taskId: unknown, groupId: unknown): { taskId: Id; groupId: Id | null } {
    const task = this.requireTask(String(taskId)).id;
    const group = typeof groupId === "string" && groupId ? groupId : null;
    this.mutateCanvas((doc) => placeTask(doc, task, group, newId("n")));
    return { taskId: task, groupId: group };
  }

  /** Applies a change to the latest canvas and saves it (one synchronous read-modify-write, so no version race here). */
  private mutateCanvas(change: (doc: CanvasDoc) => CanvasDoc): CanvasDoc {
    const current = this.canvas();
    let next: CanvasDoc;
    try {
      next = change(current);
    } catch (err) {
      if (err instanceof CanvasLayoutError) throw new HostError("bad_request", err.message);
      throw err;
    }
    return this.saveCanvas({ ...next, version: current.version });
  }

  canvasOutline() {
    return canvasOutline(this.canvas(), this.store.listTasks(), this.store.listWorkspaces(), this.store.listSessions());
  }

  // Scratchpad (global)

  scratchpad(): Scratchpad {
    const kv = this.store.getKv(SCRATCHPAD_KEY);
    return { text: kv?.value ?? "", updatedAt: kv?.updatedAt ?? null };
  }

  saveScratchpad(text: unknown): Scratchpad {
    if (typeof text !== "string") throw new HostError("bad_request", "text must be a string");
    if (text.length > 200_000) throw new HostError("bad_request", "scratchpad is limited to 200000 characters");
    const kv = this.store.setKv(SCRATCHPAD_KEY, text);
    const scratchpad = { text: kv.value, updatedAt: kv.updatedAt };
    this.publish({ type: "scratchpad.updated", scratchpad });
    return scratchpad;
  }

  // Annotations (stage 2 review loop)

  annotations(sessionId: Id): Annotation[] {
    this.requireSession(sessionId);
    return this.store.listAnnotations(sessionId);
  }

  addAnnotation(sessionId: Id, input: NewAnnotationInput): Annotation {
    this.requireSession(sessionId);
    const item = this.store.getItem(String(input?.itemId ?? ""));
    if (!item || item.sessionId !== sessionId) throw new HostError("bad_request", "itemId must be an item of this session");
    if (item.type !== "agent") throw new HostError("bad_request", "only agent replies can be annotated");
    const quote = typeof input.quote === "string" ? input.quote : "";
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!quote.trim()) throw new HostError("bad_request", "quote is required");
    if (!note) throw new HostError("bad_request", "note is required");
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw new HostError("bad_request", "start/end must be a non-empty range");
    if (end > item.markdown.replace(/\r\n/g, "\n").length) throw new HostError("bad_request", "start/end lie outside the reply");
    const annotation: Annotation = {
      id: newId("an"),
      sessionId,
      itemId: item.id,
      quote,
      start,
      end,
      prefix: typeof input.prefix === "string" ? input.prefix.slice(-24) : "",
      suffix: typeof input.suffix === "string" ? input.suffix.slice(0, 24) : "",
      note,
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    this.store.putAnnotation(annotation);
    this.publish({ type: "annotation.upserted", annotation });
    return annotation;
  }

  updateAnnotation(id: Id, note: string): Annotation {
    const current = this.requireAnnotation(id);
    if (current.sentAt) throw new HostError("conflict", "sent annotations cannot be edited");
    const trimmed = typeof note === "string" ? note.trim() : "";
    if (!trimmed) throw new HostError("bad_request", "note is required");
    const next = { ...current, note: trimmed };
    this.store.putAnnotation(next);
    this.publish({ type: "annotation.upserted", annotation: next });
    return next;
  }

  deleteAnnotation(id: Id): void {
    const current = this.requireAnnotation(id);
    this.store.deleteAnnotation(id);
    this.publish({ type: "annotation.removed", sessionId: current.sessionId, annotationId: id });
  }

  /** Sends all unsent annotations as one message (reply order, then position in the reply) and marks them sent. */
  async sendAnnotations(sessionId: Id): Promise<{ mode: SendMode; sent: Annotation[] }> {
    const pending = this.annotations(sessionId).filter((a) => !a.sentAt);
    if (!pending.length) throw new HostError("bad_request", "no annotations to send");
    const seq = (a: Annotation) => this.store.getItem(a.itemId)?.seq ?? Number.MAX_SAFE_INTEGER;
    pending.sort((a, b) => seq(a) - seq(b) || a.start - b.start);
    const result = await this.sendMessage(sessionId, composeAnnotationMessage(pending));
    const at = new Date().toISOString();
    const sent = pending.map((a) => {
      const next = { ...a, sentAt: at };
      this.store.putAnnotation(next);
      this.publish({ type: "annotation.upserted", annotation: next });
      return next;
    });
    return { mode: result.mode, sent };
  }

  private requireAnnotation(id: Id): Annotation {
    const a = this.store.getAnnotation(id);
    if (!a) throw new HostError("not_found", `annotation ${id} not found`);
    return a;
  }

  // Helpers

  private async startSession(task: Task, workspace: Workspace, input: NewSessionInput): Promise<Session> {
    const session = await this.wrap(() =>
      this.runtime.startSession({ taskId: task.id, profileId: input.profileId, workspace, ...(input.text ? { text: input.text } : {}) }),
    );
    // The task's updatedAt moves with its sessions so the board can sort by activity.
    this.publish({ type: "task.upserted", task: this.store.updateTask(task.id, {}) });
    return session;
  }

  private validScope(scope: TaskScope | undefined): TaskScope {
    if (scope?.kind === "area") return { kind: "area" };
    if (scope?.kind === "workspace") {
      if (!this.store.getWorkspace(scope.workspaceId)) throw new HostError("bad_request", `workspace ${scope.workspaceId} not found`);
      return { kind: "workspace", workspaceId: scope.workspaceId };
    }
    throw new HostError("bad_request", "scope must be a workspace or the cross-workspace area");
  }

  /** Workspace tasks always use their workspace; cross-workspace tasks need one per session. */
  private sessionWorkspace(scope: TaskScope, requested: Id | undefined): Workspace {
    const id = scope.kind === "workspace" ? scope.workspaceId : requested;
    if (!id) throw new HostError("bad_request", "cross-workspace sessions need a workspaceId");
    if (scope.kind === "workspace" && requested && requested !== scope.workspaceId) {
      throw new HostError("bad_request", "sessions of a workspace task stay in that workspace");
    }
    const ws = this.store.getWorkspace(id);
    if (!ws) throw new HostError("bad_request", `workspace ${id} not found`);
    return ws;
  }

  private requireProfile(id: Id): ModelProfile {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) throw new HostError("bad_request", `unknown model profile ${id}`);
    return p;
  }

  checklist(taskId?: Id): ChecklistItem[] {
    if (taskId) this.requireTask(taskId);
    return this.store.listChecklist(taskId);
  }

  /** Ticks or unticks a checklist step; a session may only tick its own task's steps. */
  setChecklistDone(id: Id, done: unknown, sessionId: Id | null = null): ChecklistItem {
    const item = this.store.getChecklistItem(id);
    if (!item) throw new HostError("not_found", `checklist item ${id} not found`);
    if (typeof done !== "boolean") throw new HostError("bad_request", "done must be true or false");
    if (sessionId && this.requireSession(sessionId).taskId !== item.taskId) throw new HostError("bad_request", "a session can only tick its own task's checklist");
    const next: ChecklistItem = { ...item, done, doneBySessionId: done ? sessionId : null, doneAt: done ? new Date().toISOString() : null };
    this.store.putChecklistItem(next);
    this.publish({ type: "checklist.upserted", item: next });
    return next;
  }

  /** A pack's session preset filled in for a task, for the person to confirm; a workspace task uses its own workspace's packs. */
  presetDraft(workspaceId: Id, packName: string, presetId: string, taskId: unknown): PresetDraft {
    if (typeof taskId !== "string") throw new HostError("bad_request", "taskId is required");
    const task = this.requireTask(taskId);
    const workspace = this.requireWorkspace(workspaceId);
    if (task.scope.kind === "workspace" && task.scope.workspaceId !== workspaceId) throw new HostError("bad_request", "a workspace task takes presets from its own workspace");
    const pack = this.packs(workspaceId).find((p) => p.dirName === packName);
    if (!pack?.manifest) throw new HostError(pack ? "bad_request" : "not_found", pack ? `扩展包 ${packName} 有错误` : `扩展包 ${packName} 不存在`);
    const preset = pack.manifest.presets.find((p) => p.id === presetId);
    if (!preset) throw new HostError("not_found", `扩展包 ${packName} 里没有启动预设 ${presetId}`);
    // {{pack.dir}} is relative to the workspace (sessions run there), with forward slashes: short and the same on every OS.
    return presetDraft({ preset, packDir: `${PACKS_DIR}/${pack.dirName}`, workspace, taskTitle: task.title, profileIds: this.profiles.map((p) => p.id) });
  }

  /** A template of a valid pack; for a workspace task it must come from that workspace. */
  private packTemplate(scope: TaskScope, choice: TaskTemplateChoice): PackTemplate {
    const c = choice as Partial<TaskTemplateChoice> | null;
    if (!c || typeof c.workspaceId !== "string" || typeof c.pack !== "string" || typeof c.template !== "string") throw new HostError("bad_request", "template needs workspaceId, pack and template");
    if (scope.kind === "workspace" && c.workspaceId !== scope.workspaceId) throw new HostError("bad_request", "a workspace task takes templates from its own workspace");
    const pack = this.packs(c.workspaceId).find((p) => p.dirName === c.pack);
    if (!pack?.manifest) throw new HostError("bad_request", pack ? `扩展包 ${c.pack} 有错误` : `扩展包 ${c.pack} 不存在`);
    const template = pack.manifest.templates.find((t) => t.id === c.template);
    if (!template) throw new HostError("bad_request", `扩展包 ${c.pack} 里没有模板 ${c.template}`);
    return template;
  }

  /** Extension packs found in a workspace (`.amo/packs`), valid or not. */
  packs(workspaceId: Id): WorkspacePack[] {
    return this.packLoader.list(this.requireWorkspace(workspaceId).path);
  }

  packDoc(workspaceId: Id, pack: string, docId: string): PackDocContent {
    try {
      return this.packLoader.readDoc(this.requireWorkspace(workspaceId).path, pack, docId);
    } catch (err) {
      if (err instanceof PackError) throw new HostError(err.kind, err.message);
      throw err;
    }
  }

  private requireWorkspace(id: Id): Workspace {
    const ws = this.store.getWorkspace(id);
    if (!ws) throw new HostError("not_found", `workspace ${id} not found`);
    return ws;
  }

  private requireTask(id: Id): Task {
    const t = this.store.getTask(id);
    if (!t) throw new HostError("not_found", `task ${id} not found`);
    return t;
  }

  requireSession(id: Id): Session {
    const s = this.store.getSession(id);
    if (!s) throw new HostError("not_found", `session ${id} not found`);
    return s;
  }

  private async wrap<T>(fn: () => Promise<T>, fallback: HostErrorCode = "runtime_error"): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HostError) throw err;
      const e = err as { code?: string; message?: string };
      throw new HostError(e.code === "read_only" ? "read_only" : fallback, e.message ?? String(err));
    }
  }

  publish(event: HostEventInput): HostEvent {
    const persisted = this.store.appendEvent(event);
    this.emit("event", persisted);
    return persisted;
  }
}
