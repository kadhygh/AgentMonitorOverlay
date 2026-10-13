import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AccountUsage,
  CredentialStatus,
  ProfileChoices,
  SessionOptions,
  SessionPreset,
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
  Topic,
  Workspace,
  WorkspacePack,
  PackDocContent,
  ChecklistItem,
  TaskTemplateChoice,
  PackTemplate,
  PresetDraft,
  ScheduleProposal,
  StudioSettings,
} from "@amo-studio/protocol";
import {
  PACKS_DIR,
  workspacesActivity,
  addDependency,
  addGroupAuto,
  CanvasLayoutError,
  canvasOutline,
  composeAnnotationMessage,
  emptyCanvas,
  isCommon,
  MAIN_CANVAS_ID,
  placeTask,
  removeTask,
  TASK_COLUMNS,
  topicWorkspaceIds,
  validateCanvas,
} from "@amo-studio/protocol";
import { newId, type HostEventInput, type Store } from "./store/store.js";
import type { SendMode, SessionRuntimeApi } from "./runtime/runtime.js";
import type { CredentialReader, CredentialStore } from "./runtime/credentials.js";
import { CLAUDE_SUBSCRIPTION_CREDENTIAL } from "./runtime/profiles.js";
import type { TerminalHandle, TerminalLauncher } from "./terminal/launcher.js";
import { PackError, PackLoader } from "./packs/pack-loader.js";
import { presetDraft } from "./packs/presets.js";
import { schedulerBrief } from "./scheduler/brief.js";

/** Env var that carries the app-server token into an attached terminal; never put the token itself on a command line. */
export const TERMINAL_TOKEN_ENV = "AMO_STUDIO_CODEX_TOKEN";

const SCRATCHPAD_KEY = "scratchpad";
/** Before structure v2 the common space was a plain workspace remembered here; now it is marked `builtin`. */
const LEGACY_COMMON_WORKSPACE_KEY = "settings:common-workspace";
const COMMON_NAME = "公共";
const PRESETS_KEY = "settings:presets";
const MAX_PRESETS = 30;

/** Checks one option value: a short CLI id (model names like "glm-5.3[1m]" included). */
function optionValue(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 100 || !/^[\w.:\-[\]/ ]+$/.test(v)) throw new HostError("bad_request", `${field} is not a valid value`);
  return v;
}

/** Session options from a request body; unknown keys are ignored. */
function sessionOptions(v: unknown): SessionOptions {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: SessionOptions = {};
  const model = optionValue(o.model, "model");
  const effort = optionValue(o.effort, "effort");
  const permission = optionValue(o.permission, "permission");
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (permission) out.permission = permission;
  return out;
}

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

/** The only entry Studio writes: the Claude subscription token the person pastes in 设置 → 模型凭据. */
const WRITABLE_CREDENTIALS = new Set([CLAUDE_SUBSCRIPTION_CREDENTIAL]);

export class HostService extends EventEmitter<HostServiceEvents> {
  /** Terminals that hold a Claude session (handoff); closing one gives the session back. */
  private readonly handoffs = new Map<Id, TerminalHandle>();
  /** One reclaim at a time per session, or the terminal's additions would be imported twice. */
  private readonly reclaiming = new Map<Id, Promise<Session>>();
  private readonly packLoader = new PackLoader();
  /** Todos being turned into tasks right now. */
  private readonly converting = new Set<Id>();

  constructor(
    readonly store: Store,
    readonly runtime: SessionRuntimeApi,
    readonly profiles: readonly ModelProfile[],
    private readonly options: {
      launcher?: TerminalLauncher;
      credentials?: CredentialReader | CredentialStore;
      /** Where the common space lives when it is first made; default `common/` next to the database. */
      commonDir?: string;
    } = {},
  ) {
    super();
    runtime.on("event", (e) => this.emit("event", e));
    this.ensureStructure();
  }

