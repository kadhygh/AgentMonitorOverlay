// Host API: REST requests/responses and the WS event stream. Host listens on 127.0.0.1 only.
import type { AccountUsage, Annotation, FolderAccessStatus, CanvasDoc, ChecklistItem, ScheduleProposal, DecisionRequest, Id, MailMessage, MailRecipient, ModelProfile, TaskNote, TodoItem, Session, SessionItem, SessionOptions, Task, TaskColumn, TaskPlan, PlannedTask, Relay, Timestamp, Topic, TopicDoc, Workspace } from "./entities.js";

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
  /** Images uploaded with POST /api/attachments that go with the first message (2026-10-19). */
  attachments?: Id[];
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
  /**
   * Codex models with a fast speed tier (stage 13): the tier id to send (`priority`) and Codex's own note on it
   * ("2x speed, increased usage"). Absent when the model has none (DeepSeek, GLM, Claude).
   */
  fast?: { tier: string; description?: string };
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

/**
 * 设置 → 模型: the person's order of a profile's models (every picker lists them so) and what a new session gets when
 * nothing is chosen. Ids the CLI no longer offers are ignored.
 */
export interface ModelPrefs {
  order?: string[];
  model?: string;
  effort?: string;
  permission?: string;
}

/** A saved combination for one-click switching: a profile plus its model, effort and permissions. */
export interface SessionPreset {
  id: Id;
  name: string;
  profileId: Id;
  options: SessionOptions;
}

export type ApprovalDecision = "accept" | "decline";

/** One page of the scratchpad: its text and the images pasted into it (attachment ids, in order). */
export interface ScratchpadPage {
  text: string;
  attachments: string[];
}

/** The scratchpad (便签, stage 11): numbered pages shared by every window, kept by the Host. */
export interface Scratchpad {
  /** The pages shown; `pages.length` is the page count (1–9). */
  pages: ScratchpadPage[];
  /** Index into `pages` of the page every window shows. */
  activePage: number;
  /** Pages beyond the count that still hold something (1-based): lowering the count hides pages, never deletes them. */
  keptPages: number[];
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

/**
 * A file Studio keeps for a conversation or the scratchpad: an image pasted or dropped in, stored in the data folder
 * (`attachments/`), never in a project. `path` is where agents read it.
 */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  createdAt: string;
}

/** Image types Studio accepts as attachments. */
export const ATTACHMENT_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Largest attachment, in bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Features the person can turn off (设置 → 功能): their pages, panels and agent tools go away; their data stays. */
export type OptionalFeature = "packs" | "planning";

export const OPTIONAL_FEATURES: readonly { id: OptionalFeature; label: string; hint: string }[] = [
  { id: "packs", label: "扩展包", hint: "项目里 .amo/packs 的规范文档、任务模板和会话预设" },
  { id: "planning", label: "整体待办与调度", hint: "画布侧栏的整体待办、调度 agent 和它的提案" },
];

/** Studio-wide settings kept by the Host (the look of the UI is per install, in the UI itself). */
export interface StudioSettings {
  /**
   * The common space: the built-in workspace where tasks without a project, the scheduler and topic sessions without
   * a project run. Always present (by default `common/` in the data folder).
   */
  commonWorkspace: Workspace;
  /** 常用预设: shown next to the composer of sessions on the same profile. */
  presets: SessionPreset[];
  /** Optional features turned off. */
  disabledFeatures: OptionalFeature[];
  /** Global shortcut that shows and hides the scratchpad window, as an Electron accelerator; "" when off. */
  scratchpadShortcut: string;
  /**
   * 便签「复制」: true joins the lines into one with spaces (安全换行, for pasting into a terminal CLI); false (the
   * default) keeps the lines, with Windows line breaks.
   */
  scratchpadSafeNewlines: boolean;
  /** How the Claude subscription signs in (设置 → 模型); sessions keep the way they were started. */
  claudeLogin: ClaudeLogin;
  /** The person's own Claude Code config dir and whether it holds a login (null: cannot tell on this system). */
  claudeLocal: { dir: string; signedIn: boolean | null };
  /** Per profile id: model order and defaults (设置 → 模型). */
  modelPrefs: Record<string, ModelPrefs>;
  /** Per profile id: where its quota (subscription use or balance) shows (设置 → 额度); absent = the defaults. */
  quotaDisplay: Record<string, QuotaDisplay>;
  /**
   * 快速选择 (设置 → 模型): the model tiles of the new-task page, Quick Start and the new-session form, in order (Alt 1–6).
   * Empty: the models used last, then each profile's default.
   */
  quickModels: QuickModel[];
  /**
   * 自动压缩点 (设置 → 模型, 2026-10-17): the context size, in tokens, at which Claude and Codex sessions summarise their
   * conversation by themselves; null leaves it to each CLI (near the model's whole window).
   */
  autoCompactTokens: number | null;
  /** S18: channels (profile ids) with their own 自动压缩点, set on their page in 设置 → 模型; the rest use the above. */
  autoCompactProfiles: Record<string, AutoCompactChoice>;
  /** 项目分组 (2026-10-22): the left column's project groups, in order. */
  projectGroups: ProjectGroup[];
  /** 设置 → 子会话 (2026-10-26): notes on models as sub-sessions, for the main model. */
  subsessionNotes: SubsessionNote[];
}

