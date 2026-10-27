// Core entities shared by Host, app and UI. See docs/next-gen-vision-architecture-2026-10.md and
// studio/design/interaction-notes.md for the meaning of each state.
import type { QuestionFields } from "./questions.js";

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
  /** Set while the project is archived: hidden from every list, its tasks archived with it. */
  archivedAt?: Timestamp;
  /** The person's note on the project (编辑项目); agents read it through project_context. */
  description?: string;
}

/** Board columns. Moved by the person; Studio itself moves 进行中 ⇄ 待审阅 as sessions stop and start (TasksFeature.watchColumns); agents never move cards. */
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
  /** What the task is about (2026-10-17): on its canvas card and task page; the person and agents write it (TASK_DESCRIPTION_MAX). */
  description?: string;
  /**
   * 主控 (stage 16, from the stage 15 design): the person marks a task as the one that coordinates its topic (or its
   * project when it is in none). Its sessions get the 主控 role card and may propose tasks and relay messages.
   */
  lead?: boolean;
  /** 主控传话不用确认 (stage 16): a 主控's relays go into this task's session without asking the person. */
  relayAuto?: boolean;
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
  /** The person's note on what the topic is about (编辑专题); agents read it with the topic. */
  description?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
}

/** `dsh`: DeepSeek through a DeepSeek Harness source clone over ACP (stage 17, plans/stage-17-dsh.md). */
export type SessionRuntime = "codex" | "claude" | "dsh";
/** How the runtime is named next to a profile ("Codex · DeepSeek", "DSH · DeepSeek"). */
export const RUNTIME_LABELS: Record<SessionRuntime, string> = { codex: "Codex", claude: "Claude", dsh: "DSH" };
export type SessionKind = "main" | "fork" | "sub";

/**
 * Updated automatically from runtime events; independent from the task column. `awaiting-answer`: the agent asked the
 * person a question (or for a plan review) and waits (stage 12).
 */
export const SESSION_STATUSES = ["running", "awaiting-approval", "awaiting-answer", "awaiting-review", "idle", "completed", "error"] as const;
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
  /** Left out of the model pickers (设置 → 模型); its sessions keep working. */
  hidden?: boolean;
  /** One of the person's own channels (设置 → 模型 → 添加渠道), not built in. */
  custom?: boolean;
  /** Its site can be asked for the balance (`GET /api/profiles/:id/balance`). */
  balance?: boolean;
  /**
   * Why the profile cannot start sessions now (a DSH profile while no DSH clone is set up in 设置 → 模型); left out of
   * the model pickers meanwhile, its sessions stay readable.
   */
  unavailable?: string;
}

/**
 * A session's choices on top of its profile, as each CLI offers them: the model, the reasoning effort and the
 * permissions (ids from the profile's `ProfileChoices`). Absent fields use the profile's defaults.
 */
export interface SessionOptions {
  model?: string;
  effort?: string;
  permission?: string;
  /**
   * Codex: run at the model's fast speed tier (stage 13, 「Fast」; `ModelOption.fast`). Absent = never chosen (the
   * person's own Codex config applies); false = chosen off (standard speed is sent). Ignored by other runtimes.
   */
  fast?: boolean;
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
  /**
   * 委派 (2026-10-22): the session of the same task that started this main session with session_start. It stays a main
   * session in every way (archived on its own, takes relays); only the session list shows it under that one. Absent: none.
   */
  startedBy?: Id;
  /**
   * session_start with report (2026-10-22): the session each of its turns is reported to when it ends — its last reply,
   * that it was stopped, or its error. Absent: none.
   */
  reportTo?: Id;
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
  /** What starts the session's next turn without the person (Claude: its /loop, a usage limit); absent = nothing. */
  wake?: SessionWake | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
}

/**
 * A Claude session that goes on by itself (stage 15, 2026-10-16). Studio keeps its Claude Code process while this is
 * set, so the CLI's own timers (ScheduleWakeup, its wait at a usage limit) are not lost to the idle close.
 */