  snapshot(): StateSnapshot {
    return {
      workspaces: this.store.listWorkspaces(),
      topics: this.store.listTopics(),
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

  settings(): StudioSettings {
    return { commonWorkspace: this.commonWorkspace(), presets: this.presets() };
  }

  /** The common space: where tasks without a project, the scheduler and topic sessions without a project run. */
  commonWorkspace(): Workspace {
    const ws = this.store.listWorkspaces().find(isCommon);
    if (!ws) throw new HostError("internal", "the common space is missing");
    return ws;
  }

  // ---- structure v2 (design/structure.md) -------------------------------------------------------------------------

  /**
   * Brings data from before structure v2 into shape, once per start (cheap when there is nothing to do): makes sure
   * the common space exists, gives tasks of the old cross-workspace area a workspace (and a topic when their sessions
   * ran in several projects), and turns the old global canvas into the first topic.
   */
  private ensureStructure(): void {
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

  private presets(): SessionPreset[] {
    const raw = this.store.getKv(PRESETS_KEY)?.value;
    if (!raw) return [];
    try {
      return JSON.parse(raw) as SessionPreset[];
    } catch {
      return [];
    }
  }

  /** Moves the common space to another folder and/or replaces the 常用预设 list. */
  updateSettings(input: { commonDir?: unknown; presets?: unknown }): StudioSettings {
    if (input.presets !== undefined) {
      if (!Array.isArray(input.presets) || input.presets.length > MAX_PRESETS) throw new HostError("bad_request", `presets must be a list of at most ${MAX_PRESETS}`);
      const presets: SessionPreset[] = input.presets.map((p: unknown) => {
        const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
        const profileId = typeof o.profileId === "string" ? o.profileId : "";
        if (!this.profiles.some((x) => x.id === profileId)) throw new HostError("bad_request", `unknown profile ${profileId}`);
        return {
          id: typeof o.id === "string" && o.id ? o.id.slice(0, 64) : newId("pre"),
          name: boundedText(o.name, "name", 40),
          profileId,
          options: sessionOptions(o.options),
        };
      });
      this.store.setKv(PRESETS_KEY, JSON.stringify(presets));
    }
    if (input.commonDir !== undefined) {
      if (typeof input.commonDir !== "string" || !input.commonDir.trim()) throw new HostError("bad_request", "commonDir must be a folder path");
      const path = resolve(input.commonDir.trim());
      if (existsSync(path) && !statSync(path).isDirectory()) throw new HostError("bad_request", `not a directory: ${path}`);
      const common = this.commonWorkspace();
      const taken = this.store.findWorkspaceByPath(path);
      if (taken && taken.id !== common.id) throw new HostError("conflict", `这个文件夹已经是项目「${taken.name}」，不能再当公共目录`);
      mkdirSync(path, { recursive: true });
      this.publish({ type: "workspace.upserted", workspace: this.store.setWorkspacePath(common.id, path) });
    }
    const settings = this.settings();
    this.publish({ type: "settings.updated", settings });
    return settings;
  }

  // ---- models, efforts and permissions ----------------------------------------------------------------------------

  choices(profileId: Id): Promise<ProfileChoices> {
    if (!this.profiles.some((p) => p.id === profileId)) throw new HostError("not_found", `profile ${profileId} not found`);
    return this.wrap(() => this.runtime.choices(profileId));
  }

  /** Quota use of the subscription profiles (GPT login, Claude token), in profile order. */
  async usage(refresh: boolean): Promise<AccountUsage[]> {
    const out: AccountUsage[] = [];
    for (const p of this.profiles) {
      const u = this.runtime.usage ? await this.runtime.usage(p.id, refresh).catch(() => null) : null;
      if (u) out.push(u);
    }
    return out;
  }

  /** Renames a session in its own runtime (the stored title follows the runtime's name). */
  renameSession(sessionId: Id, titleIn: unknown): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be renamed");
    const title = boundedText(titleIn, "title", 100);
    return this.wrap(() => this.runtime.rename(sessionId, title));
  }

  /** Changes some of the session's options; null (or "") clears one back to the profile's default. */
  updateSessionOptions(sessionId: Id, patch: unknown): Promise<Session> {
    const s = this.store.getSession(sessionId);
    if (!s) throw new HostError("not_found", `session ${sessionId} not found`);
    const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
    const next: SessionOptions = { ...s.options };
    for (const key of ["model", "effort", "permission"] as const) {
      if (!(key in p)) continue;
      const value = optionValue(p[key], key);
      if (value) next[key] = value;
      else delete next[key];
    }
    return this.wrap(() => this.runtime.setOptions(sessionId, next));
  }

  // ---- model credentials ----------------------------------------------------------------------------------------

  /** Which credentials the profiles need, and whether each is stored (the values never leave the Host). */
  credentials(): CredentialStatus[] {
    const reader = this.options.credentials;
    const ids = [...new Set(this.profiles.flatMap((p) => (p.credentialId ? [p.credentialId] : [])))];
    return ids.map((id) => ({
      id,
      usedBy: this.profiles.filter((p) => p.credentialId === id).map((p) => p.label),
      saved: !!reader?.read(id),
      writable: WRITABLE_CREDENTIALS.has(id) && !!reader && "write" in reader,
    }));
  }

  saveCredential(id: string, secret: unknown): CredentialStatus[] {
    const store = this.writableStore(id);
    const value = typeof secret === "string" ? secret.trim() : "";
    if (!value) throw new HostError("bad_request", "secret is required");
    if (value.length > 4096 || /\s/.test(value)) throw new HostError("bad_request", "这不像一个令牌：应是一整串不含空格和换行的字符");
    store.write(id, value);
    return this.credentials();
  }

  removeCredential(id: string): CredentialStatus[] {
    this.writableStore(id).remove(id);
    return this.credentials();
  }

  private writableStore(id: string): CredentialStore {
    const store = this.options.credentials;
    if (!WRITABLE_CREDENTIALS.has(id) || !store || !("write" in store)) throw new HostError("read_only", `credential ${id} cannot be changed from Studio`);
    return store;
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

  // Tasks

  /**
   * A task in a project (the common space when none is given), optionally in a topic. With `firstSession` its first
   * session starts at once; without, the task is only filed (待办 unless another column is given).
   */
  async createTask(input: {
    title?: string;
    workspaceId?: Id | null;
    topicId?: Id | null;
    column?: TaskColumn;
    firstSession?: NewSessionInput;
    template?: TaskTemplateChoice;
  }): Promise<{ task: Task; session: Session | null }> {
    const workspace = input.workspaceId ? this.requireWorkspace(input.workspaceId) : this.commonWorkspace();
    const topic = input.topicId ? this.requireLiveTopic(input.topicId) : null;
    if (input.firstSession) {
      this.requireProfile(input.firstSession.profileId);
      if (input.firstSession.workspaceId && input.firstSession.workspaceId !== workspace.id) throw new HostError("bad_request", "a task's sessions run in the task's own workspace");
    }
    if (input.column !== undefined && !TASK_COLUMNS.includes(input.column)) throw new HostError("bad_request", `unknown column ${String(input.column)}`);
    const template = input.template ? this.packTemplate(workspace.id, input.template) : null;
    const base = input.title?.trim() || input.firstSession?.text?.trim().slice(0, 60) || template?.title || "";
    const title = template?.titlePrefix && !base.startsWith(template.titlePrefix.trim()) ? `${template.titlePrefix}${base}` : base;
    const column = input.firstSession ? "doing" : (input.column ?? "todo");
    const task = this.store.createTask({ title, workspaceId: workspace.id, topicId: topic?.id ?? null, column });
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
   * another topic (or out of its topic): it leaves the old topic's canvas with its dependencies there.
   */
  updateTask(id: Id, patch: { title?: unknown; column?: unknown; workspaceId?: unknown; topicId?: unknown }): Task {
    const current = this.requireTask(id);
    const clean: Partial<Pick<Task, "title" | "column" | "workspaceId" | "topicId">> = {};
    if (patch.title !== undefined) clean.title = String(patch.title).trim();
    if (current.archivedAt && (patch.column !== undefined || patch.workspaceId !== undefined || patch.topicId !== undefined)) throw new HostError("read_only", "archived tasks cannot be moved");
    if (patch.column !== undefined) {
      if (!TASK_COLUMNS.includes(patch.column as TaskColumn)) throw new HostError("bad_request", `unknown column ${String(patch.column)}`);
      clean.column = patch.column as TaskColumn;
    }
    if (patch.workspaceId !== undefined) {
      const workspaceId = patch.workspaceId === null || patch.workspaceId === "" ? this.commonWorkspace().id : this.requireWorkspace(String(patch.workspaceId)).id;
      if (workspaceId !== current.workspaceId && this.store.listSessions({ taskId: id }).length) throw new HostError("conflict", "a task's project cannot change once it has sessions");
      clean.workspaceId = workspaceId;
    }
    if (patch.topicId !== undefined) {
      const topicId = patch.topicId === null || patch.topicId === "" ? null : this.requireLiveTopic(String(patch.topicId)).id;
      if (topicId !== current.topicId) {
        clean.topicId = topicId;
        if (current.topicId) this.leaveCanvas(current.topicId, id);
      }
    }
    const task = this.store.updateTask(id, clean);
    this.publish({ type: "task.upserted", task });
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

  // Topics (专题)

  createTopic(input: { title?: unknown; workspaceIds?: unknown }): Topic {
    const title = boundedText(input?.title, "title", 100);
    const topic = this.store.createTopic({ title, workspaceIds: this.projectIds(input.workspaceIds) });
    this.publish({ type: "topic.upserted", topic });
    return topic;
  }

  updateTopic(id: Id, patch: { title?: unknown; workspaceIds?: unknown }): Topic {
    const current = this.requireTopic(id);
    if (current.archivedAt) throw new HostError("read_only", "archived topics cannot be changed");
    const clean: Partial<Pick<Topic, "title" | "workspaceIds">> = {};
    if (patch.title !== undefined) clean.title = boundedText(patch.title, "title", 100);
    if (patch.workspaceIds !== undefined) clean.workspaceIds = this.projectIds(patch.workspaceIds);
    const topic = this.store.updateTopic(id, clean);
    this.publish({ type: "topic.upserted", topic });
    return topic;
  }

  /** Archives the topic with its own sessions and all its tasks (and theirs). */
  async archiveTopic(id: Id): Promise<{ topic: Topic; tasks: Task[] }> {
    const current = this.requireTopic(id);
    if (current.archivedAt) return { topic: current, tasks: [] };
    const topic = this.store.updateTopic(id, { archivedAt: new Date().toISOString() });
    this.publish({ type: "topic.upserted", topic });
    await this.archiveSessions(this.store.listSessions({ topicId: id }));
    const tasks: Task[] = [];
    for (const t of this.store.listTasks().filter((x) => x.topicId === id && !x.archivedAt)) tasks.push(await this.archiveTask(t.id));
    return { topic: this.store.getTopic(id)!, tasks };
  }

  /** Restores the topic, its sessions and the tasks that were archived with it. */
  async unarchiveTopic(id: Id): Promise<{ topic: Topic; tasks: Task[] }> {
    const current = this.requireTopic(id);
    if (!current.archivedAt) return { topic: current, tasks: [] };
    const since = current.archivedAt;
    const topic = this.store.updateTopic(id, { archivedAt: null });
    this.publish({ type: "topic.upserted", topic });
    await this.unarchiveSessions(this.store.listSessions({ topicId: id }), since);
    const tasks: Task[] = [];
    for (const t of this.store.listTasks().filter((x) => x.topicId === id && x.archivedAt && x.archivedAt >= since)) tasks.push(await this.unarchiveTask(t.id));
    return { topic: this.store.getTopic(id)!, tasks };
  }

  /** A topic session: runs in one of the topic's projects, or in the common space when none is named. */
  async addTopicSession(topicId: Id, input: NewSessionInput): Promise<Session> {
    const topic = this.requireLiveTopic(topicId);
    this.requireProfile(input.profileId);
    let workspace = this.commonWorkspace();
    if (input.workspaceId && input.workspaceId !== workspace.id) {
      if (!topicWorkspaceIds(topic, this.store.listTasks(), this.store.listWorkspaces()).includes(input.workspaceId)) {
        throw new HostError("bad_request", "a topic session runs in one of the topic's projects or in the common space");
      }
      workspace = this.requireWorkspace(input.workspaceId);
    }
    return this.startSession({ taskId: null, topicId: topic.id }, workspace, input);
  }

  /** The topic a session works for: its own (topic session), or its task's. */
  topicOfSession(sessionId: Id): Topic | null {
    const s = this.requireSession(sessionId);
    const id = s.topicId ?? (s.taskId ? this.store.getTask(s.taskId)?.topicId : null);
    return (id && this.store.getTopic(id)) || null;
  }

  private projectIds(value: unknown): Id[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new HostError("bad_request", "workspaceIds must be a list");
    const ids = [...new Set(value.map(String))];
    for (const id of ids) if (isCommon(this.requireWorkspace(id))) throw new HostError("bad_request", "the common space is not a project");
    return ids;
  }

  private async archiveSessions(sessions: readonly Session[]): Promise<void> {
    // Archiving a root takes its forks and subagents with it.
    for (const s of sessions.filter((x) => !x.parentId && !x.archivedAt)) await this.wrap(() => this.runtime.archive(s.id));
  }

  /** Restores the sessions archived at or after `since` (by the cascade), root by root. */
  private async unarchiveSessions(sessions: readonly Session[], since: string): Promise<void> {
    for (const s of sessions.filter((x) => !x.parentId && x.archivedAt && x.archivedAt >= since)) await this.wrap(() => this.runtime.unarchive(s.id));
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
   * Turns a todo into a task in its workspace (or the one given; the common space when neither), with one session and
   * no first message (no model call). Converted on a topic's canvas, the task joins that topic, in the group bound to
   * its workspace if there is one. The todo is done and points at it.
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
    const { task, session } = await this.createTask({
      title: todo.text.slice(0, 100),
      workspaceId,
      topicId,
      firstSession: { profileId, ...(text ? { text } : {}) },
    });
    const group = topicId ? this.canvas(topicId).groups.find((g) => g.workspaceId === workspaceId) : undefined;
    if (group) this.canvasPlaceTask(task.id, group.id);
    const next: TodoItem = { ...todo, workspaceId, taskId: task.id, done: true };
    this.store.putTodo(next);
    this.publish({ type: "todo.upserted", todo: next });
    return { todo: next, task, session: session! };
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
      packs: workspaces.flatMap((w) => this.packs(w.id).map((p) => ({ ...p, workspaceId: w.id }))),
      perRound: PROPOSALS_PER_ROUND,
    });
    const session = await this.addSession(task.id, { profileId: input.profileId, text });
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
    if (sessionId && this.requireSession(sessionId).taskId !== taskId) throw new HostError("bad_request", "a session can only write to its own task (topic sessions have none; leave mail instead)");
    const note: TaskNote = { id: newId("note"), taskId, sessionId, kind: input.kind === "handoff" ? "handoff" : "progress", text, createdAt: new Date().toISOString() };
    this.store.addTaskNote(note);
    this.publish({ type: "task.note.added", note });
    return note;
  }

  /**
   * Mail by recipient; `forTaskId` / `forTopicId`: everything left for that task or topic or for any of its own
   * sessions.
   */
  mail(filter: { sessionId?: Id; taskId?: Id; topicId?: Id; forTaskId?: Id; forTopicId?: Id; states?: MailMessage["state"][] } = {}): MailMessage[] {
    const { forTaskId, forTopicId, ...rest } = filter;
    if (!forTaskId && !forTopicId) return this.store.listMail(rest);
    const sessions = new Set(this.store.listSessions(forTaskId ? { taskId: forTaskId } : { topicId: forTopicId! }).map((s) => s.id));
    return this.store
      .listMail(rest.states ? { states: rest.states } : {})
      .filter((m) => (m.to.kind === "session" ? sessions.has(m.to.sessionId) : m.to.kind === "task" ? m.to.taskId === forTaskId : m.to.topicId === forTopicId));
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
      fromTopicId: from?.topicId ?? null,
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
    if (!target) throw new HostError("bad_request", "name the session to forward this message to");
    const session = this.requireSession(target);
    if (mail.to.kind === "task" && session.taskId !== mail.to.taskId) throw new HostError("bad_request", "that session is not part of the task the message was left for");
    if (mail.to.kind === "topic" && session.topicId !== mail.to.topicId) throw new HostError("bad_request", "that session is not one of the topic's own sessions");
    await this.sendMessage(target, this.mailAsMessage(mail));
    return this.setMailState(mail, "forwarded");
  }

  /** Mail an agent reads for itself (`mailbox_read`): its own and its owner's unread messages, then marked read. */
  readMailFromSession(sessionId: Id): MailMessage[] {
    const s = this.requireSession(sessionId);
    const unread = this.store.listMail({ sessionId, ...(s.taskId ? { taskId: s.taskId } : { topicId: s.topicId! }), states: ["unread"] });
    return unread.map((m) => this.setMailState(m, "read"));
  }

  decisions(filter: { state?: DecisionRequest["state"] } = {}): DecisionRequest[] {
    return this.store.listDecisions(filter);
  }

  requestDecisionFromSession(sessionId: Id, questionIn: unknown, optionsIn: unknown): DecisionRequest {
    const s = this.requireSession(sessionId);
    const question = boundedText(questionIn, "question", MAX_QUESTION_CHARS);
    const options = Array.isArray(optionsIn) ? optionsIn.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, MAX_OPTION_CHARS)).slice(0, 6) : [];
    const d: DecisionRequest = { id: newId("dec"), sessionId, taskId: s.taskId, topicId: s.topicId, question, options, state: "open", answer: null, createdAt: new Date().toISOString(), answeredAt: null };
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
    if (mail.fromTopicId) {
      const topic = this.store.getTopic(mail.fromTopicId);
      return `[AMO 留言] 来自专题「${topic?.title || "未命名专题"}」的会话「${from?.title || "会话"}」：\n\n${mail.text}`;
    }
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
    const r = to as Partial<{ kind: string; sessionId: string; taskId: string; topicId: string }> | null;
    if (r?.kind === "session" && typeof r.sessionId === "string") {
      this.requireSession(r.sessionId);
      return { kind: "session", sessionId: r.sessionId };
    }
    if (r?.kind === "task" && typeof r.taskId === "string") {
      this.requireTask(r.taskId);
      return { kind: "task", taskId: r.taskId };
    }
    if (r?.kind === "topic" && typeof r.topicId === "string") {
      this.requireTopic(r.topicId);
      return { kind: "topic", topicId: r.topicId };
    }
    throw new HostError("bad_request", "to must be { kind: \"session\", sessionId }, { kind: \"task\", taskId } or { kind: \"topic\", topicId }");
  }

  // Canvas: one per topic, holding that topic's tasks.

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
    const errors = validateCanvas(doc, new Set(this.topicTasks(topicId).map((t) => t.id)));
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
  private leaveCanvas(topicId: Id, taskId: Id): void {
    const current = this.store.getCanvas(topicId);
    if (!current || !current.nodes.some((n) => n.kind === "task" && n.taskId === taskId)) return;
    const next: CanvasDoc = { ...removeTask(current, taskId), version: current.version + 1, updatedAt: new Date().toISOString() };
    this.store.putCanvas(next);
    this.publish({ type: "canvas.updated", canvas: next });
  }

  // Canvas changes asked for by agents (AMO MCP): structure only, Studio lays out.

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

  private async startSession(owner: { taskId: Id | null; topicId: Id | null }, workspace: Workspace, input: NewSessionInput): Promise<Session> {
    const session = await this.wrap(() =>
      this.runtime.startSession({ ...owner, profileId: input.profileId, workspace, ...(input.text ? { text: input.text } : {}), options: sessionOptions(input.options) }),
    );
    // The owner's updatedAt moves with its sessions so the board can sort by activity.
    if (owner.taskId) this.publish({ type: "task.upserted", task: this.store.updateTask(owner.taskId, {}) });
    else if (owner.topicId) this.publish({ type: "topic.upserted", topic: this.store.updateTopic(owner.topicId, {}) });
    return session;
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
    if (task.workspaceId !== workspaceId) throw new HostError("bad_request", "a task takes presets from its own workspace");
    const pack = this.packs(workspaceId).find((p) => p.dirName === packName);
    if (!pack?.manifest) throw new HostError(pack ? "bad_request" : "not_found", pack ? `扩展包 ${packName} 有错误` : `扩展包 ${packName} 不存在`);
    const preset = pack.manifest.presets.find((p) => p.id === presetId);
    if (!preset) throw new HostError("not_found", `扩展包 ${packName} 里没有启动预设 ${presetId}`);
    // {{pack.dir}} is relative to the workspace (sessions run there), with forward slashes: short and the same on every OS.
    return presetDraft({ preset, packDir: `${PACKS_DIR}/${pack.dirName}`, workspace, taskTitle: task.title, profileIds: this.profiles.map((p) => p.id) });
  }

  /** A template of a valid pack in the task's own workspace. */
  private packTemplate(workspaceId: Id, choice: TaskTemplateChoice): PackTemplate {
    const c = choice as Partial<TaskTemplateChoice> | null;
    if (!c || typeof c.workspaceId !== "string" || typeof c.pack !== "string" || typeof c.template !== "string") throw new HostError("bad_request", "template needs workspaceId, pack and template");
    if (c.workspaceId !== workspaceId) throw new HostError("bad_request", "a task takes templates from its own workspace");
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

  requireTopic(id: Id): Topic {
    const t = this.store.getTopic(id);
    if (!t) throw new HostError("not_found", `topic ${id} not found`);
    return t;
  }

  private requireLiveTopic(id: Id): Topic {
    const t = this.requireTopic(id);
    if (t.archivedAt) throw new HostError("read_only", `topic ${t.title} is archived`);
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