/**
 * 项目分组 (2026-10-22): projects gathered under a name in the left column, only for the person to keep them in order
 * (unlike a topic, nothing else hangs on it and agents do not read it). A project is in at most one group.
 */
export interface ProjectGroup {
  id: Id;
  name: string;
  /** The person's own note; "" for none. */
  description: string;
  workspaceIds: Id[];
}

export const MAX_PROJECT_GROUPS = 50;

/** A channel's own 自动压缩点: tokens, or "cli" to leave it to the CLI. */
export type AutoCompactChoice = number | "cli";

/** The 自动压缩点 a channel's sessions get: its own, else the shared one; null = the CLI decides. */
export function autoCompactFor(s: Pick<StudioSettings, "autoCompactTokens" | "autoCompactProfiles">, profileId: string): number | null {
  const own = s.autoCompactProfiles?.[profileId];
  return own === "cli" ? null : (own ?? s.autoCompactTokens);
}

/** 自动压缩点 by default: the person's choice (2026-10-17), well below the 1M windows the CLIs would otherwise wait for. */
export const DEFAULT_AUTO_COMPACT_TOKENS = 272_000;
export const AUTO_COMPACT_MIN = 50_000;
export const AUTO_COMPACT_MAX = 1_000_000;

/** A profile and one of its models (null: the profile's default model). */
export interface QuickModel {
  profileId: Id;
  model: string | null;
}

export const MAX_QUICK_MODELS = 6;

/**
 * 设置 → 子会话 (2026-10-26): the person's note on a model as a sub-session — what it suits, how to brief it — for the
 * main model: in the role card (amo_whoami) and with 「@子会话N」. `model` null: the whole account (10-26: all its
 * models, a model's own note going before it).
 */
export interface SubsessionNote {
  profileId: Id;
  model: string | null;
  note: string;
}
export const MAX_SUBSESSION_NOTES = 30;
export const SUBSESSION_NOTE_MAX = 1000;

/** Where one account's quota shows: the bottom of the left column (default on) and the Focus window (default off). */
export interface QuotaDisplay {
  footer: boolean;
  focus: boolean;
}

export const DEFAULT_QUOTA_DISPLAY: QuotaDisplay = { footer: true, focus: false };

/** "token": the token from `claude setup-token`, Studio's own config dir. "local": the person's Claude Code login and ~/.claude. */
export type ClaudeLogin = "token" | "local";

/**
 * 设置 → 模型 (2026-10-24): the Claude Code that Claude sessions run on. The portable build ships none: the person's own
 * install is used, and without one the channels on Claude Code are `unavailable`. `source`: "bundled" = the copy that
 * comes with the SDK (a source checkout), "installed" = the person's, "env" = AMO_STUDIO_CLAUDE.
 */
export interface ClaudeCodeStatus {
  path: string | null;
  source: "bundled" | "installed" | "env" | null;
  version: string | null;
  /** The Claude Code version Studio's Agent SDK was built with. */
  sdkVersion: string | null;
  /** `version` is older than `sdkVersion`: some of what Studio asks of it may be missing. */
  outdated: boolean;
}

/** A model credential the profiles use: whether it is stored, never its value. */
/**
 * 设置 → 模型 → DeepSeek Harness (stage 17): the DSH source clone DeepSeek sessions run on. `built`: its CLI is built
 * (`apps/cli/lib/bin.js`). `check`: the last 「检查」 (starts DSH over ACP and opens a session, no model call).
 */
export interface DshStatus {
  /** Where DSH comes from (2026-10-26): "auto" = the desktop app when installed, else the clone; "clone" = the clone. */
  source: "auto" | "clone";
  /** The installed desktop app, if any. */
  desktop: { path: string; version: string | null } | null;
  /** Where the desktop app is looked for. */
  desktopDir: string | null;
  /** What sessions run on now; null when nothing usable (`unavailable` says why). */
  active: { kind: "desktop" | "clone"; version: string | null } | null;
  unavailable: string | null;
  /** The source clone's folder (used when source is "clone", or when no desktop app is installed). */
  path: string | null;
  version: string | null;
  /** Short hash and date of the clone's checked-out commit. */
  commit: string | null;
  commitDate: string | null;
  built: boolean;
  /** The Node that runs DSH and its version (DSH needs 22.19 or newer). */
  node: { path: string; version: string | null } | null;
  check: DshCheck | null;
}

export interface DshCheck {
  ok: boolean;
  at: Timestamp;
  /** What failed, or e.g. "可用 · ACP 1 · 3 个型号". */
  message: string;
  /** The version and commit it checked. */
  version: string | null;
  commit: string | null;
  /** Which DSH it checked (absent on checks from before 2026-10-26: the clone). */
  kind?: "desktop" | "clone";
}

export interface CredentialStatus {
  id: string;
  /** The profiles that use it, e.g. "Claude 订阅". */
  usedBy: string[];
  saved: boolean;
  /** Only the Claude subscription token can be saved from Studio; API keys come from old AMO's settings. */
  writable: boolean;
}

