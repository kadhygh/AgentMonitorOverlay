// Host API: REST requests/responses and the WS event stream. Host listens on 127.0.0.1 only.
import type { AccountUsage, Annotation, CanvasDoc, ChecklistItem, ScheduleProposal, DecisionRequest, Id, MailMessage, MailRecipient, ModelProfile, TaskNote, TodoItem, Session, SessionItem, SessionOptions, Task, TaskColumn, Topic, Workspace } from "./entities.js";

export const HOST_DEFAULT_PORT = 47900;

export interface StateSnapshot {
  /** Includes the common space (`builtin: "common"`), which the UI does not list as a project. */
  workspaces: Workspace[];
  topics: Topic[];
  tasks: Task[];
  sessions: Session[];
  profiles: ModelProfile[];
  /** Last event sequence included in this snapshot; subscribe to the event stream after it. */
  eventSeq: number;
}

export interface NewSessionInput {
  profileId: Id;
  /** Topic sessions only: one of the topic's projects; the common space when omitted. Task sessions use the task's. */
  workspaceId?: Id;
  /** First user message; when present the session starts a turn right away. */
  text?: string;
  /** Model, effort and permissions; the profile's defaults otherwise. */
  options?: SessionOptions;
}

/** A model a profile can run, as its CLI lists it. */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  /** Reasoning efforts this model takes (CLI values: low, medium, high, xhigh, max…); empty when it has none. */
  efforts: string[];
  defaultEffort?: string;
  /** What the profile runs when no model is chosen. */
  isDefault?: boolean;
}

/** One permission setting, as the runtime's CLI names it. */
export interface PermissionOption {
  id: string;
  label: string;
  description: string;
  /** Set when it cannot work on this machine (e.g. a Codex sandbox mode under an unusable Windows sandbox). */
  unavailable?: string;
}

/** What a profile offers: its models (with efforts) and its permission settings. */
export interface ProfileChoices {
  profileId: Id;
  models: ModelOption[];
  permissions: PermissionOption[];
  defaultPermission: string;
  /** Where the model list came from ("cli", or "builtin" when the CLI could not be asked). */
  source: "cli" | "builtin";
}

/** A saved combination for one-click switching: a profile plus its model, effort and permissions. */
export interface SessionPreset {
  id: Id;
  name: string;
  profileId: Id;
  options: SessionOptions;
}

export type ApprovalDecision = "accept" | "decline";

export interface Scratchpad {
  text: string;
  /** Null until first saved. */
  updatedAt: string | null;
}

export interface NewAnnotationInput {
  itemId: Id;
  quote: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  note: string;
}

/** What "open in terminal" produced. The token travels only through the named env var, never in `command`. */
export interface TerminalAttach {
  command: string;
  envVar: string | null;
  /** False in test mode or when the caller asked only for the command. */
  launched: boolean;
}

/** A task template picked when creating a task: which workspace's pack, which template. */
export interface TaskTemplateChoice {
  workspaceId: Id;
  pack: string;
  template: string;
}

/** Studio-wide settings kept by the Host (the look of the UI is per install, in the UI itself). */
export interface StudioSettings {
  /**
   * The common space: the built-in workspace where tasks without a project, the scheduler and topic sessions without
   * a project run. Always present (by default `common/` in the data folder).
   */
  commonWorkspace: Workspace;
  /** 常用预设: shown next to the composer of sessions on the same profile. */
  presets: SessionPreset[];
}

/** A model credential the profiles use: whether it is stored, never its value. */
export interface CredentialStatus {
  id: string;
  /** The profiles that use it, e.g. "Claude 订阅". */
  usedBy: string[];
  saved: boolean;
  /** Only the Claude subscription token can be saved from Studio; API keys come from old AMO's settings. */
  writable: boolean;
}

