// Core entities shared by Host, app and UI. See docs/next-gen-vision-architecture-2026-10.md and
// studio/design/interaction-notes.md for the meaning of each state.

export type Id = string;
/** ISO-8601 timestamp. */
export type Timestamp = string;

/**
 * A project folder on this machine ("项目"). The common space is a built-in workspace (`builtin: "common"`): tasks and
 * sessions with no project picked run in its folder, and the UI never lists it as a project (design/structure.md).
 */
export interface Workspace {
  id: Id;
  name: string;
  /** Absolute path of the project directory. */
  path: string;
  builtin?: "common";
  createdAt: Timestamp;
}

/** Board columns. Moved by the person only; agents never move cards. */
export const TASK_COLUMNS = ["todo", "doing", "review", "done"] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

/**
 * A task runs in exactly one workspace (the common space when no project was picked; fixed once it has sessions) and
 * sits in at most one topic. See design/structure.md for the rules.
 */
export interface Task {
  id: Id;
  /** Empty until named; the UI falls back to the first user message. */
  title: string;
  workspaceId: Id;
  /** The topic it belongs to; null when it is in none. */
  topicId: Id | null;
  column: TaskColumn;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Archived with its topic (or on its own); read-only while set. */
  archivedAt: Timestamp | null;
}

/**
 * 专题: the level above tasks. Groups tasks (possibly from several projects) on its own canvas and has its own
 * sessions for coordinating them. Archiving a topic archives its tasks and sessions.
 */