/** Whether git leaves a project's `.amo/` (its extension packs) out: by `.git/info/exclude`, a .gitignore or the global one. */
export interface GitExcludeState {
  /** The folder is in a git repository. */
  git: boolean;
  /** git ignores `.amo/` already. */
  excluded: boolean;
  /** The rule that does, as git names it (`.git/info/exclude:12`, `.gitignore:3`). */
  source: string | null;
  /** The line 一键忽略 adds to `.git/info/exclude`: `/.amo/`, or `/<sub>/.amo/` for a project inside a larger repository. */
  entry: string;
  /** Files under `.amo/` git tracks already; ignoring does not apply to them. */
  tracked: number;
}

/** Every REST route as `"METHOD /path"` with its request body and response. `:id` segments are path params. */
export interface HostRoutes {
  "GET /api/state": { req: void; res: StateSnapshot };
  "POST /api/workspaces": { req: { path: string; name?: string }; res: Workspace };
  "DELETE /api/workspaces/:id": { req: void; res: { ok: true } };
  /** 编辑项目: its name in Studio (the folder keeps its own) and its note; an empty note clears it. */
  "PATCH /api/workspaces/:id": { req: { name?: string; description?: string }; res: Workspace };
  /** Archives the project with all its tasks (and their sessions); the common space cannot be archived. */
  "POST /api/workspaces/:id/archive": { req: void; res: { workspace: Workspace; tasks: Task[] } };
  /** Restores the project and the tasks that were archived with it. */
  "POST /api/workspaces/:id/unarchive": { req: void; res: { workspace: Workspace; tasks: Task[] } };
  /** Whether git leaves the project's `.amo/` out. */
  "GET /api/workspaces/:id/git-exclude": { req: void; res: GitExcludeState };
  /** Adds `.amo/` to the repository's `.git/info/exclude` (this machine only; the project's .gitignore is not touched). */
  "POST /api/workspaces/:id/git-exclude": { req: void; res: GitExcludeState };
  "GET /api/settings": { req: void; res: StudioSettings };
  /** The Claude Code that Claude sessions run on (2026-10-24). */
  "GET /api/claude-code": { req: void; res: ClaudeCodeStatus };
  /** Looks for it again (e.g. just installed); the channels on Claude Code follow (`profiles.updated`). */
  "POST /api/claude-code/check": { req: void; res: ClaudeCodeStatus };
  /** The DSH clone DeepSeek · DSH sessions use (stage 17). */
  "GET /api/dsh": { req: void; res: DshStatus };
  /** Sets (or with null clears) the clone's folder; it must hold a DSH checkout (`apps/cli`). */
  "PUT /api/dsh": { req: { path?: string | null; source?: "auto" | "clone" }; res: DshStatus };
  /** Starts DSH over ACP and opens a session in a scratch folder, without a model call; the result is kept. */
  "POST /api/dsh/check": { req: void; res: DshStatus };
  /**
   * A DSH session's folder-access notice (NoticeAction): gives the person inherited full control of the session's
   * folder (the old permissions saved first), so DSH's write sandbox can be set up there. Answers at once; the notice
   * shows how it went.
   */
  "POST /api/sessions/:id/folder-access": { req: void; res: { ok: true } };
  /**
   * 设置 → 项目与目录 (2026-10-23): each project's folder, read for what DSH's write sandbox needs. `available` is
   * false where Studio cannot read or fix them (not Windows).
   */
  "GET /api/dsh/folders": { req: void; res: { available: boolean; folders: FolderAccessStatus[] } };
  /** One project's folder (the hint under 工程内写 asks before a DSH session starts there); 404 where not available. */
  "GET /api/dsh/folders/:workspaceId": { req: void; res: FolderAccessStatus };
  /** Sets one project's folder up (as the session notice does); answers at once with `running`, GET follows it. */
  "POST /api/dsh/folders/:workspaceId/fix": { req: void; res: FolderAccessStatus };
  /** Scans a set-up folder for .exe files again (after a build made new ones) and sets them back to Medium. */
  "POST /api/dsh/folders/:workspaceId/scan": { req: void; res: FolderAccessStatus };
  /** 恢复原来的权限 (2026-10-26): DSH's sandbox entries, the Low label and the full control Studio granted go. */
  "POST /api/dsh/folders/:workspaceId/revert": { req: void; res: FolderAccessStatus };
  /**
   * Quota use of the subscriptions (GPT through the Codex login, Claude through its token). `?refresh=1` asks the
   * accounts now (GPT: may start its app-server); otherwise the last numbers read.
   */
  "GET /api/usage": { req: void; res: AccountUsage[] };
  /** `commonDir`: moves the common space to this folder (created if missing; it must not be a registered project). */
  /** Raw bytes in the body (not JSON), the type in `content-type`, the file name in `?name=`. */
  "POST /api/attachments": { req: void; res: Attachment };
  /** The file itself; also accepts `?token=` so an <img> can load it. */
  "GET /api/attachments/:id": { req: void; res: Blob };
  "PUT /api/settings": { req: { commonDir?: string; presets?: SessionPreset[]; disabledFeatures?: OptionalFeature[]; scratchpadShortcut?: string; claudeLogin?: ClaudeLogin; modelPrefs?: Record<string, ModelPrefs | null>; scratchpadSafeNewlines?: boolean; quotaDisplay?: Record<string, QuotaDisplay | null>; quickModels?: QuickModel[]; autoCompactTokens?: number | null; autoCompactProfiles?: Record<string, AutoCompactChoice | null>; projectGroups?: Array<Omit<ProjectGroup, "id"> & { id?: Id }>; subsessionNotes?: SubsessionNote[] }; res: StudioSettings };
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
    req: { title?: string; workspaceId?: Id | null; topicId?: Id | null; column?: TaskColumn; lead?: boolean; firstSession?: NewSessionInput; template?: TaskTemplateChoice };
    res: { task: Task; session: Session | null };
  };
  /**
   * `workspaceId` (null: the common space) only while the task has no sessions. `topicId` moves the task to another
   * topic or out of its topic (null); its place, group and dependencies on the old topic's canvas are removed.
   */
  "PATCH /api/tasks/:id": { req: { title?: string; description?: string; lead?: boolean; relayAuto?: boolean; column?: TaskColumn; workspaceId?: Id | null; topicId?: Id | null }; res: Task };
  /** Archives the task and all its sessions; returns the task. */
  "POST /api/tasks/:id/archive": { req: void; res: Task };
  "POST /api/tasks/:id/unarchive": { req: void; res: Task };
  "POST /api/topics": { req: { title: string; workspaceIds?: Id[] }; res: Topic };
  "PATCH /api/topics/:id": { req: { title?: string; workspaceIds?: Id[]; description?: string }; res: Topic };
  /** A topic's documents (stage 16), oldest first. */
  "GET /api/topics/:id/docs": { req: void; res: TopicDoc[] };
  "POST /api/topics/:id/docs": { req: { title: string; body?: string }; res: TopicDoc };
  "PATCH /api/topic-docs/:id": { req: { title?: string; body?: string }; res: TopicDoc };
  "DELETE /api/topic-docs/:id": { req: void; res: { ok: true } };
  /** 主控's proposals (stage 16): the open ones, and those decided in the last day. */
  "GET /api/task-plans": { req: void; res: TaskPlan[] };
  /**
   * Accepts a proposal with the person's changes: the tasks kept (each may be edited) are made, put on the topic's
   * canvas with their dependencies; `run` starts each one's first session at once (else they wait in 待办).
   */
  "POST /api/task-plans/:id/accept": { req: { tasks: Array<PlannedTask & { include?: boolean }>; run: boolean }; res: TaskPlan };
  "POST /api/task-plans/:id/dismiss": { req: { note?: string }; res: TaskPlan };
  /** 传话 (stage 16): the pending ones, and those decided in the last day. */
  "GET /api/relays": { req: void; res: Relay[] };
  "POST /api/relays/:id/deliver": { req: void; res: Relay };
  "POST /api/relays/:id/dismiss": { req: void; res: Relay };
  /** Archives the topic with its sessions and all its tasks (and their sessions). */
  "POST /api/topics/:id/archive": { req: void; res: { topic: Topic; tasks: Task[] } };
  /** Restores the topic and the tasks that were archived with it. */
  "POST /api/topics/:id/unarchive": { req: void; res: { topic: Topic; tasks: Task[] } };
  /** A topic session (专题会话): coordinates the topic's tasks; runs in one of its projects or the common space. */
  "POST /api/topics/:id/sessions": { req: NewSessionInput; res: Session };
  "POST /api/tasks/:id/sessions": { req: NewSessionInput; res: Session };
  /** `?after=<seq>`: only later ones. `?tail=<n>`: only the last n, and pending questions and approvals from before them (Focus shows a session's latest; 2026-10-24). */
  "GET /api/sessions/:id/items": { req: void; res: SessionItem[] };
  /** Starts a turn when idle, steers the running turn otherwise. */
  /** `queue`: a Claude session was mid-turn; the message runs as the next turn. Codex steers the running turn instead. */
  /**
   * `attachments`: ids of images uploaded with POST /api/attachments, sent along (Codex `localImage`, Claude image
   * blocks); `text` may then be empty. Steered and queued messages carry them too.
   */
  /** `annotations`: annotations of this session the message refers to (批注1…); they go after the text, see composeAnnotationRefs. */
  "POST /api/sessions/:id/messages": { req: { text: string; attachments?: Id[]; annotations?: Id[] }; res: { mode: "start" | "steer" | "queue" } };
  "POST /api/sessions/:id/interrupt": { req: void; res: { ok: true } };
  /** Claude (stage 15): stop the session's loop, or switch going on by itself after a usage limit (Session.wake). */
  "POST /api/sessions/:id/wake": { req: { stopLoop: true } | { autoContinue: boolean }; res: Session };
  "POST /api/sessions/:id/fork": { req: { profileId?: Id }; res: Session };
  /** Switches the session's model, effort or permissions (null clears back to the default). Codex: from the next turn. */
  /** Renames the session in its runtime too (Codex thread name, Claude session title). */
  "PATCH /api/sessions/:id": { req: { title: string }; res: Session };
  "PATCH /api/sessions/:id/options": { req: { model?: string | null; effort?: string | null; permission?: string | null; fast?: boolean | null }; res: Session };
  /** Archives the session together with its forks and subagents; returns every session changed. */
  "POST /api/sessions/:id/archive": { req: void; res: Session[] };
  "POST /api/sessions/:id/unarchive": { req: void; res: Session[] };
  "POST /api/sessions/:id/terminal": { req: { launch: boolean }; res: TerminalAttach };
  "POST /api/sessions/:id/reclaim": { req: void; res: Session };
  "POST /api/approvals/:approvalId": { req: { sessionId: Id; decision: ApprovalDecision }; res: { ok: true } };
  "GET /api/sessions/:id/annotations": { req: void; res: Annotation[] };
  "POST /api/sessions/:id/annotations": { req: NewAnnotationInput; res: Annotation };
  /** `note` only while unsent; `pinned` keeps it at the top of the panel, sent or not. */
  "PATCH /api/annotations/:id": { req: { note?: string; pinned?: boolean }; res: Annotation };
  "DELETE /api/annotations/:id": { req: void; res: { ok: true } };
  /** Sends every unsent annotation of the session as one user message, in reply order, then marks them sent. */
  "POST /api/sessions/:id/annotations/send": { req: void; res: { mode: "start" | "steer" | "queue"; sent: Annotation[] } };
  /** The global scratchpad (便签): one shared document of pages; the text of stage 2's draft area is its page 1. */
  "GET /api/scratchpad": { req: void; res: Scratchpad };
  /** Switches the page every window shows (0-based) and/or sets the page count (1–9). */
  "PATCH /api/scratchpad": { req: { activePage?: number; pageCount?: number }; res: Scratchpad };
  /** Replaces a page's text and/or its images (`:page` is 1-based; pages beyond the count can be written too). */
  "PUT /api/scratchpad/pages/:page": { req: { text?: string; attachments?: string[] }; res: Scratchpad };
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
  /**
   * "显示在画布上": shows (`true`) or hides a task's card on its topic's canvas; returns that canvas. Tasks created on the
   * canvas are always shown; ones created elsewhere only when the person asks. Hiding keeps the task and its dependencies.
   */
  "PUT /api/tasks/:id/canvas": { req: { onCanvas: boolean }; res: CanvasDoc };
  /** 画布审阅 (2026-10-27): the bubbles on a topic's canvas — every open or answered one, and the last closed ones. */
  "GET /api/topics/:id/callouts": { req: void; res: import("./entities.js").CanvasCallout[] };
  /** Questions waiting for the person, per topic (the left column shows 「? N」 on the topic). */
  "GET /api/callouts/waiting": { req: void; res: Record<Id, number> };
  /** The person answers a question (sent to its session as a message) or writes on a remark. */
  "POST /api/callouts/:id/answer": { req: { text: string }; res: import("./entities.js").CanvasCallout };
  /** Puts a bubble away. */
  "POST /api/callouts/:id/close": { req: void; res: import("./entities.js").CanvasCallout };
  /**
   * 就这条展开聊: a new session to talk one item over, in the task of the session that laid it out (else the topic's
   * 主控), beside that session; returns it. `profileId`: its model (the laying session's otherwise).
   */
  "POST /api/topics/:id/canvas/items/:itemId/discuss": { req: { profileId?: Id }; res: Session };
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
  | { type: "topicdoc.upserted"; doc: TopicDoc }
  | { type: "topicdoc.removed"; topicId: Id; docId: Id }
  | { type: "taskplan.upserted"; plan: TaskPlan }
  | { type: "relay.upserted"; relay: Relay }
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
  | { type: "callout.upserted"; callout: import("./entities.js").CanvasCallout }
  | { type: "todo.upserted"; todo: TodoItem }
  | { type: "todo.removed"; todoId: Id }
  | { type: "task.note.added"; note: TaskNote }
  | { type: "mail.upserted"; mail: MailMessage }
  | { type: "decision.upserted"; decision: DecisionRequest }
  | { type: "checklist.upserted"; item: ChecklistItem }
  | { type: "proposal.upserted"; proposal: ScheduleProposal }
  | { type: "settings.updated"; settings: StudioSettings }
  /** The model profiles changed: a channel was added, edited or removed, or one was hidden or shown (设置 → 模型). */
  | { type: "profiles.updated"; profiles: ModelProfile[] }
  /** File marks (S12-D) changed: one was added, edited or removed (`workspaceId` is its project, null for 其他). */
  | { type: "marks.changed"; markId: Id; workspaceId: Id | null; topicId?: Id | null }
  /** Something failed inside the Host outside any one request; it logged the details and keeps running. */
  | { type: "host.error"; message: string }
  /** 外部打开 Review (2026-10-18): the main window opens a review window on this (events older than a minute are stale). */
  | { type: "review.open"; target: import("./gitreview.js").ReviewOpenTarget; at: Timestamp }
  /** 查看包 (2026-10-23): a pack was made or grew; `open` asks the workbench to show it (new, or sent to again). */
  | { type: "viewpack.upserted"; pack: import("./viewpacks.js").ViewPack }
  | { type: "viewpack.open"; packId: Id; at: Timestamp; /** The item this open added (or joined): shown first. */ itemId?: Id }
  /** Deleted for good from 设置 → 数据管理: drop them from every list. */
  | { type: "data.purged"; workspaceIds: Id[]; topicIds: Id[]; taskIds: Id[]; sessionIds: Id[] }
);

