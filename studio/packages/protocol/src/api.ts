// Host API: REST requests/responses and the WS event stream. Host listens on 127.0.0.1 only.
import type { AccountUsage, Annotation, FolderAccessStatus, CanvasDoc, ChecklistItem, ScheduleProposal, DecisionRequest, Id, MailMessage, MailRecipient, ModelProfile, TaskNote, TodoItem, Session, SessionItem, SessionOptions, Task, TaskColumn, TaskPlan, PlannedTask, Relay, Timestamp, Topic, TopicDoc, Workspace } from "./entities.js";
import type { CanvasRoutes } from "./canvas.js";
import type { ChannelRoutes } from "./channels.js";
import type { ChatFileRoutes } from "./chatfiles.js";
import type { CliRoutes } from "./cli.js";
import type { DataRoutes } from "./datamgmt.js";
import type { DutyRoutes } from "./duty.js";
import type { FileRoutes } from "./files.js";
import type { GitReviewRoutes } from "./gitreview.js";
import type { MaintenanceRoutes } from "./maintenance.js";
import type { MarkRoutes } from "./marks.js";
import type { McpRoutes } from "./mcp.js";
import type { OpenInRoutes } from "./openin.js";
import type { PromptTemplateRoutes } from "./prompt-templates.js";
import type { QuestionRoutes } from "./questions.js";
import type { RemoteRoutes } from "./remote.js";
import type { ViewPackRoutes } from "./viewpacks.js";

export const HOST_DEFAULT_PORT = 47900;

/**
 * What a Host that cannot start sends its shell over the IPC channel before it exits (2026-10-28): `message` is for the
 * person, shown as it is (e.g. the data was migrated by a newer Studio).
 */
export const HOST_START_FAILED = "amo:host-start-failed";
export interface HostStartFailedMessage {
  type: typeof HOST_START_FAILED;
  message: string;
}

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
  /**
   * 接续已有会话 (2026-11-05, plans/done/resume-cli-sessions.md): the id of a Claude session started outside Studio (a terminal,
   * the Claude desktop app; GET /api/claude/outside-sessions). The session goes on from a copy of it, its conversation
   * imported; the original is left as it is. Claude subscription only.
   */
  resumeFrom?: string;
  /** 子会话设定 named in the first message (see SubsessionSetup): kept for the new session. */
  subsessions?: SubsessionSetup[];
}

/** 接续已有会话 (2026-11-05): a Claude session started outside Studio, as GET /api/claude/outside-sessions lists it. */
export interface OutsideSession {
  /** Claude Code's session id. */
  id: string;
  /** Its title (/rename), else Claude Code's summary or first prompt. */
  title: string;
  firstPrompt?: string;
  /** The folder it worked in. */
  cwd: string;
  /** The project whose folder is that one or holds it (the deepest); null when none does. */
  workspaceId: Id | null;
  /** Where it was started: `cli` (a terminal), `desktop` (the Claude desktop app), `other` (an IDE, …). */
  source: "cli" | "desktop" | "other";
  lastModified: Timestamp;
  createdAt?: Timestamp;
  /** Size of its transcript in bytes. */
  bytes?: number;
  gitBranch?: string;
}

export interface OutsideSessionList {
  sessions: OutsideSession[];
  /** Why nothing can be listed (the Claude subscription does not use the local Claude Code login); absent when it can. */
  unavailable?: string;
}