/** Every REST route as `"METHOD /path"` with its request body and response. `:id` segments are path params. */
export interface HostRoutes {
  "GET /api/state": { req: void; res: StateSnapshot };
  "POST /api/workspaces": { req: { path: string; name?: string }; res: Workspace };
  "DELETE /api/workspaces/:id": { req: void; res: { ok: true } };
  "GET /api/settings": { req: void; res: StudioSettings };
  /**
   * Quota use of the subscriptions (GPT through the Codex login, Claude through its token). `?refresh=1` asks the
   * accounts now (GPT: may start its app-server); otherwise the last numbers read.
   */
  "GET /api/usage": { req: void; res: AccountUsage[] };
  /** `commonDir`: moves the common space to this folder (created if missing; it must not be a registered project). */
  "PUT /api/settings": { req: { commonDir?: string; presets?: SessionPreset[] }; res: StudioSettings };
  /** Models (with reasoning efforts) and permission settings of a profile, asked from its CLI. */
  "GET /api/profiles/:id/choices": { req: void; res: ProfileChoices };
  "GET /api/credentials": { req: void; res: CredentialStatus[] };
  /** Saves a writable credential (the Claude subscription token) in the Windows Credential Manager. */
  "PUT /api/credentials/:id": { req: { secret: string }; res: CredentialStatus[] };
  "DELETE /api/credentials/:id": { req: void; res: CredentialStatus[] };
  /** Extension packs in the workspace's `.amo/packs`, valid or not (design/pack-format.md). */
  "GET /api/workspaces/:id/packs": { req: void; res: import("./packs.js").WorkspacePack[] };
  "GET /api/workspaces/:id/packs/:pack/docs/:doc": { req: void; res: import("./packs.js").PackDocContent };
  /** Fills a pack's session preset in for a task; nothing is started (the person confirms in the new-session form). */
  "POST /api/workspaces/:id/packs/:pack/presets/:preset/draft": { req: { taskId: Id }; res: import("./packs.js").PresetDraft };
  /**
   * `workspaceId` null or absent: the common space. `topicId`: put it in that topic. Without `firstSession` the task is
   * only filed (column `todo` unless given); with it, the first session starts. `template`: a task template from an
   * extension pack; the task gets its title prefix and its steps as a checklist.
   */
  "POST /api/tasks": {
    req: { title?: string; workspaceId?: Id | null; topicId?: Id | null; column?: TaskColumn; firstSession?: NewSessionInput; template?: TaskTemplateChoice };
    res: { task: Task; session: Session | null };
  };
  /**
   * `workspaceId` (null: the common space) only while the task has no sessions. `topicId` moves the task to another
   * topic or out of its topic (null); its place, group and dependencies on the old topic's canvas are removed.
   */
  "PATCH /api/tasks/:id": { req: { title?: string; column?: TaskColumn; workspaceId?: Id | null; topicId?: Id | null }; res: Task };
  /** Archives the task and all its sessions; returns the task. */
  "POST /api/tasks/:id/archive": { req: void; res: Task };
  "POST /api/tasks/:id/unarchive": { req: void; res: Task };
  "POST /api/topics": { req: { title: string; workspaceIds?: Id[] }; res: Topic };
  "PATCH /api/topics/:id": { req: { title?: string; workspaceIds?: Id[] }; res: Topic };
  /** Archives the topic with its sessions and all its tasks (and their sessions). */
  "POST /api/topics/:id/archive": { req: void; res: { topic: Topic; tasks: Task[] } };
  /** Restores the topic and the tasks that were archived with it. */
  "POST /api/topics/:id/unarchive": { req: void; res: { topic: Topic; tasks: Task[] } };
  /** A topic session (专题会话): coordinates the topic's tasks; runs in one of its projects or the common space. */
  "POST /api/topics/:id/sessions": { req: NewSessionInput; res: Session };
  "POST /api/tasks/:id/sessions": { req: NewSessionInput; res: Session };
  "GET /api/sessions/:id/items": { req: void; res: SessionItem[] };
  /** Starts a turn when idle, steers the running turn otherwise. */
  /** `queue`: a Claude session was mid-turn; the message runs as the next turn. Codex steers the running turn instead. */
  "POST /api/sessions/:id/messages": { req: { text: string }; res: { mode: "start" | "steer" | "queue" } };
  "POST /api/sessions/:id/interrupt": { req: void; res: { ok: true } };
  "POST /api/sessions/:id/fork": { req: { profileId?: Id }; res: Session };
  /** Switches the session's model, effort or permissions (null clears back to the default). Codex: from the next turn. */
  /** Renames the session in its runtime too (Codex thread name, Claude session title). */
  "PATCH /api/sessions/:id": { req: { title: string }; res: Session };
  "PATCH /api/sessions/:id/options": { req: { model?: string | null; effort?: string | null; permission?: string | null }; res: Session };
  /** Archives the session together with its forks and subagents; returns every session changed. */
  "POST /api/sessions/:id/archive": { req: void; res: Session[] };
  "POST /api/sessions/:id/unarchive": { req: void; res: Session[] };
  "POST /api/sessions/:id/terminal": { req: { launch: boolean }; res: TerminalAttach };
  "POST /api/sessions/:id/reclaim": { req: void; res: Session };
  "POST /api/approvals/:approvalId": { req: { sessionId: Id; decision: ApprovalDecision }; res: { ok: true } };
  "GET /api/sessions/:id/annotations": { req: void; res: Annotation[] };
  "POST /api/sessions/:id/annotations": { req: NewAnnotationInput; res: Annotation };
  "PATCH /api/annotations/:id": { req: { note: string }; res: Annotation };
  "DELETE /api/annotations/:id": { req: void; res: { ok: true } };
  /** Sends every unsent annotation of the session as one user message, in reply order, then marks them sent. */
  "POST /api/sessions/:id/annotations/send": { req: void; res: { mode: "start" | "steer" | "queue"; sent: Annotation[] } };
  /** The global scratchpad (interaction-notes: one shared draft area until the user asks for per-task ones). */
  "GET /api/scratchpad": { req: void; res: Scratchpad };
  "PUT /api/scratchpad": { req: { text: string }; res: Scratchpad };
  /** Whole-picture todos (global, not tied to a task until converted in stage 7). */
  "GET /api/todos": { req: void; res: TodoItem[] };
  "POST /api/todos": { req: { text: string; workspaceId?: Id | null }; res: TodoItem };
  "PATCH /api/todos/:id": { req: { text?: string; done?: boolean; workspaceId?: Id | null }; res: TodoItem };
  "DELETE /api/todos/:id": { req: void; res: { ok: true } };
  /**
   * Turns a todo into a task (in its workspace unless one is given) with one session; `text` starts it, otherwise no
   * model is called. With `topicId` (converted on a topic's canvas) the task joins that topic, in the group bound to
   * its workspace if the canvas has one. The todo is marked done.
   */
  "POST /api/todos/:id/convert": { req: { workspaceId?: Id; profileId: Id; text?: string; topicId?: Id }; res: { todo: TodoItem; task: Task; session: Session } };
  /** Progress notes and handoff summaries on a task, oldest first. The person can add notes too. */
  "GET /api/tasks/:id/notes": { req: void; res: TaskNote[] };
  "POST /api/tasks/:id/notes": { req: { text: string }; res: TaskNote };
  /**
   * Mail, filtered by `?sessionId=`, `?taskId=`, `?topicId=` (any matches) and `?state=` (comma separated);
   * `?forTask=` / `?forTopic=` give everything left for a task or topic or any of its own sessions.
   */
  "GET /api/mail": { req: void; res: MailMessage[] };
  "POST /api/mail": { req: { to: MailRecipient; text: string }; res: MailMessage };
  "PATCH /api/mail/:id": { req: { state: "read" | "dismissed" }; res: MailMessage };
  /** Puts the message into a session's conversation as a user message; for mail to a task, name the session. */
  "POST /api/mail/:id/forward": { req: { sessionId?: Id }; res: MailMessage };
  /** Decision requests, `?state=open` for the pending ones. */
  "GET /api/decisions": { req: void; res: DecisionRequest[] };
  /** Answers a decision; the answer goes back to the asking session as mail. */
  "POST /api/decisions/:id/answer": { req: { answer: string }; res: DecisionRequest };
  /** Checklist items, `?taskId=` for one task; ordered by task, then position. */
  "GET /api/checklist": { req: void; res: ChecklistItem[] };
  "PATCH /api/checklist/:id": { req: { done: boolean }; res: ChecklistItem };
  /** One scheduler round, started by the person: a session in the "调度" task that may only propose. */
  "POST /api/scheduler/run": { req: { profileId: Id }; res: { task: Task; session: Session } };
  /** Scheduler proposals, `?state=pending` for the ones waiting for the person. */
  "GET /api/proposals": { req: void; res: ScheduleProposal[] };
  "POST /api/proposals": { req: { todoId: Id; workspaceId?: Id; profileId: Id; prompt: string; reason?: string }; res: ScheduleProposal };
  /** Approves (optionally with an edited prompt or model): the todo becomes a task and its first session starts. */
  "POST /api/proposals/:id/approve": { req: { prompt?: string; profileId?: Id }; res: { proposal: ScheduleProposal; task: Task; session: Session } };
  "POST /api/proposals/:id/reject": { req: void; res: ScheduleProposal };
  /** A topic's canvas. */
  "GET /api/topics/:id/canvas": { req: void; res: CanvasDoc };
  /** Saves the whole canvas. `version` must equal the stored one (409 otherwise); the response carries the new one. */
  "PUT /api/topics/:id/canvas": { req: CanvasDoc; res: CanvasDoc };
  /** Structure without coordinates, for agents (`canvas_read`) and the "agent 视角" tab. */
  "GET /api/topics/:id/canvas/outline": { req: void; res: { outline: string; json: import("./canvas.js").CanvasOutline } };
}