export type HostEventType = HostEvent["type"];

/** Longest quote kept in a summary message; the rest is elided. */
export const ANNOTATION_QUOTE_LIMIT = 300;

// A message that refers to annotations (2026-10-15, like quoting in a chat app): the person's text, then one block the
// model reads as plain text and the conversation shows as small 「批注1」 tags.
const REFS_HEAD = "【引用的批注】";
const REF_LINE = /^【批注(\d+)】针对你回复中的这段：$/;

/** The person's text followed by the annotations it refers to, in their numbers' order. */
export function composeAnnotationRefs(text: string, refs: ReadonlyArray<{ n: number; quote: string; note: string }>): string {
  if (!refs.length) return text;
  const parts = [...refs]
    .sort((a, b) => a.n - b.n)
    .map((a) => {
      const quote = a.quote.length > ANNOTATION_QUOTE_LIMIT ? `${a.quote.slice(0, ANNOTATION_QUOTE_LIMIT)}…` : a.quote;
      return `【批注${a.n}】针对你回复中的这段：\n${quote.split("\n").map((line) => `> ${line}`).join("\n")}\n我的批注：${a.note.trim()}`;
    });
  return `${text.trim() ? `${text.trim()}\n\n` : ""}${REFS_HEAD}\n${parts.join("\n\n")}`;
}

