// Core entities shared by Host, app and UI. See docs/next-gen-vision-architecture-2026-10.md and
// studio/design/interaction-notes.md for the meaning of each state.

export type Id = string;
/** ISO-8601 timestamp. */
export type Timestamp = string;

export interface Workspace {
  id: Id;
  name: string;
  /** Absolute path of the project directory. */
  path: string;
  createdAt: Timestamp;
}

/** Board columns. Moved by the person only; agents never move cards. */
export const TASK_COLUMNS = ["todo", "doing", "review", "done"] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

/** A task belongs to one workspace, or to the cross-workspace area where each session picks its workspace. */
export type TaskScope = { kind: "workspace"; workspaceId: Id } | { kind: "area" };

export interface Task {
  id: Id;
  /** Empty until named; the UI falls back to the first user message. */
  title: string;
  scope: TaskScope;
  column: TaskColumn;
  createdAt: Timestamp;
  updatedAt: Timestamp;
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

export interface Session {
  id: Id;
  taskId: Id;
  /** Parent session for forks and subagents; null for main sessions. */
  parentId: Id | null;
  kind: SessionKind;
  runtime: SessionRuntime;
  profileId: Id;
  /** For cross-workspace tasks each session picks its workspace; otherwise the task's workspace. */
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
  contextWindow?: number;
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

/** Infinite canvas. Coordinates are presentation only; structure lives in groups, nodes and edges. */
export interface CanvasDoc {
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

export type CanvasNode =
  | { id: Id; kind: "task"; taskId: Id; groupId: Id | null; pos: Point }
  | { id: Id; kind: "note"; text: string; groupId: Id | null; pos: Point };

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

export type MailRecipient = { kind: "session"; sessionId: Id } | { kind: "task"; taskId: Id };

/**
 * A message for another session or task. It never enters a conversation by itself: the person forwards it (or
 * dismisses it), or the recipient's agent reads it with `mailbox_read` on its next turn.
 */
export interface MailMessage {
  id: Id;
  /** null: from the person (e.g. the answer to a decision request). */
  fromSessionId: Id | null;
  fromTaskId: Id | null;
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
  taskId: Id;
  question: string;
  options: string[];
  state: "open" | "answered" | "withdrawn";
  answer: string | null;
  createdAt: Timestamp;
  answeredAt: Timestamp | null;
}