export interface SessionWake {
  /** The agent's /loop: its latest ScheduleWakeup. Cleared when the loop stops (or the person stops it). */
  loop?: {
    /** When the wakeup fires. */
    at: Timestamp;
    /** The reason the agent gave. */
    reason: string;
    /** The prompt the wakeup sends (the /loop command); Studio sends it itself when the Claude Code process is gone. */
    prompt: string;
  };
  /** The last turn stopped at a claude.ai usage limit. Cleared when a turn starts again. */
  limit?: {
    /** When the limit resets; null when the CLI did not say. */
    resetsAt: Timestamp | null;
    /** The CLI's message ("You've hit your session limit · resets …"). */
    message: string;
    /**
     * Studio sends a message to go on a little after the reset, unless the CLI has gone on by itself. On by default in a
     * loop; the person switches it in the conversation.
     */
    autoContinue: boolean;
  };
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

/**
 * Generation of a turn's model calls, for its speed (as DSH measures it): per call, the time from its first output
 * token to its end, and its output tokens; summed. Waiting for the first token, tools and approvals are not in it.
 */
export interface TurnDecode {
  ms: number;
  tokens: number;
  /**
   * How `ms` was measured. Absent: from each call's first output token to its end (generation only). "request"
   * (2026-10-27, Claude subagents, whose stream Studio does not get): from the call's request to its last block, so it
   * includes the wait for the first token and reads lower.
   */
  basis?: "request";
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
  /**
   * What the call is doing now (stage 12, S12-E): an MCP tool's progress message, input sent to a running command, a
   * retry; or, once done, the CLI's one-line summary of it.
   */
  progress?: string;
  /** Images the call showed (an image file read, viewed or generated), by path. */
  images?: MessageImage[];
}

/** The runtime is retrying a model request that failed (overloaded, disconnected…); cleared once it goes on. */
export interface TurnRetry {
  attempt: number;
  /** Most attempts it will make, when known. */
  max?: number;
  reason: string;
}

export type BackgroundState = "running" | "completed" | "failed" | "stopped";

/**
 * An image on a person's message: `id` is set when it is a Studio attachment (the UI loads it from the Host); an image
 * the runtime reported by path only (e.g. sent from the TUI) has `id: null`.
 */
export interface MessageImage {
  id: Id | null;
  path: string;
}

/**
 * What a notice offers to do (2026-10-23). `folder-access`: DSH's write sandbox cannot be set up on the session's
 * folder for want of the person's full control of it; POST /api/sessions/:id/folder-access gives it. `state` follows
 * the fix (the row is updated in place).
 */
export type NoticeAction = { kind: "folder-access"; path: string; state: "offered" | "running" | "done" | "failed" };

/**
 * A project folder as DSH's write sandbox needs it (设置 → 项目与目录 → DSH 沙箱权限, 2026-10-23). Setting it up
 * gives the person inherited full control (so DSH can label the folder and pass its grant on), labels it Low ahead of
 * DSH, and sets every .exe in it back to Medium (a program started from a Low file runs at Low integrity; new files
 * inherit Low wherever they come from, so builds need a new scan).
 *
 * `state`: `ready` — set up by Studio and the person still has inherited full control; `unprepared` — not (yet);
 * `unknown` — its permissions could not be read; `running` — a setup or scan runs (`job`); `failed` — the last one
 * failed (`error`). `fullControl`/`labelled` are what was read; `exes`/`scannedAt` the last scan; `backup` where the
 * last setup saved the old permissions.
 */
export interface FolderAccessStatus {
  workspaceId: Id;
  name: string;
  path: string;
  state: "ready" | "unprepared" | "unknown" | "running" | "failed";
  job?: "setup" | "scan" | "revert";
  fullControl?: boolean;
  labelled?: boolean;
  exes?: number;
  scannedAt?: string;
  error?: string;
  backup?: string;
}

export type SessionItem =
  /** `images`: pictures sent with the message (stage 11). */
  | (ItemBase & { type: "user"; text: string; images?: MessageImage[] })
  | (ItemBase & { type: "agent"; markdown: string; streaming: boolean })
  /** The model's thinking before or between steps. */
  | (ItemBase & { type: "reasoning"; text: string; streaming: boolean; durationMs?: number })
  | (ItemBase & { type: "tool" } & ToolFields)
  /** Metadata of one turn (not shown as a row): when it ran, how it ended, what it used. */
  | (ItemBase & { type: "turn"; turnId: string; state: TurnState; startedAt: Timestamp; endedAt?: Timestamp; usage?: TurnUsage; decode?: TurnDecode; error?: string; retry?: TurnRetry })
  | (ItemBase & { type: "approval"; approvalId: string; kind: ApprovalKind; summary: string; detail?: string; state: ApprovalState })
  /** A question to the person, a form, or a plan to review (stage 12; see questions.ts). */
  | (ItemBase & { type: "question" } & QuestionFields)
  /** `usage`: what the agent spent over all its runs, when the runtime tells (Claude, 2026-10-17). */
  | (ItemBase & { type: "subagent"; childSessionId: Id; summary: string; usage?: TurnUsage })
  | (ItemBase & { type: "error"; message: string })
  /** `key`: notices with the same key (and runtime-repeated ones) update one row; `count` says how often it came. */
  | (ItemBase & { type: "notice"; level: "info" | "warning"; message: string; key?: string; count?: number; action?: NoticeAction })
  /**
   * The conversation's context was summarised to free room (stage 12, S12-E): Claude's compact_boundary, Codex's
   * contextCompaction. `beforeTokens`: the context before it, when known.
   */
  | (ItemBase & { type: "compaction"; state: "running" | "completed" | "failed"; trigger?: "manual" | "auto"; beforeTokens?: number; afterTokens?: number; error?: string })
  /** Output of a CLI command that ran without the model (Claude's /cost, /context…). */
  | (ItemBase & { type: "command"; name: string; output: string })
  /**
   * A command the agent left running in the background (Claude's background Bash). Not a row of its own: the composer
   * lists the running ones; `outputFile` is where the CLI writes its output.
   */
  | (ItemBase & { type: "background"; taskId: string; command: string; description?: string; state: BackgroundState; startedAt: Timestamp; endedAt?: Timestamp; outputFile?: string; summary?: string })
  /** A predicted next message from the person (Claude's prompt suggestions), offered above the composer. */
  | (ItemBase & { type: "suggestion"; text: string });

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
  /** 批注 1, 2, … within the session, in the order they were made (2026-10-15); older ones have none. */
  n?: number;
  createdAt: Timestamp;
  /** Set when a message referenced it (last time). A sent one can be referenced again. */
  sentAt: Timestamp | null;
  /** Set while the person keeps it at the top of the panel (2026-10-19), sent or not. */
  pinnedAt?: Timestamp | null;
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
  /** 连线 (2026-10-19): lines drawn between any two cards, as on an Obsidian canvas; absent in older documents. */
  links?: CanvasLink[];
  updatedAt: Timestamp;
}