/** The other way: the person's text and the annotations a sent message referred to (none: the text as it is). */
export function splitAnnotationRefs(message: string): { text: string; refs: Array<{ n: number; quote: string; note: string }> } {
  const at = message.startsWith(`${REFS_HEAD}\n`) ? 0 : message.indexOf(`\n\n${REFS_HEAD}\n`);
  if (at < 0) return { text: message, refs: [] };
  const block = message.slice(at === 0 ? REFS_HEAD.length + 1 : at + REFS_HEAD.length + 3);
  const refs: Array<{ n: number; quote: string; note: string }> = [];
  for (const entry of block.split(/\n\n(?=【批注\d+】)/)) {
    const lines = entry.split("\n");
    const head = REF_LINE.exec(lines[0] ?? "");
    const noteAt = lines.findIndex((l) => l.startsWith("我的批注："));
    if (!head || noteAt < 1) return { text: message, refs: [] };
    refs.push({
      n: Number(head[1]),
      quote: lines.slice(1, noteAt).map((l) => l.replace(/^> ?/, "")).join("\n"),
      note: [lines[noteAt]!.slice("我的批注：".length), ...lines.slice(noteAt + 1)].join("\n"),
    });
  }
  return { text: at === 0 ? "" : message.slice(0, at), refs };
}