export interface Topic {
  id: Id;
  title: string;
  /** Projects added by hand; the topic's projects are these plus its tasks' workspaces. */
  workspaceIds: Id[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
}

export type SessionRuntime = "codex" | "claude";
export type SessionKind = "main" | "fork" | "sub";

/** Updated automatically from runtime events; independent from the task column. */
export const SESSION_STATUSES = ["running", "awaiting-approval", "awaiting-review", "idle", "completed", "error"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Who may write to the session.
 * - workbench: only Studio is attached
 * - terminal-shared: a Codex TUI is attached to the same app-server; both sides can write
 * - terminal-handoff: handed to a terminal (Claude); Studio is read-only until reclaimed
 * - archived: read-only
 */
export type WriterState = "workbench" | "terminal-shared" | "terminal-handoff" | "archived";

export interface ModelProfile {
  id: Id;
  label: string;
  runtime: SessionRuntime;
  /** Codex: the model_provider id defined at app-server launch (null = the user's own Codex config). Claude: the provider preset id. */
  provider: string | null;
  /** null = whatever the runtime's own config selects. */
  model: string | null;
  reasoningEffort?: string;
  /** Credential Manager entry `AgentMonitorOverlay/model-provider/<credentialId>`; absent for subscription logins. */
  credentialId?: string;
}

/**
 * A session's choices on top of its profile, as each CLI offers them: the model, the reasoning effort and the
 * permissions (ids from the profile's `ProfileChoices`). Absent fields use the profile's defaults.
 */
export interface SessionOptions {
  model?: string;
  effort?: string;
  permission?: string;
}

/**
 * Every session has exactly one owner: a task or a topic (never both, never none). Forks and subagents keep their
 * parent's owner; the owner never changes.
 */
export interface Session {
  id: Id;
  /** Owner when the session belongs to a task. */
  taskId: Id | null;
  /** Owner when the session belongs to a topic (a 专题会话). */
  topicId: Id | null;
  /** Parent session for forks and subagents; null for main sessions. */
  parentId: Id | null;
  kind: SessionKind;
  runtime: SessionRuntime;
  profileId: Id;
  /** A task session runs in its task's workspace; a topic session in any of the topic's projects or the common space. */
  workspaceId: Id;
  title: string;
  status: SessionStatus;
  writer: WriterState;
  /** Codex thread id or Claude session id; null until the runtime has created it. */
  runtimeRef: string | null;
  /** Model, effort and permissions chosen for this session (switchable while it lives). */
  options: SessionOptions;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
}

/**
 * Pointer back to the runtime event an item was derived from, without copying the payload. `turnId` also ties an
 * item to its turn (the `turn` item with the same id carries the turn's timing and usage).
 */
export interface RawRef {
  runtime: SessionRuntime;
  method: string;
  itemId?: string;
  turnId?: string;
}

interface ItemBase {
  id: Id;
  sessionId: Id;
  /** Monotonic per session; the store assigns it on append. */
  seq: number;
  createdAt: Timestamp;
  raw?: RawRef;
}

export type ApprovalKind = "command" | "fileChange" | "permissions";
/** `resolved-elsewhere`: another client (e.g. the attached TUI) answered first. */
export type ApprovalState = "pending" | "accepted" | "declined" | "resolved-elsewhere";
export type ToolStatus = "running" | "completed" | "failed" | "declined";
/** What a tool call did, for its row's icon, title and the activity summary of its group. */
export type ToolKind = "command" | "read" | "search" | "list" | "edit" | "web" | "mcp" | "subagent" | "plan" | "review" | "other";

/** One file touched by an edit, with a unified diff when the runtime gave one. */
export interface FileDiff {
  path: string;
  change: "add" | "delete" | "update";
  added: number;
  removed: number;
  diff?: string;
}

export type TurnState = "running" | "completed" | "failed" | "interrupted";

/** Token usage of one turn (all model calls in it). */
export interface TurnUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  /** The model's largest context, when the runtime tells. */
  contextWindow?: number;
  /** Tokens in the context after the turn's latest model call (its input plus output). */
  context?: number;
}

export interface ToolFields {
  name: string;
  summary: string;
  /** Output (a command's stdout/stderr, a tool's result), trimmed to its tail. */
  detail?: string;
  status: ToolStatus;
  kind?: ToolKind;
  /** The call's arguments as text (JSON for MCP and generic tools). */
  input?: string;
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
  files?: FileDiff[];
}

export type SessionItem =
  | (ItemBase & { type: "user"; text: string })
  | (ItemBase & { type: "agent"; markdown: string; streaming: boolean })
  /** The model's thinking before or between steps. */
  | (ItemBase & { type: "reasoning"; text: string; streaming: boolean; durationMs?: number })
  | (ItemBase & { type: "tool" } & ToolFields)
  /** Metadata of one turn (not shown as a row): when it ran, how it ended, what it used. */
  | (ItemBase & { type: "turn"; turnId: string; state: TurnState; startedAt: Timestamp; endedAt?: Timestamp; usage?: TurnUsage; error?: string })
  | (ItemBase & { type: "approval"; approvalId: string; kind: ApprovalKind; summary: string; detail?: string; state: ApprovalState })
  | (ItemBase & { type: "subagent"; childSessionId: Id; summary: string })
  | (ItemBase & { type: "error"; message: string })
  | (ItemBase & { type: "notice"; level: "info" | "warning"; message: string });

export type SessionItemType = SessionItem["type"];

/** Anchored note on a span of an agent reply, collected and sent back as one user message. */
export interface Annotation {
  id: Id;
  sessionId: Id;
  itemId: Id;
  /** The selected text, kept so the anchor survives re-rendering. */
  quote: string;
  /** Character offsets into the item's markdown source (LF-normalised). */
  start: number;
  end: number;
  /** Up to 24 characters before and after the quote, used to re-find it if the offsets no longer match. */
  prefix: string;
  suffix: string;
  note: string;
  createdAt: Timestamp;
  /** Set when sent back to the session as part of a summary message. */
  sentAt: Timestamp | null;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

/** A topic's infinite canvas. Coordinates are presentation only; structure lives in groups, nodes and edges. */
export interface CanvasDoc {
  /** The topic's id. */
  id: Id;
  /** Bumped on every save; a save must name the version it was based on (optimistic concurrency). */
  version: number;
  groups: CanvasGroup[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  updatedAt: Timestamp;
}

export interface CanvasGroup {
  id: Id;
  title: string;
  workspaceId: Id | null;
  rect: Rect;
}

/**
 * `task`: a task of the topic (at most one card each). `ref`: a reference card (S11-A) pointing at a task of another
 * topic or of none; the task keeps its own project and topic, and deleting the card never changes it.
 */
export type CanvasNode =
  | { id: Id; kind: "task"; taskId: Id; groupId: Id | null; pos: Point }
  | { id: Id; kind: "note"; text: string; groupId: Id | null; pos: Point }
  | { id: Id; kind: "ref"; taskId: Id; groupId: Id | null; pos: Point };

/** `from` must be finished before `to` can start; both are task ids. */
export interface CanvasEdge {
  id: Id;
  kind: "depends";
  from: Id;
  to: Id;
}

/** Global todo, independent of workspaces until converted into a task. */
export interface TodoItem {
  id: Id;
  text: string;
  done: boolean;
  workspaceId: Id | null;
  /** Set once converted into a task. */
  taskId: Id | null;
  createdAt: Timestamp;
}

// Collaboration (stage 5): what sessions leave for people and for each other. Agents write these through the AMO
// MCP, scoped to the session that calls; people read and act on them in the workbench.

/** A progress note or handoff summary on a task. `sessionId` null: written by the person. */
export interface TaskNote {
  id: Id;
  taskId: Id;
  sessionId: Id | null;
  kind: "progress" | "handoff";
  text: string;
  createdAt: Timestamp;
}

/**
 * A scheduler's proposal to start work on a whole-picture todo (stage 7, design/scheduler.md). Nothing starts until the
 * person approves; approving turns the todo into a task and starts its first session with the prompt.
 */
export interface ScheduleProposal {
  id: Id;
  todoId: Id;
  workspaceId: Id;
  profileId: Id;
  prompt: string;
  reason: string;
  state: "pending" | "approved" | "rejected" | "expired";
  /** The scheduler session that proposed it; null when made through the API. */
  sessionId: Id | null;
  /** The task made on approval. */
  taskId: Id | null;
  createdAt: Timestamp;
  decidedAt: Timestamp | null;
}

/** One step of a task's checklist, from an extension pack's task template (stage 6). */
export interface ChecklistItem {
  id: Id;
  taskId: Id;
  position: number;
  text: string;
  done: boolean;
  /** Who ticked it: a session, or null for the person. */
  doneBySessionId: Id | null;
  doneAt: Timestamp | null;
  /** Where the step came from, e.g. "demo/gameplay" (pack/template). */
  source: string;
}

export type MailRecipient = { kind: "session"; sessionId: Id } | { kind: "task"; taskId: Id } | { kind: "topic"; topicId: Id };

/**
 * A message for another session or task. It never enters a conversation by itself: the person forwards it (or
 * dismisses it), or the recipient's agent reads it with `mailbox_read` on its next turn.
 */
export interface MailMessage {
  id: Id;
  /** null: from the person (e.g. the answer to a decision request). */
  fromSessionId: Id | null;
  fromTaskId: Id | null;
  /** Set when the sender is a topic session (absent on mail from before topics). */
  fromTopicId?: Id | null;
  to: MailRecipient;
  text: string;
  state: "unread" | "read" | "forwarded" | "dismissed";
  createdAt: Timestamp;
  /** When it was read, forwarded or dismissed. */
  handledAt: Timestamp | null;
}

/** A question an agent puts to the person; the answer goes back to the asking session as mail. */
export interface DecisionRequest {
  id: Id;
  sessionId: Id;
  /** The asking session's owner: its task, or its topic. */
  taskId: Id | null;
  topicId?: Id | null;
  question: string;
  options: string[];
  state: "open" | "answered" | "withdrawn";
  answer: string | null;
  createdAt: Timestamp;
  answeredAt: Timestamp | null;
}

/** Who owns a session. */
export type SessionOwner = { kind: "task"; taskId: Id } | { kind: "topic"; topicId: Id };

export function sessionOwner(s: Pick<Session, "taskId" | "topicId">): SessionOwner {
  if (s.taskId) return { kind: "task", taskId: s.taskId };
  if (s.topicId) return { kind: "topic", topicId: s.topicId };
  throw new Error("session has no owner");
}

/** Sessions with the same owner (a task's or a topic's). */
export const sameOwner = (a: Pick<Session, "taskId" | "topicId">, b: Pick<Session, "taskId" | "topicId">) =>
  (a.taskId ?? null) === (b.taskId ?? null) && (a.topicId ?? null) === (b.topicId ?? null);

/** One quota window of a subscription (e.g. GPT's 5-hour and weekly limits). */
export interface UsageWindow {
  /** "5 小时", "每周", "Opus 每周"… */
  label: string;
  /** 0–100; null when the account did not say. */
  usedPercent: number | null;
  resetsAt: Timestamp | null;
}

/** How much of a subscription is used: the person's own GPT (Codex login) or Claude (setup-token) account. */
export interface AccountUsage {
  profileId: Id;
  /** The account's name as the profiles show it ("GPT", "Claude"). */
  label: string;
  windows: UsageWindow[];
  /** Why there is nothing to show (not logged in, no conversation yet…). */
  note: string | null;
  /** When these numbers were read; null when never. */
  updatedAt: Timestamp | null;
}