export interface CanvasGroup {
  id: Id;
  title: string;
  workspaceId: Id | null;
  rect: Rect;
  color?: CanvasColor;
}

/**
 * A topic's document (stage 16): what driving its tasks needs to know — plans, decisions, how the parts fit. Kept in
 * Studio; specialised documents stay in the projects (marked with 文件标记) and a topic document can point at them.
 */
export interface TopicDoc {
  id: Id;
  topicId: Id;
  title: string;
  /** Markdown. */
  body: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export const TOPIC_DOC_TITLE_MAX = 120;

/**
 * A 主控's proposal to split work into tasks (stage 16, from the stage 15 design: 主控 proposes, the person confirms).
 * Nothing is made until the person accepts it, possibly after changing the tasks; then Studio makes the tasks, puts
 * them on the topic's canvas with their dependencies, and tells the 主控 which tasks they became.
 */
export interface TaskPlan {
  id: Id;
  /** The topic the tasks go into (the 主控's topic); null when the 主控's task is in none (its project's board). */
  topicId: Id | null;
  fromSessionId: Id;
  fromTaskId: Id | null;
  /** What the split is for, in a few lines. */
  summary: string;
  tasks: PlannedTask[];
  state: "open" | "accepted" | "dismissed";
  createdAt: Timestamp;
  decidedAt: Timestamp | null;
  /** The person's note when dismissing (sent to the 主控). */
  note?: string;
  /** What accepting made: each planned task's key and the task it became. */
  created?: Array<{ key: string; taskId: Id }>;
}

export interface PlannedTask {
  /** The proposal's own name for it, for dependencies ("t1"). */
  key: string;
  title: string;
  workspaceId: Id;
  description?: string;
  /** The first message of its first session when it starts at once. */
  firstMessage?: string;
  /** The model profile to start it with. */
  profileId?: Id;
  /** A particular model of that profile and its effort (2026-10-26); dropped when the person picks another profile. */
  options?: { model?: string; effort?: string };
  /** Keys of the planned tasks that must finish first. */
  dependsOn: string[];
}
export const TASK_PLAN_MAX_TASKS = 20;

/**
 * 传话 (stage 16, from the stage 15 design): a 主控 asks Studio to say something in another task's session. The
 * person confirms it first (main window or Focus), unless the task takes relays without asking (relayAuto); then it
 * goes into that task's main session (queued while it runs; a new session when it has none).
 */
export interface Relay {
  id: Id;
  fromSessionId: Id;
  fromTaskId: Id | null;
  toTaskId: Id;
  text: string;
  state: "pending" | "delivered" | "dismissed" | "failed";
  createdAt: Timestamp;
  decidedAt: Timestamp | null;
  /** The session it went into. */
  sessionId?: Id;
  /** Why delivering failed. */
  error?: string;
}
export const RELAY_TEXT_MAX = 20_000;
export const TOPIC_DOC_BODY_MAX = 50_000;

/** The longest task description (characters). */
export const TASK_DESCRIPTION_MAX = 2000;

/** A mark on a canvas card, note or group (2026-10-17): its outline takes the colour; what it means is the person's. */
export type CanvasColor = "red" | "yellow" | "green" | "blue";
export const CANVAS_COLORS: ReadonlyArray<{ id: CanvasColor; label: string }> = [
  { id: "red", label: "红" },
  { id: "yellow", label: "黄" },
  { id: "green", label: "绿" },
  { id: "blue", label: "蓝" },
];
export const isCanvasColor = (v: unknown): v is CanvasColor => CANVAS_COLORS.some((c) => c.id === v);

/**
 * `task`: a task of the topic (at most one card each). `ref`: a reference card (S11-A) pointing at a task of another
 * topic or of none; the task keeps its own project and topic, and deleting the card never changes it.
 */
export type CanvasNode =
  | { id: Id; kind: "task"; taskId: Id; groupId: Id | null; pos: Point; color?: CanvasColor }
  | { id: Id; kind: "note"; text: string; groupId: Id | null; pos: Point; color?: CanvasColor }
  | { id: Id; kind: "ref"; taskId: Id; groupId: Id | null; pos: Point; color?: CanvasColor }
  | CanvasItem;

/** 审阅条目的状态 (画布审阅, 2026-10-27). */
export type ReviewStatus = "todo" | "confirmed" | "discuss" | "parked" | "done";
export const REVIEW_STATUSES: ReadonlyArray<{ id: ReviewStatus; label: string }> = [
  { id: "todo", label: "待看" },
  { id: "confirmed", label: "已确认" },
  { id: "discuss", label: "要讨论" },
  { id: "parked", label: "搁置" },
  { id: "done", label: "完成" },
];
export const isReviewStatus = (v: unknown): v is ReviewStatus => REVIEW_STATUSES.some((s) => s.id === v);
export const REVIEW_TITLE_MAX = 200;
export const REVIEW_BODY_MAX = 20_000;

/**
 * 审阅条目 (画布审阅, 2026-10-27): one point of a review an agent laid out on its topic's canvas (canvas_items_post),
 * numbered within the canvas. The person and agents change its status; an agent writes the conclusion. `threads`:
 * sessions started to talk this one point over (就这条展开聊).
 */
export interface CanvasItem {
  id: Id;
  kind: "item";
  /** #n on the canvas, never reused. */
  num: number;
  title: string;
  /** Markdown. */
  body?: string;
  status: ReviewStatus;
  conclusion?: string;
  /** Files, commits or links the point is about. */
  refs?: string[];
  /** The session that laid it out; null when the person made it. */
  sessionId: Id | null;
  threads?: Id[];
  groupId: Id | null;
  pos: Point;
  color?: CanvasColor;
}

/** 说明 (a remark the card is highlighted with) or 问题 (waits for the person's answer). */
export type CalloutKind = "note" | "question";
export const CALLOUT_TEXT_MAX = 2_000;
export const CALLOUT_DETAIL_MAX = 20_000;
export const CALLOUT_OPTIONS_MAX = 6;

/**
 * 画布气泡 (画布审阅, 2026-10-27): an agent's remark or question pinned to a card of its topic's canvas — the W3C Web
 * Annotation idea of a target, a body and a purpose. Kept beside the canvas document (not in it), so an agent's
 * bubbles never race the person's dragging for the canvas version.
 *
 * `target`: a task id (its card), or the id of an item, note, reference card or group. An answer goes to `sessionId` as
 * a message; the bubble then shows small (answered) until the agent or the person closes it.
 */
export interface CanvasCallout {
  id: Id;
  topicId: Id;
  target: Id;
  kind: CalloutKind;
  text: string;
  /** Markdown shown when it is opened. */
  detail?: string;
  /** Answers to pick from (a question only). */
  options?: string[];
  /** The agent finds it too involved for a short answer: the conversation is offered first. */
  deep?: boolean;
  /** Who wrote it; null when the person did. */
  sessionId: Id | null;
  state: "open" | "answered" | "closed";
  answer?: { text: string; at: Timestamp; /** How it reached the session; "none" when the session is gone. */ sent: "start" | "steer" | "queue" | "none" };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** `from` must be finished before `to` can start; both are task ids. */
export interface CanvasEdge {
  id: Id;
  kind: "depends";
  from: Id;
  to: Id;
}

/** Where a 连线 leaves or meets a card: the middle of one of its sides. */
export type CanvasSide = "top" | "right" | "bottom" | "left";
export const CANVAS_SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];
export const CANVAS_LINK_LABEL_MAX = 200;

/**
 * 连线 (2026-10-19): a line the person drew from one card (task, reference or note) to another, side to side, with an
 * arrow at `to` and an optional label. Unlike a dependency it means only what its label says.
 */
export interface CanvasLink {
  id: Id;
  /** Node ids (not task ids). */
  from: Id;
  fromSide: CanvasSide;
  to: Id;
  toSide: CanvasSide;
  label?: string;
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