// What changed about a session's place in AMO since it was last told (2026-10-17): the task joined a topic, was
// referenced on another canvas, became a 主控, got a new 说明… The Host adds one block after the next message the
// session gets; the model reads it as plain text, the conversation shows a small 「AMO 更新」 tag.
const ROLE_UPDATE_HEAD = "【AMO：你的任务有变化】";

/** The message followed by the update block (`lines`: one change each). */
export function composeRoleUpdate(text: string, lines: readonly string[]): string {
  if (!lines.length) return text;
  return `${text.trim() ? `${text.trimEnd()}\n\n` : ""}${ROLE_UPDATE_HEAD}\n${lines.map((l) => `- ${l}`).join("\n")}\n（要看完整的角色卡，调 amo_whoami。）`;
}

/** The other way: the message and the update block it ended with (null: none). */
export function splitRoleUpdate(message: string): { text: string; update: string | null } {
  const at = message.startsWith(`${ROLE_UPDATE_HEAD}\n`) ? 0 : message.lastIndexOf(`\n\n${ROLE_UPDATE_HEAD}\n`);
  if (at < 0) return { text: message, update: null };
  return { text: at === 0 ? "" : message.slice(0, at), update: message.slice(at === 0 ? 0 : at + 2) };
}

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

/**
 * Git Review (S11-D), merged into HostRoutes above. Paths are relative to the project folder; `?range=` is a GitRange
 * (`working` by default). A folder that is not a git repository answers with `repo: false`, not an error.
 */
export interface HostRoutes {
  "GET /api/workspaces/:id/git/status": { req: void; res: import("./gitreview.js").GitStatus };
  /** Changed files of a range, sorted by path. */
  "GET /api/workspaces/:id/git/changes": { req: void; res: import("./gitreview.js").GitChanges };
  /**
   * One file's diff in a range: `?path=` (and `?oldPath=` for renames). What the list already knows saves git calls:
   * `?base=` is the commit it compared with (rangeBase), `?untracked=1|0` whether git tracks the file.
   */
  "GET /api/workspaces/:id/git/diff": { req: void; res: import("./gitreview.js").GitFileDiff };
  /** Line comments of the project, drafts and sent, oldest first. */
  "GET /api/workspaces/:id/review-comments": { req: void; res: import("./gitreview.js").GitReviewComment[] };
  "POST /api/workspaces/:id/review-comments": { req: import("./gitreview.js").NewGitReviewComment; res: import("./gitreview.js").GitReviewComment };
  /** Drafts only (409 once sent). */
  "PATCH /api/review-comments/:id": { req: { note: string }; res: import("./gitreview.js").GitReviewComment };
  "DELETE /api/review-comments/:id": { req: void; res: { ok: true } };
  /**
   * 复制注释 (2026-10-23, in place of 发给会话): the drafts (all, or `ids`) as one text grouped by file — what was sent to
   * a session before — for the person to paste; they are marked sent (no session).
   */
  "POST /api/workspaces/:id/review-comments/copy": {
    req: { ids?: Id[] };
    res: { text: string; sent: import("./gitreview.js").GitReviewComment[] };
  };
  /** Sends the drafts (all, or `ids`) to a session as one message grouped by file, then marks them sent. */
  "POST /api/workspaces/:id/review-comments/send": {
    req: { sessionId: Id; ids?: Id[] };
    res: { mode: "start" | "steer" | "queue"; sent: import("./gitreview.js").GitReviewComment[] };
  };
}