/** The end of an outside session's conversation, for recognising it before 接续. */
export interface OutsideSessionPreview {
  /** The last messages (text only), oldest first. */
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  /** How many messages the conversation has since its last compaction (what is imported). */
  total: number;
  /** It was compacted: what comes before the last compaction is not imported. */
  compacted: boolean;
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
export type OptionalFeature = "planning";

export const OPTIONAL_FEATURES: readonly { id: OptionalFeature; label: string; hint: string }[] = [
  { id: "planning", label: "整体待办与调度", hint: "画布侧栏的整体待办、调度 agent 和它的提案" },
];

/**
 * 设置 → 测试功能 (2026-11-01, the user: 设置里加个测试功能页，这个功能加个开关): features still being tried out. The
 * opposite of OPTIONAL_FEATURES: off until the person turns one on, and the settings list the ones turned on.
 */
export type ExperimentalFeature = "panorama";

export const EXPERIMENTAL_FEATURES: readonly { id: ExperimentalFeature; label: string; hint: string }[] = [
  {
    id: "panorama",
    label: "全景",
    hint: "左边栏「全部任务」下面多一个「全景」：把所有专题画成一张地图，每个专题一块区域，每个任务一条路，会话是路上的节点，等你处理的会话立着牌子，点「N 件等你」依次飞过去。还在测试，只读不改数据，样子和内容以后会变。",
  },
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
  /** Features still being tried out that the person turned on (设置 → 测试功能); off by default. */
  experimentalFeatures: ExperimentalFeature[];
  /**
   * 设置 → 测试功能 → 开发界面目录 (2026-11-05, the user: iterate 全景's view without a release each time): a folder holding
   * a UI build (its index.html) the Host serves instead of the installed one; null when off. Kept in memory only, so
   * restarting Studio (the Host) goes back to the installed UI.
   */
  devUiDir: string | null;
  /**
   * 设置 → 功能 → 中转 (2026-10-30, the user: 开启后不用审批自动发送): what a session asks someone on the team through
   * 中转 (team_ask, team_followup) goes at once instead of waiting for the person's 发送. Off by default.
   */
  teamAutoSend: boolean;
  /**
   * 设置 → 功能 → 命令行适配 (2026-11-06, the user: Studio does it for everyone, with a switch to turn it off): agents get
   * PYTHONUTF8 / PYTHONIOENCODING and a few lines on Windows command lines in their instructions (sessions started from
   * then on; Codex from its next start). On by default.
   */
  shellHelp: boolean;
  /** Global shortcut that shows and hides the scratchpad window, as an Electron accelerator; "" when off. */
  scratchpadShortcut: string;
  /**
   * 便签「复制」: true joins the lines into one with spaces (安全换行, for pasting into a terminal CLI); false (the
   * default) keeps the lines, with Windows line breaks.
   */
  scratchpadSafeNewlines: boolean;
  /** How the Claude subscription signs in (设置 → 模型); sessions keep the way they were started. */
  /** The person's own Claude Code config dir and whether it holds a login (null: cannot tell on this system). */
  claudeLocal: { dir: string; signedIn: boolean | null };
  /** Claude 多账号 (2026-11-03): the accounts the Claude subscription can run on and which one it runs on now. */
  claudeAccounts: ClaudeAccountsState;
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
  /** 专题分组 (2026-10-27): the left column's topic groups, in order, like the project groups. */
  topicGroups: TopicGroup[];
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

/** 专题分组 (2026-10-27): topics gathered under a name in the left column, for the person only; a topic is in at most one. */
export interface TopicGroup {
  id: Id;
  name: string;
  /** The person's own note; "" for none. */
  description: string;
  topicIds: Id[];
}

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
  /**
   * 2026-11-05 (the user: 「每种模型可能都要有自己的设置方式」): the model's own defaults as a sub-session — the first
   * choice in @ 开子会话…, and what session_start uses when the agent leaves them out. Absent: 设置 → 模型's default.
   * A whole account's entry (`model` null) has no effort (its models' lists differ).
   */
  effort?: string;
  fast?: boolean;
  permission?: SubsessionPermission;
}
export const MAX_SUBSESSION_NOTES = 30;
export const SUBSESSION_NOTE_MAX = 1000;

/** session_start's permission levels (each runtime maps them to its own setting). */
export const SUBSESSION_PERMISSIONS = ["read-only", "write", "full"] as const;
export type SubsessionPermission = (typeof SUBSESSION_PERMISSIONS)[number];

/**
 * 子会话设定 (2026-11-05, plans/done/subsession-mention-2026-11-05.md): a sub-session set up with @ 开子会话…, sent with the
 * message that names it (「@子会话·Opus 5.5·high」). The Host keeps it under the session it was sent to; that session's
 * session_start with `setup: name` takes the model and options from it, and `extra` goes to the new session word for
 * word. What the person set wins over what the agent writes.
 */
export interface SubsessionSetup {
  /** The name in the text, without "@". */
  name: string;
  profileId: Id;
  /** One of the profile's models; null: its default. */
  model: string | null;
  effort?: string;
  fast?: boolean;
  permission?: SubsessionPermission;
  /** 这一轮补充: the person's words for the sub-session. */
  extra?: string;
}
export const MAX_SUBSESSION_SETUPS = 10;
export const SUBSESSION_EXTRA_MAX = 4000;

/** Where one account's quota shows: the bottom of the left column (default on) and the Focus window (default off). */
export interface QuotaDisplay {
  footer: boolean;
  focus: boolean;
}

export const DEFAULT_QUOTA_DISPLAY: QuotaDisplay = { footer: true, focus: false };

/**
 * Where a Claude session runs. "local": the person's Claude Code login and ~/.claude (the Claude subscription, always,
 * since 2026-10-27). "token": Studio's own config dir — API-key channels, and in tests the subscription on a test token;
 * the person can no longer save a `claude setup-token` token (the person's call: Studio keeps no Claude.ai credential).
 */
export type ClaudeLogin = "token" | "local";

/**
 * Claude 多账号 (2026-11-03, the user): Claude Code keeps one login per config dir (CLAUDE_CONFIG_DIR, its documented
 * way to use several accounts). "default" is the person's own Claude Code dir (~/.claude, what a terminal uses); each
 * account added in 设置 → 模型 gets its own dir under ~/.claude-accounts, which shares the default dir's conversation
 * records (projects), skills, plugins, CLAUDE.md and settings.json, so a session can go on under another account.
 * Claude subscription sessions run on the current account; switching waits until no Claude session is at work.
 */
export interface ClaudeAccount {
  id: Id;
  /** The person's name for it, or the account's email when they gave none. */
  label: string;
  dir: string;
  /** The person's own Claude Code dir (cannot be removed). */
  isDefault: boolean;
  /** Whether the dir holds a login (Windows: `.credentials.json`); null when this system cannot tell. */
  signedIn: boolean | null;
  /** From `claude auth status` (read after signing in and now and then). */
  email: string | null;
  /** "max", "pro", … */
  plan: string | null;
  /** A sign-in under way in Studio (设置 → 模型 → 添加账号 / 重新登录). */
  login: ClaudeAccountLogin | null;
}

export interface ClaudeAccountLogin {
  state: "waiting" | "failed";
  /** The sign-in page, when the browser did not open by itself. */
  url: string | null;
  /** Why it failed. */
  error: string | null;
}

export interface ClaudeAccountsState {
  current: Id;
  accounts: ClaudeAccount[];
  /** Why switching is not possible now (a Claude session is at work); null when it is. */
  switchBlocked: string | null;
}

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
  /**
   * The installed desktop app, if any, and where it was found (2026-11-02): AMO_STUDIO_DSH_DESKTOP, the folder chosen
   * in 设置, the usual folder, or where the registry says it was installed.
   */
  desktop: { path: string; version: string | null; from: "env" | "chosen" | "default" | "registry" } | null;
  /** The usual folder of the desktop app (or AMO_STUDIO_DSH_DESKTOP's). */
  desktopDir: string | null;
  /** The desktop app's folder chosen in 设置 (installed somewhere else), or null: looked for. */
  desktopChosen: string | null;
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
  /**
   * How the built-in DeepSeek signs in (2026-11-03): "account" — the DeepSeek account signed in in the DSH desktop app
   * (no key); "key" — the API key saved in Studio. Third-party DeepSeek channels always use their own key.
   */
  auth: "account" | "key";
  /** The desktop app's credentials file and whether a DeepSeek account is signed in there. */
  account: { file: string; signedIn: boolean };
  /** Whether the built-in DeepSeek's API key is saved. */
  keySaved: boolean;
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

/**
 * 设置 → 统计 (2026-10-27): tokens per local day and model, counted again from every turn's usage each time it is asked
 * for. A model is a profile (a channel: Claude, GPT, GLM, a third-party one); subagents and delegated sessions count
 * under the model they ran on. `input` here is what was not read from the cache (the runtimes' input minus cachedInput).
 */
export interface TokenStatsDay {
  /** YYYY-MM-DD in the Host's time zone, from the turn's start. */
  date: string;
  profileId: string;
  input: number;
  cached: number;
  output: number;
  turns: number;
}

export interface TokenStatsModel {
  profileId: string;
  label: string;
  runtime: import("./entities.js").SessionRuntime | null;
  model: string | null;
  /** No longer among the profiles (a channel that was deleted): still counted, under its old id. */
  removed: boolean;
}

export interface TokenStats {
  generatedAt: Timestamp;
  /** How long counting took. */
  ms: number;
  /** Turns with usage that were counted. */
  turns: number;
  days: TokenStatsDay[];
  models: TokenStatsModel[];
}

export interface CredentialStatus {
  id: string;
  /** The profiles that use it, e.g. "Claude 订阅". */
  usedBy: string[];
  saved: boolean;
  /** Only the Claude subscription token can be saved from Studio; API keys come from old AMO's settings. */
  writable: boolean;
}

/**
 * Every REST route as `"METHOD /path"` with its request body and response. `:id` segments are path params. The routes
 * of a topic with a protocol file of its own are declared there (8b, 2026-11-06: remote.ts's RemoteRoutes and the
 * like); the shared ones (workspaces, tasks, topics, sessions, settings…) are here. Host's `route()` checks each
 * route against this (packages/host/src/http/route.ts).
 */
export interface HostRoutes
  extends CanvasRoutes,
    ChannelRoutes,
    ChatFileRoutes,
    CliRoutes,
    DataRoutes,
    DutyRoutes,
    FileRoutes,
    GitReviewRoutes,
    MaintenanceRoutes,
    MarkRoutes,
    McpRoutes,
    OpenInRoutes,
    PromptTemplateRoutes,
    QuestionRoutes,
    RemoteRoutes,
    ViewPackRoutes {
  "GET /api/state": { req: void; res: StateSnapshot };
  /**
   * Whether the Host answers (the shell's keepalive). No token needed (2026-10-28). `running`: sessions at work, counted
   * as the board's 进行中 (running, waiting for the person mid-turn, about to go on by itself, or in a terminal), for the
   * AMO platform to ask before it updates Studio. `version` (2026-10-29): the Studio that started this Host ("dev" from
   * the sources), so the platform can tell a Host older than the Studio it has installed.
   */
  "GET /api/health": { req: void; res: { ok: true; pid: number; running: number; version: string } };
  /**
   * Stops the Host (2026-10-29: the tray's 完全退出, the platform's 重启 Studio). Token needed. With sessions at work it
   * answers 409 `{ ok: false, running }` unless `interrupt` is true (the person agreed to cut them). Accepted, the Host
   * writes host-exit.json and stops; a shell on it quits too.
   */
  "POST /api/shutdown": { req: { interrupt?: boolean }; res: { ok: true; running: number } };
  "POST /api/workspaces": { req: { path: string; name?: string }; res: Workspace };
  "DELETE /api/workspaces/:id": { req: void; res: { ok: true } };
  /** 编辑项目: its name in Studio (the folder keeps its own) and its note; an empty note clears it. */
  "PATCH /api/workspaces/:id": { req: { name?: string; description?: string }; res: Workspace };
  /** Archives the project with all its tasks (and their sessions); the common space cannot be archived. */
  "POST /api/workspaces/:id/archive": { req: void; res: { workspace: Workspace; tasks: Task[] } };
  /** Restores the project and the tasks that were archived with it. */
  "POST /api/workspaces/:id/unarchive": { req: void; res: { workspace: Workspace; tasks: Task[] } };
  "GET /api/settings": { req: void; res: StudioSettings };
  /** The Claude Code that Claude sessions run on (2026-10-24). */
  "GET /api/claude-code": { req: void; res: ClaudeCodeStatus };
  /** Looks for it again (e.g. just installed); the channels on Claude Code follow (`profiles.updated`). */
  "POST /api/claude-code/check": { req: void; res: ClaudeCodeStatus };
  /** The DSH clone DeepSeek · DSH sessions use (stage 17). */
  "GET /api/dsh": { req: void; res: DshStatus };
  /** Sets (or with null clears) the clone's folder; it must hold a DSH checkout (`apps/cli`). */
  "PUT /api/dsh": { req: { path?: string | null; source?: "auto" | "clone"; desktopPath?: string | null; auth?: "account" | "key" }; res: DshStatus };
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
  /**
   * 接续已有会话 (2026-11-05): Claude sessions started outside Studio (a terminal, the Claude desktop app) that are not
   * Studio's and were not taken on yet, most recent first. Start one with `firstSession.resumeFrom` (POST /api/tasks).
   */
  "GET /api/claude/outside-sessions": { req: void; res: OutsideSessionList };
  "GET /api/claude/outside-sessions/:id/preview": { req: void; res: OutsideSessionPreview };
  /** Claude 多账号 (2026-11-03): the accounts (also in `settings.claudeAccounts`, which follows every change). */
  "GET /api/claude-accounts": { req: void; res: ClaudeAccountsState };
  /** 添加账号: a new account dir, and Claude Code's sign-in started for it (the browser opens; `login.url` otherwise). */
  "POST /api/claude-accounts": { req: { label?: string; /** Test runs only (AMO_STUDIO_TEST=1): no sign-in started. */ signIn?: false }; res: ClaudeAccountsState };
  /** 重新登录: the sign-in again for an account (expired or signed out). */
  "POST /api/claude-accounts/:id/login": { req: void; res: ClaudeAccountsState };
  /** The code the sign-in page shows, when the browser could not hand it back by itself. */
  "POST /api/claude-accounts/:id/login/code": { req: { code: string }; res: ClaudeAccountsState };
  /** Stops a sign-in; a new account that never signed in goes with it. */
  "DELETE /api/claude-accounts/:id/login": { req: void; res: ClaudeAccountsState };
  /** Reads email and plan again (`claude auth status`). */
  "POST /api/claude-accounts/:id/refresh": { req: void; res: ClaudeAccountsState };
  /** Renames an account. */
  "PATCH /api/claude-accounts/:id": { req: { label: string }; res: ClaudeAccountsState };
  /** 切换: the Claude subscription runs on this account from now on; refused (conflict) while a Claude session is at work. */
  "PUT /api/claude-accounts/current": { req: { id: Id }; res: ClaudeAccountsState };
  /** Removes an added account: its login and dir (the shared records stay with the default account). Not the default or current one. */
  "DELETE /api/claude-accounts/:id": { req: void; res: ClaudeAccountsState };
  /** Raw bytes in the body (not JSON), the type in `content-type`, the file name in `?name=`. */
  "POST /api/attachments": { req: void; res: Attachment };
  /** The file itself; also accepts `?token=` so an <img> can load it. */
  "GET /api/attachments/:id": { req: void; res: Blob };
  /** `commonDir`: moves the common space to this folder (created if missing; it must not be a registered project). */
  "PUT /api/settings": { req: { commonDir?: string; devUiDir?: string | null; presets?: SessionPreset[]; disabledFeatures?: OptionalFeature[]; experimentalFeatures?: ExperimentalFeature[]; teamAutoSend?: boolean; shellHelp?: boolean; scratchpadShortcut?: string; modelPrefs?: Record<string, ModelPrefs | null>; scratchpadSafeNewlines?: boolean; quotaDisplay?: Record<string, QuotaDisplay | null>; quickModels?: QuickModel[]; autoCompactTokens?: number | null; autoCompactProfiles?: Record<string, AutoCompactChoice | null>; projectGroups?: Array<Omit<ProjectGroup, "id"> & { id?: Id }>; topicGroups?: Array<Omit<TopicGroup, "id"> & { id?: Id }>; subsessionNotes?: SubsessionNote[] }; res: StudioSettings };
  /** Models (with reasoning efforts) and permission settings of a profile, asked from its CLI. */
  "GET /api/profiles/:id/choices": { req: void; res: ProfileChoices };
  "GET /api/credentials": { req: void; res: CredentialStatus[] };
  "GET /api/stats/tokens": { req: void; res: TokenStats };
  /** Saves a writable credential (the Claude subscription token) in the Windows Credential Manager. */
  "PUT /api/credentials/:id": { req: { secret: string }; res: CredentialStatus[] };
  "DELETE /api/credentials/:id": { req: void; res: CredentialStatus[] };
  /**
   * `workspaceId` null or absent: the common space. `topicId`: put it in that topic. Without `firstSession` the task is
   * only filed (column `todo` unless given); with it, the first session starts.
   */
  "POST /api/tasks": {
    /** `firstMessage`: filed without a session (放进待办), the sentence its first session will start from. */
    req: { title?: string; workspaceId?: Id | null; topicId?: Id | null; column?: TaskColumn; lead?: boolean; firstSession?: NewSessionInput; firstMessage?: string };
    res: { task: Task; session: Session | null };
  };
  /**
   * `workspaceId` (null: the common space) only while the task has no sessions. `topicId` moves the task to another
   * topic or out of its topic (null); its place, group and dependencies on the old topic's canvas are removed.
   */
  "PATCH /api/tasks/:id": { req: { title?: string; description?: string; firstMessage?: string; lead?: boolean; relayAuto?: boolean; column?: TaskColumn; workspaceId?: Id | null; topicId?: Id | null }; res: Task };
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
  /**
   * `now` (立即发送, 2026-11-02; Claude and Codex): while a turn runs, the model reads the message at once — the turn's
   * current step gives way (Ctrl+Enter); `mode` stays what the message would have been without it.
   */
  "POST /api/sessions/:id/messages": { req: { text: string; attachments?: Id[]; annotations?: Id[]; now?: boolean; subsessions?: SubsessionSetup[] }; res: { mode: "start" | "steer" | "queue" } };
  "POST /api/sessions/:id/interrupt": { req: void; res: { ok: true } };
  /** 立即发送 on a message still waiting (delivery `waiting`): the running turn gives way and the model reads it now. Nothing when it is not waiting any more. */
  "POST /api/sessions/:id/items/:itemId/send-now": { req: void; res: { ok: true } };
  /** 重新发送 a message its process never read (delivery `unsent`): the same item goes again. */
  "POST /api/sessions/:id/items/:itemId/resend": { req: void; res: { mode: "start" | "steer" | "queue" } };
  /** Claude (stage 15): stop the session's loop, or switch going on by itself after a usage limit (Session.wake). */
  "POST /api/sessions/:id/wake": { req: { stopLoop: true } | { autoContinue: boolean }; res: Session };
  "POST /api/sessions/:id/fork": { req: { profileId?: Id }; res: Session };
  /** Renames the session in its runtime too (Codex thread name, Claude session title). */
  "PATCH /api/sessions/:id": { req: { title: string }; res: Session };
  /** Switches the session's model, effort or permissions (null clears back to the default). Codex: from the next turn. */
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
  /** 会话里用中转 (2026-10-30): what sessions asked to send through 中转 — pending ones, and those decided in the last day. */
  "GET /api/teamrelay/sends": { req: void; res: import("./entities.js").TeamSend[] };
  /** The person says send it: it goes to 中转 as them (AI 代发). */
  "POST /api/teamrelay/sends/:id/send": { req: void; res: import("./entities.js").TeamSend };
  /** Not sent; the session hears so. */
  "POST /api/teamrelay/sends/:id/dismiss": { req: void; res: import("./entities.js").TeamSend };
  /** The 中转 sessions this computer's sessions sent, as last seen. */
  "GET /api/teamrelay/threads": { req: void; res: import("./entities.js").TeamThread[] };
  /**
   * 在 Studio 里打开 (2026-11-05): show this session in the workbench (a `ui.open` event the main window acts on). AMO 中转
   * asks it for a session one of this computer's sessions sent; 404 when there is no such session.
   */
  "POST /api/ui/open": { req: { sessionId: Id }; res: { taskId: Id; sessionId: Id } };
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
  | { type: "teamsend.upserted"; send: import("./entities.js").TeamSend }
  /** The 中转 sessions this computer's sessions sent, all of them, when one changed. */
  | { type: "teamthreads.changed"; threads: import("./entities.js").TeamThread[] }
  | { type: "session.upserted"; session: Session }
  | { type: "item.appended"; item: SessionItem }
  /** Full replacement, e.g. a finished agent message or an approval that changed state. */
  | { type: "item.updated"; item: SessionItem }
  /** Streaming text appended to an agent item; not persisted as a separate event. */
  | { type: "item.delta"; sessionId: Id; itemId: Id; append: string }
  /**
   * Many items of a session were written at once (a remote copy catching up after being away, 2026-11-01): read the
   * session's items again instead of one item.appended each.
   */
  | { type: "items.reloaded"; sessionId: Id }
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
  /** 提示词模板 (2026-10-31): one was added, edited or removed. */
  | { type: "prompt-templates.changed"; templateId: Id }
  /** MCP 设置 (2026-11-04): a server, the global or a project's choices changed, or a session reported statuses. */
  | { type: "mcp.changed"; workspaceId?: Id; sessionId?: Id }
  /** Something failed inside the Host outside any one request; it logged the details and keeps running. */
  | { type: "host.error"; message: string }
  /**
   * 在 Studio 里打开 (2026-11-05, plans/done/relay-round-2026-11-05.md J1): another program on this computer (AMO 中转) asked to
   * show a session; the workbench goes to it and comes forward (events older than a minute are stale).
   */
  | { type: "ui.open"; taskId: Id; sessionId: Id; at: Timestamp }
  /** 外部打开 Review (2026-10-18): the main window opens a review window on this (events older than a minute are stale). */
  | {
      type: "review.open";
      target: import("./gitreview.js").ReviewOpenTarget;
      at: Timestamp;
      /**
       * 远程 Reviewer (2026-11-02), on the computer a granted task runs on: the turn was started from the device it is
       * granted to, which shows it; shown here too only when 「我也关心」 is ticked for this task.
       */
      onlyIfAlsoMine?: Id;
    }
  /** 查看包 (2026-10-23): a pack was made or grew; `open` asks the workbench to show it (new, or sent to again). */
  | { type: "viewpack.upserted"; pack: import("./viewpacks.js").ViewPack }
  | {
      type: "viewpack.open";
      packId: Id;
      at: Timestamp;
      /** The item this open added (or joined): shown first. */
      itemId?: Id;
      /** 远程 Reviewer (2026-11-02), on B: the pack is this remote task's, read from the computer it runs on. */
      remote?: Id;
      /** 远程 Reviewer: shown only when 「我也关心」 is ticked here for this task (as review.open). */
      onlyIfAlsoMine?: Id;
    }
  /** Deleted for good from 设置 → 数据管理: drop them from every list. */
  | { type: "data.purged"; workspaceIds: Id[]; topicIds: Id[]; taskIds: Id[]; sessionIds: Id[] }
  /** 远程 (2026-10-29): the connection, the paired devices or the pairing requests changed. Not kept in the log. */
  | { type: "remote.updated"; remote: import("./remote.js").RemoteState }
  /** 远程 step 3: how far a file being fetched from a paired device has come (`fetchId` as POST /api/remote/files was given). Not kept in the log. */
  | { type: "remote.file"; fetchId: string; received: number; total: number }
  /**
   * 远程 Reviewer (2026-11-02): what a remote task's Reviewer windows show came from its computer just now (`stale`
   * null), or is the copy from last time because that computer cannot be reached (`stale` says so). Not kept in the log.
   */
  | { type: "remote.view"; taskId: Id; stale: string | null }
  /** 远程 (2026-10-30): a paired device says what may be picked creating a task on it changed (RemoteCatalog). Not kept in the log. */
  | { type: "remote.catalog"; account: string; device: string; catalog: import("./remote.js").RemoteCatalog }
  /** 值守 (2026-10-31): its items, runs or what runs now changed. Not kept in the log. */
  | { type: "duty.updated"; duty: import("./duty.js").DutyState }
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