export type HostRoute = keyof HostRoutes;
export type RouteRequest<R extends HostRoute> = HostRoutes[R]["req"];
export type RouteResponse<R extends HostRoute> = HostRoutes[R]["res"];

export interface HostErrorBody {
  error: { code: HostErrorCode; message: string };
}
export type HostErrorCode = "bad_request" | "not_found" | "conflict" | "read_only" | "runtime_error" | "internal";

/** Events on `ws://127.0.0.1:<port>/api/events?since=<eventSeq>`. `seq` is global and monotonic. */
export type HostEvent = { seq: number } & (
  | { type: "workspace.upserted"; workspace: Workspace }
  | { type: "workspace.removed"; workspaceId: Id }
  | { type: "task.upserted"; task: Task }
  | { type: "topic.upserted"; topic: Topic }
  | { type: "session.upserted"; session: Session }
  | { type: "item.appended"; item: SessionItem }
  /** Full replacement, e.g. a finished agent message or an approval that changed state. */
  | { type: "item.updated"; item: SessionItem }
  /** Streaming text appended to an agent item; not persisted as a separate event. */
  | { type: "item.delta"; sessionId: Id; itemId: Id; append: string }
  | { type: "annotation.upserted"; annotation: Annotation }
  | { type: "annotation.removed"; sessionId: Id; annotationId: Id }
  | { type: "scratchpad.updated"; scratchpad: Scratchpad }
  | { type: "canvas.updated"; canvas: CanvasDoc }
  | { type: "todo.upserted"; todo: TodoItem }
  | { type: "todo.removed"; todoId: Id }
  | { type: "task.note.added"; note: TaskNote }
  | { type: "mail.upserted"; mail: MailMessage }
  | { type: "decision.upserted"; decision: DecisionRequest }
  | { type: "checklist.upserted"; item: ChecklistItem }
  | { type: "proposal.upserted"; proposal: ScheduleProposal }
  | { type: "settings.updated"; settings: StudioSettings }
);

export type HostEventType = HostEvent["type"];

/** Longest quote kept in a summary message; the rest is elided. */
export const ANNOTATION_QUOTE_LIMIT = 300;

/**
 * The user message that sends annotations back to a session. Shared by Host (sending) and UI (preview).
 * Annotations must already be in reply order.
 */
export function composeAnnotationMessage(annotations: ReadonlyArray<{ quote: string; note: string }>): string {
  const parts = annotations.map((a) => {
    const quote = a.quote.length > ANNOTATION_QUOTE_LIMIT ? `${a.quote.slice(0, ANNOTATION_QUOTE_LIMIT)}…` : a.quote;
    const quoted = quote.split("\n").map((line) => `> ${line}`).join("\n");
    return `${quoted}\n${a.note.trim()}`;
  });
  return `针对你上面的回复，我有 ${annotations.length} 条批注：\n\n${parts.join("\n\n")}`;
}