// ---- project files (stage 11, S11-B): the file selector and "@ 文件" ----------------------------------------------
// Declared as a second part of HostRoutes (interfaces merge), so this feature's routes stay together.
export interface HostRoutes {
  /**
   * The project's files: `git ls-files` (tracked and untracked-not-ignored) in a git repository, otherwise a bounded
   * walk that skips node_modules, .git, dist, build and the like. Listed once and cached briefly. `?q=` filters with
   * `fuzzyMatch` (best first, with the matched indices); `?limit=` caps the rows (default 50, at most 200).
   */
  "GET /api/workspaces/:id/files": { req: void; res: import("./files.js").ProjectFiles };
  /** Recently changed files: git's working-tree changes, or the newest by modification time. `?limit=` (default 8). */
  "GET /api/workspaces/:id/files/recent": { req: void; res: import("./files.js").ProjectFiles };
}

// ---- files outside Studio (stage 12, S12-0): open in an editor or the file manager, quick looks -----------------
export interface HostRoutes {
  /** Which editors this machine has. */
  "GET /api/open-in/apps": { req: void; res: import("./openin.js").OpenInApps };
  /** Opens an existing file or folder (404 when it does not exist). */
  "POST /api/open-in": { req: import("./openin.js").OpenInRequest; res: import("./openin.js").OpenInResult };
  /** Reads a text file for a quick look: `?path=` (absolute, or relative with `?workspaceId=`). */
  "GET /api/fs/text": { req: void; res: import("./openin.js").TextFile };
  /** An image file itself, for previews (types in PREVIEW_IMAGE_TYPES); also takes `?token=`. */
  "GET /api/fs/raw": { req: void; res: Blob };
}

// ---- file marks (stage 12, S12-D): files and folders marked with a note, per project --------------------------------
export interface HostRoutes {
  /** All marks, or one project's (`?workspace=<id>`, or `?workspace=other` for those outside every project). */
  "GET /api/file-marks": { req: void; res: import("./marks.js").FileMark[] };
  /** Marks a file or folder; the same path and line range again returns the existing mark (`created: false`). */
  "POST /api/file-marks": { req: import("./marks.js").NewFileMark; res: { mark: import("./marks.js").FileMark; created: boolean } };
  "PATCH /api/file-marks/:id": { req: import("./marks.js").FileMarkPatch; res: import("./marks.js").FileMark };
  "DELETE /api/file-marks/:id": { req: void; res: { ok: true } };
  // 书签 (2026-10-19): file marks and passages of conversations, under topics.
  /** All bookmarks, or one topic's (`?topic=<id>`, or `?topic=none` for 未归专题); in their order. */
  "GET /api/bookmarks": { req: void; res: import("./marks.js").Bookmark[] };
  /** Bookmarks a passage of a reply; the same passage under the same topic gives the one already there. */
  "POST /api/chat-marks": { req: import("./marks.js").NewChatMark; res: { mark: import("./marks.js").ChatMark; created: boolean } };
  /** Note, topic or order of either kind (a line range only for files). */
  "PATCH /api/bookmarks/:id": { req: import("./marks.js").FileMarkPatch; res: import("./marks.js").Bookmark };
  "DELETE /api/bookmarks/:id": { req: void; res: { ok: true } };
}

// ---- files named in a conversation (stage 12, S12-C): which exist, so only those become links -------------------
export interface HostRoutes {
  /** Which of the paths exist (at most MAX_EXISTS_PATHS); relative ones resolve against `cwd` or the project. */
  "POST /api/fs/exists": { req: import("./chatfiles.js").FsExistsRequest; res: import("./chatfiles.js").FsExistsResult };
}

// ---- questions in the conversation (stage 12, S12-B) -----------------------------------------------------------
export interface HostRoutes {
  /**
   * Answers a pending `question` item (by its item id): the answers, the form's values, the plan review's verdict, or
   * `dismiss` to close it without answering. 409 when it is no longer pending.
   */
  "POST /api/sessions/:id/questions/:itemId/answer": { req: import("./questions.js").QuestionReply; res: { ok: true } };
}

// ---- CLI features in the conversation (stage 12, S12-E): / commands, compaction, background commands ------------
export interface HostRoutes {
  /** The `/` menu for a session: Studio's commands, the runtime's (Claude Code's list, Codex review), its skills. */
  "GET /api/sessions/:id/commands": { req: void; res: import("./cli.js").SlashCommandList };
  /**
   * Runs a command by name (without the slash): `compact` compacts the context (Claude: `/compact <args>`, Codex:
   * thread/compact/start), Codex `code-review` starts review mode, a skill runs with `args`, any other Claude command
   * is sent as `/name args`. 409 while a Codex turn runs and the command cannot join it.
   */
  "POST /api/sessions/:id/commands": { req: { name: string; args?: string }; res: import("./cli.js").SlashCommandResult };
  /** Stops a background command of the session (Claude: stop_task). */
  "POST /api/sessions/:id/background/:taskId/stop": { req: void; res: { ok: true } };
  /** The tail of a background command's output. */
  "GET /api/sessions/:id/background/:taskId/output": { req: void; res: import("./cli.js").BackgroundOutput };
  "GET /api/settings/chat": { req: void; res: import("./cli.js").ChatSettings };
  "PUT /api/settings/chat": { req: Partial<import("./cli.js").ChatSettings>; res: import("./cli.js").ChatSettings };
}

// ---- commit history (stage 13, S13-B): the branch's commits and one commit's changes, read-only -------------------
export interface HostRoutes {
  /** HEAD's history, newest first; `?limit=` (default and most GIT_LOG_MAX). */
  "GET /api/workspaces/:id/git/log": { req: void; res: import("./gitreview.js").GitLog };
  /** One commit's changed files against its first parent: `?sha=` (7 to 64 hex digits). */
  "GET /api/workspaces/:id/git/commit": { req: void; res: import("./gitreview.js").GitCommitChanges };
  "POST /api/review/open": { req: import("./gitreview.js").ReviewOpenRequest; res: import("./gitreview.js").ReviewOpenResult };
  /** 查看包 (2026-10-23): make one (or add to the one the same session sent a moment ago) and show it. */
  "POST /api/viewpacks": { req: import("./viewpacks.js").ViewOpenRequest; res: import("./viewpacks.js").ViewOpenResult };
  "GET /api/viewpacks/:id": { req: void; res: import("./viewpacks.js").ViewPack };
  /** The packs a session sent, newest first (`?sessionId=`). */
  "GET /api/viewpacks": { req: void; res: import("./viewpacks.js").ViewPack[] };
  /** A proposal item as a diff of its original and its proposed content. */
  "GET /api/viewpacks/:id/items/:itemId/diff": { req: void; res: import("./gitreview.js").GitFileDiff };
  /** One file of a commit: `?sha=` and `?base=` (full ids, from the commit's listing), `?path=` (and `?oldPath=`). One git call. */
  "GET /api/workspaces/:id/git/commit-diff": { req: void; res: import("./gitreview.js").GitFileDiff };
}

// ---- 设置 → 数据管理 (2026-10-14): archived things and deleting them for good (datamgmt.ts) -----------------------
export interface HostRoutes {
  /** Archived projects, topics, tasks and sessions (top level only), most recently archived first. */
  "GET /api/data/archived": { req: void; res: import("./datamgmt.js").ArchivedEntry[] };
  /** What deleting `?kind=&id=` would take with it; 409 when it is not archived or something live hangs on it. */
  "GET /api/data/purge": { req: void; res: import("./datamgmt.js").PurgeSummary };
  /** Deletes it for good. */
  "POST /api/data/purge": { req: { kind: import("./datamgmt.js").DataKind; id: Id }; res: import("./datamgmt.js").PurgeSummary };
}

// ---- 设置 → 模型 (2026-10-15): the person's own channels, hiding a channel from the pickers, balances (channels.ts) --
export interface HostRoutes {
  "GET /api/channels": { req: void; res: import("./channels.js").ModelChannel[] };
  "POST /api/channels": { req: import("./channels.js").ChannelInput; res: import("./channels.js").ModelChannel };
  "PATCH /api/channels/:id": { req: import("./channels.js").ChannelInput; res: import("./channels.js").ModelChannel };
  /** Only a channel no session uses; otherwise hide it. */
  "DELETE /api/channels/:id": { req: void; res: { ok: true } };
  /** Asks a balance with settings not saved yet (the 添加/编辑 dialog's 测试); `id` fills in what is stored. */
  /** DSH channel (2026-10-19): the model names the site lists (GET {baseUrl}/v1/models), for the dialog's 从网址读取. */
  "POST /api/channels/models-test": { req: { id?: Id; baseUrl?: string; key?: string; keyFrom?: string | null }; res: { models: string[] } };
  "POST /api/channels/balance-test": { req: { id?: Id; kind?: import("./channels.js").ChannelKind; baseUrl?: string; balance: import("./channels.js").BalanceConfig; key?: string; keyFrom?: string | null; accessToken?: string }; res: import("./channels.js").ChannelBalance };
  "PUT /api/profiles/:id/hidden": { req: { hidden: boolean }; res: ModelProfile[] };
  /** `?refresh=1` asks the site again; otherwise the last answer within a minute. */
  "GET /api/profiles/:id/balance": { req: void; res: import("./channels.js").ChannelBalance };
}

// ---- 设置 → 维护 (2026-10-20): how Studio was started, a model's CLI in a terminal at the repo (maintenance.ts) ------
export interface HostRoutes {
  "GET /api/maintenance": { req: void; res: import("./maintenance.js").MaintenanceInfo };
  /** Opens a terminal in the Studio repo running the profile's CLI (Claude Code or Codex); 400 when not run from source. */
  "POST /api/maintenance/terminal": { req: void; res: import("./maintenance.js").MaintenanceTerminalResult };
}
