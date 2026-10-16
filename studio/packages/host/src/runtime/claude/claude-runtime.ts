import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSdkMcpServer, forkSession, getSessionMessages, query, renameSession, tool, type HookCallbackMatcher, type HookEvent, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { claudeAnswers, parseSlashCommand, storedAnswers, type ApprovalDecision, type ApprovalKind, type Attachment, type BackgroundState, type ChatSettings, type Id, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionPrompt, type QuestionReply, type Session, type SessionItem, type SessionOptions, type SessionStatus, type SlashCommand, type SlashCommandList, type SlashCommandResult, type ToolFields, type TurnRetry, type TurnState, type Workspace, type AccountUsage, type UsageWindow } from "@amo-studio/protocol";
import { readChatSettings } from "../chat-settings.js";
import { CLAUDE_BUILTIN_MODELS, CLAUDE_DEFAULT_PERMISSION, CLAUDE_PERMISSIONS, claudePermissionMode } from "../choices.js";
import type { Store } from "../../store/store.js";
import type { CredentialReader } from "../credentials.js";
import { RuntimeBase, type NewItemBody, type SendMode, type SessionRuntimeApi } from "../runtime.js";
import { classifyCommand, fileDiff, formatInput, shortPath, tail, textDiff } from "../items.js";
import { claudeEnv, type ClaudeHome, type ClaudeProviderDef } from "./claude-env.js";
import { localClaudeHome, readClaudeLogin, rememberSessionLogin, sessionClaudeLogin } from "./claude-login.js";
import { CLAUDE_USAGE_LABELS, ClaudeUsageError, fetchClaudeUsage, localAccessToken } from "./claude-usage.js";
import { agentToolUseId, isUsageLimitText, keepsProcess, loopFromScheduleWakeup, studioWakeDue, WAKE_MIN_GAP_MS } from "./wake.js";
import { agentsMdInstructions } from "./project-instructions.js";
import { AMO_MCP_INSTRUCTIONS, AMO_MCP_NAME, type AmoTool } from "../../mcp/tools.js";

// Drives Claude sessions through the Claude Agent SDK. Behaviour follows spikes/RESULTS.md section h:
// - permissionMode is always "default" (the CLI otherwise picks "auto", where a classifier approves instead of a person);
//   canUseTool waits for the person and becomes an approval card;
// - a message sent while a turn runs is queued for the next turn (the SDK does not fold it into the running one);
// - after interrupt() the SDK ends the query with an error, which is treated as "interrupted";
// - one query can produce several results (a background subagent's notification starts another turn);
// - a subagent has no session of its own in Claude: its messages carry parent_tool_use_id. Studio still gives each
//   Agent call a child session ("sub") so the tree and "查看" work as for Codex; it cannot take messages itself;
// - forks copy the transcript with forkSession() (no model call).
// - "在终端打开" hands the session to `claude --resume` in a terminal: Studio closes its own process first (one
//   process per session id), stays read-only meanwhile, and on reclaim imports what the terminal added.

export interface ClaudeRuntimeOptions {
  store: Store;
  profiles: readonly ModelProfile[];
  providers: Record<string, ClaudeProviderDef>;
  credentials: CredentialReader;
  /** Studio's own CLAUDE_CONFIG_DIR; transcripts live under <claudeHome>/projects. */
  claudeHome: string;
  /** The person's Claude Code config dir, used by sessions started with the local login (default: theirs, ~/.claude). */
  localClaudeHome?: string;
  now?: () => Date;
  /** An idle query (no turn, no background task) is closed after this long; the next message resumes it. */
  idleCloseMs?: number;
  /** Variables the child environment starts from (default: process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** The AMO MCP tools, given to every Claude session in-process (no token reaches the CLI). */
  mcpTools?: (sessionId: Id) => AmoTool[];
}

interface PendingApproval {
  itemId: Id;
  input: Record<string, unknown>;
  toolUseId: string | null;
  resolve(result: PermissionResult): void;
}

/** AskUserQuestion or ExitPlanMode waiting in canUseTool for the person's answer (a `question` item). */
interface PendingQuestion {
  itemId: Id;
  kind: "ask" | "plan";
  input: Record<string, unknown>;
  questions: QuestionPrompt[];
  resolve(result: PermissionResult): void;
}

/** Tools whose call is the person's to answer: shown as a question item rather than a tool row. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** One running Claude Code process for a session, fed through a streaming input. */
interface Live {
  q: Query;
  /** Settles when the query has ended and its process is gone. */
  done: Promise<void>;
  push(content: SDKUserMessage["message"]["content"]): void;
  end(): void;
  running: boolean;
  /** Settles once the session's permission mode is in force (see ensureLive). */
  ready: Promise<void>;
  interrupted: boolean;
  /** Closed by Studio (idle, archive, Host shutdown) rather than ended by the CLI. */
  closedByHost: boolean;
  /** Message types Studio failed to handle in this query (each told once in the conversation). */
  handlerErrors: Set<string>;
  background: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Tokens in the context after the latest model call of this turn (from the assistant messages' usage). */
  context?: number;
  /** The model call streaming now: when its first output came and its output tokens so far (the turn's speed). */
  call?: { firstAt: number | null; tokens: number } | null;
  /** The turn in progress (from the first message of a run to its result). */
  turn: { id: string; itemId: Id } | null;
  /** Agent items still streaming, oldest first. */
  streaming: Id[];
  /** Thinking items still streaming, oldest first, with when they started. */
  thinking: Array<{ itemId: Id; startedAt: number }>;
  text: Map<Id, string>;
  /** stream content-block index -> agent item, for the message being streamed */
  blocks: Map<number, Id>;
  /** tool_use id -> tool item */
  tools: Map<string, Id>;
  /** tool_use id -> when the call was made */
  toolStarted: Map<string, number>;
  declinedTools: Set<string>;
  approvals: Map<string, PendingApproval>;
  /** question item id -> the canUseTool call waiting for its answer */
  questions: Map<Id, PendingQuestion>;
  /** AskUserQuestion / ExitPlanMode calls (tool_use id -> name and input), and those that reached the person */
  questionTools: Map<string, { name: string; input: Record<string, unknown> }>;
  askedTools: Set<string>;
  /** Agent tool_use id -> child session */
  subs: Map<string, Id>;
  /** Agent calls running in the background (their tool result arrives at once; a task notification ends them) */
  backgroundSubs: Set<string>;
  // ---- stage 12, S12-E ----
  /** tool_use id -> the call's name and input (kept for the turn: background commands, images read, summaries) */
  calls: Map<string, { name: string; input: Record<string, unknown>; itemId?: Id }>;
  /** CLI task id -> its tool_use id and description (every Bash or agent task, foreground or not) */
  tasks: Map<string, { toolUseId?: string; description: string; type?: string }>;
  /** background command (task id) -> its `background` item */
  bgItems: Map<string, Id>;
  /** The compaction in progress (its item), between status "compacting" and compact_boundary. */
  compaction: Id | null;
  /** A retry is shown on the turn (cleared when the model answers). */
  retrying: boolean;
  /** notice key -> its item, for the turn in progress (repeats update the row instead of adding one) */
  notices: Map<string, Id>;
  /** The command list as the CLI last pushed it (commands_changed), newest first. */
  commands: SdkSlashCommand[] | null;
  /** Tools the person declined in Studio (a permission_denied for them needs no notice). */
  declinedByPerson: Set<string>;
  // ---- stage 15, loop and usage limit (2026-10-16) ----
  /** Background agent id (the CLI's task id) -> its Agent call, to find the child session a SendMessage resumes. */
  agents: Map<string, string>;
  /** SendMessage call that resumed an agent -> its child session (the agent's next task notification names that call). */
  resumes: Map<string, Id>;
  /** The latest rate_limit_event that refused a request (when the limit resets). */
  refused: { resetsAt?: number; type?: string } | null;
  /** This turn stopped at a usage limit: the CLI's text. */
  limitText: string | null;
  /** This turn called ScheduleWakeup (set or stopped the loop). */
  scheduled: boolean;
  /** Who started this turn while a usage limit was pending (for the log: did the CLI go on by itself?). */
  afterLimit: "cli" | "studio" | "person" | null;
  /** The person stopped the loop during this turn: the process closes when the turn ends (taking the CLI's wakeup with it). */
  stopLoopAtEnd: boolean;
  /** The next message is Studio's own (wake), not the person's. */
  sendingForStudio: boolean;
}

/**
 * Claude Code commands left out of the `/` menu (stage 12, S12-E): they would change what Studio keeps for the session
 * (its conversation, model, effort, name) behind its back, only make sense in the terminal UI, or are internal.
 * `compact` is offered as Studio's own. The ones in BLOCKED_COMMANDS are refused when typed.
 */
const HIDDEN_COMMANDS = new Set(["compact", "clear", "model", "effort", "fast", "rename", "config", "color", "focus", "heapdump", "auto-mode-setup", "autocompact", "resume", "exit", "quit", "login", "logout", "workflow-launch-exec"]);
const BLOCKED_COMMANDS: Record<string, string> = {
  clear: "Studio 里不能用 /clear 清空会话：请新建一个会话。",
  reset: "Studio 里不能用 /reset 清空会话：请新建一个会话。",
  new: "Studio 里不能用 /new：请新建一个会话。",
  model: "请用输入框左下角的「型号」切换模型。",
  effort: "请用输入框左下角切换思考强度。",
  rename: "请在会话标题上改名。",
  resume: "Studio 里不能切换到别的 Claude 会话。",
  exit: "Studio 里不需要 /exit。",
  quit: "Studio 里不需要 /quit。",
  login: "请在 设置 → 模型凭据 里保存令牌。",
  logout: "请在 设置 → 模型凭据 里删除令牌。",
};

/** The settings files Claude Code reads in a terminal (the SDK reads none unless told). */
const CLI_SETTING_SOURCES: Array<"user" | "project" | "local"> = ["user", "project", "local"];

/**
 * Defence in depth: an Agent call may ask for a permission `mode` (bypassPermissions, auto, dontAsk…) for its
 * subagent. The Agent tool itself does not go through canUseTool, so the mode is dropped in a PreToolUse hook.
 * (With the parent in "default" mode, CLI 2.1.296 did not honour such a mode anyway; see spikes/RESULTS.md.)
 */
const STRIP_SUBAGENT_MODE: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
  PreToolUse: [
    {
      matcher: "Agent|Task",
      hooks: [
        async (input) => {
          const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input;
          if (!toolInput || !("mode" in toolInput)) return {};
          return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: withoutKey(toolInput, "mode") } };
        },
      ],
    },
  ],
};

const DECLINED = "The person declined this in AMO Studio.";
const QUESTIONS_DISMISSED =
  "The user closed these questions in AMO Studio without answering them. Do not ask them again right away: carry on with what you know, stating any assumptions you make, or stop and say what you need from the user.";
const PLAN_DISMISSED = "The user closed the plan review in AMO Studio without approving the plan. Stay in plan mode: do not edit files or run commands; wait for the user's next message.";
const planRevision = (feedback: string) =>
  `The user reviewed the plan in AMO Studio and wants changes before you start:\n\n${feedback}\n\nRevise the plan accordingly and present it again with ExitPlanMode. Stay in plan mode until the user approves.`;

export class ClaudeRuntime extends RuntimeBase implements SessionRuntimeApi {
  private readonly live = new Map<Id, Live>();
  /** The subscription's quota windows, from the rate_limit_event messages of its sessions. */
  private readonly usageCache = new Map<Id, Map<string, UsageWindow>>();
  private readonly usageAt = new Map<Id, string>();
  /** The account's own answer (local login), per profile. */
  private readonly accountUsageCache = new Map<Id, { at: number; value: AccountUsage }>();
  private readonly modelCache = new Map<string, { at: number; models: ModelOption[] }>();
  /** Queries being closed: a new one for the same session must wait, or the CLI says the session id is in use. */
  private readonly closing = new Map<Id, Promise<void>>();
  /** Skill names per profile, from the CLI's init message (its command list does not tell skills apart). */
  private readonly skillNames = new Map<Id, Set<string>>();
  /** Command lists asked without a session (profile and folder -> list). */
  private readonly commandCache = new Map<string, { at: number; list: SdkSlashCommand[] }>();
  /** The `/` command a session was last sent, to name the output of a command that runs without the model. */
  private readonly lastCommand = new Map<Id, string>();
  /** Studio's own timer per session with a wake (stage 15): it goes on when the CLI has not. */
  private readonly wakeTimers = new Map<Id, ReturnType<typeof setTimeout>>();
  /** The Host is closing: no new wake timers. */
  private shuttingDown = false;
  /** The person's 「恢复后自动继续」 per session, kept for the next usage limit too. */
  private readonly autoContinueChoice = new Map<Id, boolean>();
  /** When Studio last started a turn itself, per session (its next one waits WAKE_MIN_GAP_MS). */
  private readonly lastStudioWake = new Map<Id, number>();

  /** The person's own config dir; `explicit` when they set CLAUDE_CONFIG_DIR (read once: helpers set it for a while). */
  private readonly local: { dir: string; explicit: boolean };

  constructor(private readonly options: ClaudeRuntimeOptions) {
    super(options.store, "claude", options.now);
    const env = options.baseEnv ?? process.env;
    this.local = { dir: options.localClaudeHome ?? localClaudeHome(env), explicit: !!options.localClaudeHome || !!env.CLAUDE_CONFIG_DIR?.trim() };
    this.recoverAfterRestart();
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session> {
    const profile = this.profile(input.profileId);
    // Fail early (missing provider, key or login) rather than on the first message.
    const home = this.newHome(profile);
    claudeEnv(profile, this.options.providers, this.options.credentials, home, this.options.baseEnv);
    // Studio picks the Claude session id up front (SDK option `sessionId`), so the session is addressable at once.
    const session = this.createSession({
      taskId: input.taskId,
      topicId: input.topicId,
      parentId: null,
      kind: "main",
      profileId: profile.id,
      workspaceId: input.workspace.id,
      title: input.title ?? "",
      runtimeRef: randomUUID(),
      options: input.options ?? {},
    });
    rememberSessionLogin(this.store, session.id, home.login);
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  /** Images go as base64 image blocks before the text (the CLI keeps them in the transcript). */
  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = []): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    const slash = parseSlashCommand(text);
    const blocked = slash ? BLOCKED_COMMANDS[slash.name.toLowerCase()] : undefined;
    if (blocked) throw Object.assign(new Error(blocked), { code: "bad_request" });
    if (slash) this.lastCommand.set(sessionId, slash.name);
    // Read the images first: a missing file fails the send before anything is shown or queued.
    const blocks = images.map((a) => ({ type: "image" as const, source: { type: "base64" as const, media_type: a.mime as "image/png", data: readFileSync(a.path).toString("base64") } }));
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    await this.closing.get(sessionId);
    const live = this.ensureLive(session);
    const mode: SendMode = live.running ? "queue" : "start";
    if (!live.running) this.turnStarted(sessionId, live, "person");
    const shown = images.map((a) => ({ id: a.id, path: a.path }));
    this.appendItem(sessionId, { type: "user", text, ...(shown.length ? { images: shown } : {}) }, { method: mode === "queue" ? "user/queued" : "user" });
    this.clearIdle(live);
    await live.ready;
    live.push(blocks.length ? [...blocks, ...(text ? [{ type: "text" as const, text }] : [])] : text);
    return { mode };
  }

  async interrupt(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.running) return;
    live.interrupted = true;
    for (const [key, a] of live.approvals) {
      live.approvals.delete(key);
      a.resolve({ behavior: "deny", message: DECLINED, interrupt: true });
      this.updateItem(a.itemId, (item) => (item.type === "approval" && item.state === "pending" ? { ...item, state: "declined" } : item));
    }
    for (const [key, question] of live.questions) {
      live.questions.delete(key);
      question.resolve({ behavior: "deny", message: DECLINED, interrupt: true });
      this.cancelQuestion(question.itemId);
    }
    await live.q.interrupt().catch((err: unknown) => this.emit("log", `interrupt failed for ${sessionId}: ${String(err)}`));
  }

  /** Copies the transcript into a new Claude session (no model call); the branch continues from there. */
  async fork(sessionId: Id, profileId?: Id): Promise<Session> {
    const parent = this.requireSession(sessionId);
    if (parent.kind === "sub") throw Object.assign(new Error("Claude 的子 agent 没有独立的对话，不能分支"), { code: "read_only" });
    const profile = this.profile(profileId ?? parent.profileId);
    const workspace = this.store.getWorkspace(parent.workspaceId);
    if (!workspace || !parent.runtimeRef) throw new Error(`session ${sessionId} cannot be forked`);
    const home = this.homeOf(parent.id);
    if (!this.hasTranscript(parent.runtimeRef, home)) throw Object.assign(new Error("这个会话还没有对话内容，不能分支"), { code: "conflict" });
    // The copy stays in the parent's config dir, so the branch runs the way the parent did.
    if (home.login === "local" && !this.isSubscription(profile)) throw Object.assign(new Error("这个会话用本机 Claude Code 的登录，分支只能继续用 Claude 订阅"), { code: "bad_request" });
    const title = `${parent.title || "会话"} · 分支`;
    const forked = await this.withConfigDir(home, () => forkSession(parent.runtimeRef!, { dir: workspace.path, title }));
    const child = this.createSession({
      taskId: parent.taskId,
      topicId: parent.topicId,
      parentId: parent.id,
      kind: "fork",
      profileId: profile.id,
      workspaceId: parent.workspaceId,
      title,
      runtimeRef: forked.sessionId,
      options: parent.options,
    });
    rememberSessionLogin(this.store, child.id, home.login);
    return child;
  }

  /**
   * The Claude subscription's quota. With the local login: asked from the account (/api/oauth/usage, as Claude Code's
   * /usage does), at most every 30 seconds. With the token, which may not read it: what the sessions' rate_limit_event
   * messages said (percentages only near a limit, reset times).
   */
  async usage(profileId: Id, refresh = false): Promise<AccountUsage | null> {
    const profile = this.profile(profileId);
    if (!this.isSubscription(profile)) return null;
    if (readClaudeLogin(this.store) === "local") return this.accountUsage(profile, refresh);
    const windows = [...(this.usageCache.get(profileId)?.values() ?? [])];
    const note = windows.some((w) => w.usedPercent !== null)
      ? null
      : "用令牌登录时查不到用量百分比（setup-token 令牌没有这个权限），只显示 Claude 告诉的重置时间。在 设置 → 模型 改用本机 Claude Code 的登录后可以看到。";
    return { profileId, label: profile.label, windows, note, updatedAt: this.usageAt.get(profileId) ?? null };
  }

  private async accountUsage(profile: ModelProfile, refresh: boolean): Promise<AccountUsage> {
    const cached = this.accountUsageCache.get(profile.id);
    if (cached && (!refresh || Date.now() - cached.at < 30_000)) return cached.value;
    const base = { profileId: profile.id, label: profile.label };
    let value: AccountUsage;
    try {
      const token = localAccessToken(this.local.dir);
      if (!token) throw new ClaudeUsageError("没找到本机 Claude Code 的登录：在终端运行 claude 登录一次");
      const url = (profile.provider && this.options.providers[profile.provider]?.baseUrl) || "https://api.anthropic.com";
      const windows = await fetchClaudeUsage(url, token);
      value = { ...base, windows, note: windows.length ? null : "账号没有返回用量", updatedAt: new Date().toISOString() };
    } catch (err) {
      // Keep the last numbers, say why they are not fresh.
      const message = err instanceof ClaudeUsageError ? err.message : `读不到 Claude 的用量：${firstLine(err)}`;
      value = { ...base, windows: cached?.value.windows ?? [], note: message, updatedAt: cached?.value.updatedAt ?? null };
    }
    this.accountUsageCache.set(profile.id, { at: Date.now(), value });
    return value;
  }

  private recordRateLimit(sessionId: Id, info: { rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    const session = this.store.getSession(sessionId);
    if (!session || !info.rateLimitType) return;
    const labels: Record<string, string> = { ...CLAUDE_USAGE_LABELS, overage: "超额" };
    const used = typeof info.utilization === "number" ? (info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null;
    const windows = this.usageCache.get(session.profileId) ?? new Map<string, UsageWindow>();
    windows.set(info.rateLimitType, {
      label: labels[info.rateLimitType] ?? info.rateLimitType,
      usedPercent: used === null ? null : Math.round(used),
      resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
    });
    this.usageCache.set(session.profileId, windows);
    this.usageAt.set(session.profileId, new Date().toISOString());
  }

  /** The session's title in its transcript (what `claude --resume` lists); a session without a transcript yet keeps it here only. */
  async rename(sessionId: Id, title: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    const home = this.homeOf(sessionId);
    if (session.runtimeRef && this.hasTranscript(session.runtimeRef, home)) {
      const dir = this.store.getWorkspace(session.workspaceId)?.path;
      try {
        await this.withConfigDir(home, () => renameSession(session.runtimeRef!, title, dir ? { dir } : {}));
      } catch (err) {
        this.emit("log", `could not rename the Claude session of ${sessionId}: ${String(err)}`);
      }
    }
    return this.updateSession(sessionId, { title });
  }

  /** Switches model, effort or permissions; a running Claude Code process takes them at once. */
  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    this.requireSession(sessionId);
    const session = this.updateSession(sessionId, { options });
    const live = this.live.get(sessionId);
    if (live) {
      try {
        await live.q.setModel(options.model ?? this.profile(session.profileId).model ?? undefined);
        await live.q.setPermissionMode(claudePermissionMode(options.permission));
        await live.q.applyFlagSettings({ effortLevel: (options.effort as never) ?? null });
      } catch (err) {
        this.emit("log", `could not switch options of ${sessionId}: ${String(err)}`);
      }
    }
    return session;
  }

  /** Models: the provider's own list (GLM), or Claude Code's list for the account (asked without a model call). */
  async choices(profileId: Id): Promise<ProfileChoices> {
    const profile = this.profile(profileId);
    const base = { profileId, permissions: CLAUDE_PERMISSIONS, defaultPermission: CLAUDE_DEFAULT_PERMISSION };
    const provider = profile.provider ? this.options.providers[profile.provider] : undefined;
    if (provider?.models) return { ...base, models: provider.models.map((m) => ({ ...m, ...(m.id === profile.model ? { isDefault: true } : {}) })), source: "builtin" };
    const cacheKey = `${profileId}|${this.newHome(profile).login}`;
    const cached = this.modelCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60_000) return { ...base, models: cached.models, source: "cli" };
    try {
      const models = await this.askModels(profile);
      this.modelCache.set(cacheKey, { at: Date.now(), models });
      return { ...base, models, source: "cli" };
    } catch (err) {
      this.emit("log", `could not ask Claude Code for its models (${profileId}): ${firstLine(err)}`);
      return { ...base, models: CLAUDE_BUILTIN_MODELS, source: "builtin" };
    }
  }

  /** Starts Claude Code with no prompt just to read its model list (no model request is made), then closes it. */
  private async askModels(profile: ModelProfile): Promise<ModelOption[]> {
    const env = claudeEnv(profile, this.options.providers, this.options.credentials, this.newHome(profile), this.options.baseEnv);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* none(): AsyncGenerator<SDKUserMessage> {
      await gate;
    }
    const q = query({ prompt: none(), options: { cwd: this.options.claudeHome, env, settingSources: [], permissionMode: "default" } });
    try {
      const list = await Promise.race([q.supportedModels(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 20_000))]);
      return list.map((m) => ({
        id: m.value,
        label: m.value === "default" ? `默认（${m.resolvedModel ?? m.displayName}）` : m.displayName,
        ...(m.description ? { description: m.description } : {}),
        efforts: m.supportedEffortLevels ?? [],
        ...((profile.model ? m.value === profile.model : m.value === "default") ? { isDefault: true } : {}),
      }));
    } finally {
      release();
      q.close();
    }
  }

  async archive(sessionId: Id): Promise<Session[]> {
    const changed = this.store.archiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    await Promise.all(changed.map((s) => this.close(s.id)));
    return changed;
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    const changed = this.store.unarchiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    return changed;
  }

  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const live = this.live.get(sessionId);
    const pending = live?.approvals.get(approvalId);
    if (!live || !pending) throw new Error(`approval ${approvalId} is not pending`);
    live.approvals.delete(approvalId);
    if (decision === "decline" && pending.toolUseId) {
      live.declinedTools.add(pending.toolUseId);
      live.declinedByPerson.add(pending.toolUseId);
    }
    pending.resolve(decision === "accept" ? { behavior: "allow", updatedInput: pending.input } : { behavior: "deny", message: DECLINED });
    this.updateItem(pending.itemId, (item) => (item.type === "approval" ? { ...item, state: decision === "accept" ? "accepted" : "declined" } : item));
    this.afterWait(sessionId, live);
  }

  /**
   * Answers AskUserQuestion (allowed with the answers filled in, as Claude Code's own dialog does) or the plan review
   * of ExitPlanMode (approve: allowed, and the session leaves plan mode for 每次询问; revise: denied with the person's
   * feedback). Dismissing denies with a message that says so, and the model carries on.
   */
  async answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    const live = this.live.get(sessionId);
    const pending = live?.questions.get(itemId);
    if (!live || !pending) throw new Error(`question ${itemId} is not pending`);
    const settle = (patch: Partial<Extract<SessionItem, { type: "question" }>>) =>
      this.updateItem(itemId, (it) => (it.type === "question" && it.state === "pending" ? { ...it, ...patch } : it));
    if (pending.kind === "ask") {
      if (reply.action === "answer") {
        live.questions.delete(itemId);
        pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, ...claudeAnswers(pending.questions, reply.answers) } });
        settle({ state: "answered", answers: storedAnswers(pending.questions, reply.answers) });
      } else if (reply.action === "dismiss") {
        live.questions.delete(itemId);
        pending.resolve({ behavior: "deny", message: QUESTIONS_DISMISSED });
        settle({ state: "dismissed" });
      } else throw new Error(`questions take an answer, not ${reply.action}`);
    } else if (reply.action === "approve") {
      live.questions.delete(itemId);
      // Leave plan mode before the tool runs (it then finds the mode switched already), and remember the choice so
      // the permission picker shows it.
      const session = this.updateSession(sessionId, { options: { ...this.requireSession(sessionId).options, permission: CLAUDE_DEFAULT_PERMISSION } });
      await live.q.setPermissionMode(claudePermissionMode(session.options.permission)).catch((err: unknown) => this.emit("log", `could not leave plan mode in ${sessionId}: ${String(err)}`));
      pending.resolve({ behavior: "allow", updatedInput: pending.input });
      settle({ state: "answered" });
    } else if (reply.action === "revise") {
      live.questions.delete(itemId);
      pending.resolve({ behavior: "deny", message: planRevision(reply.feedback) });
      settle({ state: "answered", feedback: reply.feedback });
    } else if (reply.action === "dismiss") {
      live.questions.delete(itemId);
      pending.resolve({ behavior: "deny", message: PLAN_DISMISSED });
      settle({ state: "dismissed" });
    } else throw new Error(`a plan review takes approve or revise, not ${reply.action}`);
    this.afterWait(sessionId, live);
  }

  /**
   * Hands the session to a terminal: closes Studio's own process for it, remembers how far the transcript went, and
   * marks the session read-only. Returns what the terminal should run; the key is only in `env`.
   */
  async handoff(sessionId: Id): Promise<{ command: string; cwd: string; env: Record<string, string> }> {
    const session = this.writable(sessionId);
    if (this.live.get(sessionId)?.running) throw Object.assign(new Error("回复还在生成，等这一轮结束或先打断，再交给终端"), { code: "conflict" });
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
    const home = this.homeOf(sessionId);
    const env = claudeEnv(this.profile(session.profileId), this.options.providers, this.options.credentials, home, this.options.baseEnv);
    await this.close(sessionId);
    const ref = session.runtimeRef!;
    const seen = this.hasTranscript(ref, home) ? (await this.transcript(ref, workspace.path, home)).length : 0;
    this.store.setKv(handoffKey(sessionId), String(seen));
    this.updateSession(sessionId, { writer: "terminal-handoff" });
    // The same Claude Code build as the SDK, so the transcript format always matches; never the "auto" permission mode.
    const resume = this.hasTranscript(ref, home) ? `--resume ${ref}` : `--session-id ${ref}`;
    return { command: `& '${bundledClaudeExe()}' ${resume} --permission-mode default`, cwd: workspace.path, env };
  }

  /** Takes a handed-off session back and imports what the terminal added to the transcript. */
  async reclaim(sessionId: Id): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.writer !== "terminal-handoff") return session;
    const workspace = this.store.getWorkspace(session.workspaceId);
    const seen = Number(this.store.getKv(handoffKey(sessionId))?.value ?? "0") || 0;
    let added = 0;
    const home = this.homeOf(sessionId);
    if (workspace && session.runtimeRef && this.hasTranscript(session.runtimeRef, home)) {
      const messages = await this.transcript(session.runtimeRef, workspace.path, home);
      added = this.importTranscript(sessionId, messages.slice(seen));
    }
    this.store.setKv(handoffKey(sessionId), "");
    this.appendItem(sessionId, { type: "notice", level: "info", message: added ? `已从终端收回，导入了终端里新增的 ${added} 条内容。` : "已从终端收回。" });
    return this.updateSession(sessionId, { writer: "workbench" });
  }

  async attachInfo(): Promise<{ url: string; token: string; threadId: string }> {
    throw new Error("Claude sessions are handed to a terminal with `claude --resume` (S4-05), not attached");
  }

  setWriter(sessionId: Id, writer: Session["writer"]): Session {
    return this.updateSession(sessionId, { writer });
  }

  /** Closes every running query and waits for the processes to end (Host shutdown). Sessions resume on the next message. */
  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.wakeTimers.values()) clearTimeout(t);
    this.wakeTimers.clear();
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
    await Promise.all([...this.closing.values()]);
  }

  // ---- CLI features (stage 12, S12-E) -------------------------------------------------------------------------------

  /**
   * Claude Code's commands and skills for the session: from its running process, or else from a process started in
   * the project folder just to ask (no model request), kept for a while per profile and folder.
   */
  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    const session = this.requireSession(sessionId);
    const profile = this.profile(session.profileId);
    const live = this.live.get(sessionId);
    try {
      const list = live?.commands ?? (live ? await withTimeout(live.q.supportedCommands(), 15_000) : await this.probeCommands(session));
      return { commands: claudeCommands(list, this.skillNames.get(profile.id)) };
    } catch (err) {
      this.emit("log", `could not ask Claude Code for its commands (${sessionId}): ${firstLine(err)}`);
      return { commands: [], note: `读不到 Claude Code 的命令列表：${firstLine(err)}` };
    }
  }

  private async probeCommands(session: Session): Promise<SdkSlashCommand[]> {
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
    const key = `${session.profileId}|${workspace.path}`;
    const cached = this.commandCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.list;
    const env = claudeEnv(this.profile(session.profileId), this.options.providers, this.options.credentials, this.homeOf(session.id), this.options.baseEnv);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* none(): AsyncGenerator<SDKUserMessage> {
      await gate;
    }
    const q = query({ prompt: none(), options: { cwd: workspace.path, env, settingSources: CLI_SETTING_SOURCES, permissionMode: "default" } });
    try {
      const list = await withTimeout(q.supportedCommands(), 20_000);
      this.commandCache.set(key, { at: Date.now(), list });
      return list;
    } finally {
      release();
      q.close();
    }
  }

  /** Every command goes to Claude Code as the text `/name args` (compact included); it answers as for a message. */
  async runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    const sent = await this.sendMessage(sessionId, `/${name}${args ? ` ${args}` : ""}`);
    return { mode: sent.mode };
  }

  async stopBackground(sessionId: Id, taskId: string): Promise<void> {
    const live = this.live.get(sessionId);
    const item = this.store.listItems(sessionId).find((i) => i.type === "background" && i.taskId === taskId);
    if (!item || item.type !== "background") throw Object.assign(new Error(`background command ${taskId} not found`), { code: "not_found" });
    if (item.state !== "running") return;
    // Without its process the command is gone already.
    if (!live?.bgItems.has(taskId)) return this.settleBackground(item.id, "stopped");
    await live.q.stopTask(taskId);
  }

  /** Prompt suggestions follow the setting in running sessions too (the CLI's own setting of that name). */
  applyChatSettings(settings: ChatSettings): void {
    for (const [id, live] of this.live) {
      void live.q.applyFlagSettings({ promptSuggestionEnabled: settings.promptSuggestions } as never).catch((err: unknown) => this.emit("log", `could not apply chat settings to ${id}: ${firstLine(err)}`));
    }
  }

  // ---- the query ----------------------------------------------------------------------------------------------------

  private ensureLive(session: Session): Live {
    const existing = this.live.get(session.id);
    if (existing) return existing;
    const profile = this.profile(session.profileId);
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
    const ref = session.runtimeRef!;
    const home = this.homeOf(session.id);
    const agentsMd = agentsMdInstructions(workspace.path);

    const queue: Array<SDKUserMessage["message"]["content"]> = [];
    let wake: (() => void) | null = null;
    let ended = false;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (queue.length) yield { type: "user", message: { role: "user", content: queue.shift()! }, parent_tool_use_id: null, session_id: ref };
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    }

    const live: Live = {
      q: null as unknown as Query,
      done: Promise.resolve(),
      push: (content) => {
        queue.push(content);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
      running: false,
      ready: Promise.resolve(),
      interrupted: false,
      closedByHost: false,
      handlerErrors: new Set(),
      background: new Set(),
      idleTimer: null,
      turn: null,
      streaming: [],
      thinking: [],
      text: new Map(),
      blocks: new Map(),
      tools: new Map(),
      toolStarted: new Map(),
      declinedTools: new Set(),
      approvals: new Map(),
      questions: new Map(),
      questionTools: new Map(),
      askedTools: new Set(),
      subs: new Map(),
      backgroundSubs: new Set(),
      calls: new Map(),
      tasks: new Map(),
      bgItems: new Map(),
      compaction: null,
      retrying: false,
      notices: new Map(),
      commands: null,
      declinedByPerson: new Set(),
      agents: new Map(),
      resumes: new Map(),
      refused: null,
      limitText: null,
      scheduled: false,
      afterLimit: null,
      stopLoopAtEnd: false,
      sendingForStudio: false,
    };
    live.q = query({
      prompt: input(),
      options: {
        cwd: workspace.path,
        env: claudeEnv(profile, this.options.providers, this.options.credentials, home, this.options.baseEnv),
        // As in a terminal: CLAUDE.md, settings, hooks, commands and skills of the project and of the config dir (Studio's
        // own with the token, the person's with the local login).
        settingSources: CLI_SETTING_SOURCES,
        // Claude Code's own system prompt, as in a terminal (without it the SDK sends a one-line prompt), plus a project's
        // AGENTS.md when it has no CLAUDE.md.
        systemPrompt: { type: "preset", preset: "claude_code", ...(agentsMd ? { append: agentsMd } : {}) },
        permissionMode: claudePermissionMode(session.options.permission),
        // Lets the person switch to 全部允许 mid-session; the mode itself stays what the session chose.
        allowDangerouslySkipPermissions: true,
        ...(session.options.model ? { model: session.options.model } : {}),
        ...(session.options.effort ? { effort: session.options.effort as never } : {}),
        includePartialMessages: true,
        promptSuggestions: readChatSettings(this.store).promptSuggestions,
        canUseTool: (toolName, toolInput, ctx) => this.askPerson(session.id, live, toolName, toolInput, ctx),
        hooks: STRIP_SUBAGENT_MODE,
        ...this.mcpOptions(session.id),
        // A session that already has a transcript continues it; a new one starts under the id Studio chose.
        // The local login brings the person's config dir: only Studio's MCP server, not the ones they set up there.
        ...(home.login === "local" ? { strictMcpConfig: true } : {}),
        ...(this.hasTranscript(ref, home) ? { resume: ref } : { sessionId: ref }),
      },
    });
    // With CLAUDE_CODE_SUBPROCESS_ENV_SCRUB the CLI starts in "default" whatever --permission-mode says (CLI 2.1.296,
    // checked in S12-B); switching once it runs works, so a session in another mode switches before its first message.
    const mode = claudePermissionMode(session.options.permission);
    if (mode !== "default") {
      live.ready = live.q.setPermissionMode(mode).catch((err: unknown) => {
        this.emit("log", `could not set the permission mode of ${session.id}: ${String(err)}`);
      });
    }
    this.live.set(session.id, live);
    live.done = this.consume(session.id, live);
    return live;
  }

  private async consume(sessionId: Id, live: Live): Promise<void> {
    try {
      for await (const m of live.q) {
        try {
          this.onMessage(sessionId, live, m);
        } catch (err) {
          // One message Studio cannot handle stays a line in its conversation (and the log); the session goes on.
          this.emit("log", `failed to handle a ${m.type} message for ${sessionId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          if (!live.handlerErrors.has(m.type) && this.store.getSession(sessionId)) {
            live.handlerErrors.add(m.type);
            this.appendItem(sessionId, { type: "notice", level: "warning", message: `Studio 处理 Claude 的一条消息（${m.type}）时出错，这条可能没显示出来：${firstLine(err)}。详情在 host.log。` });
          }
        }
      }
      this.finish(sessionId, live, null);
    } catch (err) {
      this.finish(sessionId, live, err);
    }
  }

  /** The query ended: normally (closed), after an interrupt, or with an error. */
  private finish(sessionId: Id, live: Live, err: unknown): void {
    if (this.live.get(sessionId) === live) this.live.delete(sessionId);
    this.clearIdle(live);
    for (const id of live.streaming) this.updateItem(id, (it) => (it.type === "agent" ? { ...it, markdown: live.text.get(id) ?? it.markdown, streaming: false } : it));
    for (const t of live.thinking) this.updateItem(t.itemId, (it) => (it.type === "reasoning" ? { ...it, text: live.text.get(t.itemId) ?? it.text, streaming: false } : it));
    this.endTurn(live, err && !live.interrupted ? "failed" : "interrupted");
    for (const a of live.approvals.values()) this.updateItem(a.itemId, (it) => (it.type === "approval" && it.state === "pending" ? { ...it, state: "resolved-elsewhere" } : it));
    for (const question of live.questions.values()) this.cancelQuestion(question.itemId);
    live.questions.clear();
    for (const id of live.tools.values()) this.updateItem(id, (it) => (it.type === "tool" && it.status === "running" ? { ...it, status: "failed" } : it));
    // Background commands end with their Claude Code process.
    for (const id of live.bgItems.values()) this.settleBackground(id, "stopped");
    if (live.compaction) this.updateItem(live.compaction, (it) => (it.type === "compaction" && it.state === "running" ? { ...it, state: "failed" } : it));
    for (const childId of live.subs.values()) {
      if (this.store.getSession(childId)?.status === "running") this.setStatus(childId, err && !live.interrupted ? "error" : "idle");
    }
    if (!this.store.getSession(sessionId)) return;
    // Its CLI's timers went with the process: Studio's own takes over (see studioWakeDue).
    if (this.store.getSession(sessionId)?.wake) this.armWake(sessionId);
    if (err && !live.interrupted) {
      this.appendItem(sessionId, { type: "error", message: `Claude 会话异常结束：${firstLine(err)}` }, { method: "query/error" });
      this.setStatus(sessionId, "error");
    } else if (live.running || live.interrupted) {
      if (live.closedByHost && !live.interrupted) {
        this.appendItem(sessionId, { type: "notice", level: "warning", message: "Host 关闭时这条会话的回复被中断了。发一条消息即可接着对话。" });
      }
      this.setStatus(sessionId, "idle");
    }
  }

  private close(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return this.closing.get(sessionId) ?? Promise.resolve();
    this.live.delete(sessionId);
    this.clearIdle(live);
    live.closedByHost = true;
    live.end();
    live.q.close();
    const done = live.done.finally(() => {
      if (this.closing.get(sessionId) === done) this.closing.delete(sessionId);
    });
    this.closing.set(sessionId, done);
    return done;
  }

  private onMessage(sessionId: Id, live: Live, m: SDKMessage): void {
    const parentToolUse = "parent_tool_use_id" in m ? m.parent_tool_use_id : null;
    if (parentToolUse) return this.onSubagentMessage(sessionId, live, parentToolUse, m);
    switch (m.type) {
      case "rate_limit_event": {
        const info = (m as { rate_limit_info: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number } }).rate_limit_info;
        this.recordRateLimit(sessionId, info);
        if (info.status === "rejected") live.refused = { ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}), ...(info.rateLimitType ? { type: info.rateLimitType } : {}) };
        return;
      }
      case "stream_event": {
        const e = m.event as { type: string; index?: number; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string }; usage?: { output_tokens?: number } };
        // The speed: each model call from its first output (any block) to its end, with its output tokens.
        if (e.type === "message_start") live.call = { firstAt: null, tokens: 0 };
        else if (live.call && live.call.firstAt === null && (e.type === "content_block_start" || e.type === "content_block_delta")) live.call.firstAt = this.now().getTime();
        else if (live.call && e.type === "message_delta" && typeof e.usage?.output_tokens === "number") live.call.tokens = e.usage.output_tokens;
        else if (live.call && e.type === "message_stop") {
          const call = live.call;
          live.call = null;
          if (call.firstAt !== null && call.tokens > 0 && live.turn) this.addDecode(live.turn.itemId, this.now().getTime() - call.firstAt, call.tokens);
        }
        if (e.type === "message_start") {
          if (!live.running) this.turnStarted(sessionId, live);
          this.clearRetry(live);
          live.blocks.clear();
        } else if (e.type === "content_block_start" && e.content_block?.type === "text") {
          const item = this.appendItem(sessionId, { type: "agent", markdown: "", streaming: true }, { method: "stream/text" });
          live.blocks.set(e.index ?? 0, item.id);
          live.streaming.push(item.id);
        } else if (e.type === "content_block_start" && e.content_block?.type === "thinking") {
          const item = this.appendItem(sessionId, { type: "reasoning", text: "", streaming: true }, { method: "stream/thinking" });
          live.blocks.set(e.index ?? 0, item.id);
          live.thinking.push({ itemId: item.id, startedAt: this.now().getTime() });
        } else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
          const itemId = live.blocks.get(e.index ?? 0);
          if (!itemId) return;
          live.text.set(itemId, (live.text.get(itemId) ?? "") + e.delta.thinking);
          this.emitTransient({ type: "item.delta", sessionId, itemId, append: e.delta.thinking });
        } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          const itemId = live.blocks.get(e.index ?? 0);
          if (!itemId) return;
          live.text.set(itemId, (live.text.get(itemId) ?? "") + e.delta.text);
          this.emitTransient({ type: "item.delta", sessionId, itemId, append: e.delta.text });
        }
        return;
      }
      case "assistant": {
        if (!live.running) this.turnStarted(sessionId, live);
        this.clearRetry(live);
        // A command that runs without the model (/cost, /context…): its output comes as an assistant message marked
        // with the stdout it was made from (CLI 2.1.296; spikes/s12-e-claude-cli.mjs).
        if ((m as { local_command_source?: unknown }).local_command_source !== undefined) {
          const output = m.message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
          const name = this.lastCommand.get(sessionId) ?? "";
          this.appendItem(sessionId, { type: "command", name, output: localCommandText(output) }, { method: "local_command" });
          return;
        }
        const used = (m.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
        if (used) live.context = (used.input_tokens ?? 0) + (used.cache_read_input_tokens ?? 0) + (used.cache_creation_input_tokens ?? 0) + (used.output_tokens ?? 0);
        for (const block of m.message.content) {
          if (block.type === "thinking") {
            // Settles the oldest thinking item still streaming, like text below.
            const t = live.thinking.shift();
            const text = block.thinking;
            if (t) {
              live.text.delete(t.itemId);
              this.updateItem(t.itemId, (it) => (it.type === "reasoning" ? { ...it, text, streaming: false, durationMs: this.now().getTime() - t.startedAt } : it));
            } else if (text.trim()) {
              this.appendItem(sessionId, { type: "reasoning", text, streaming: false }, { method: "assistant" });
            }
          } else if (block.type === "text") {
            // The CLI's own message when a usage limit stops the turn (a synthetic assistant message, no stream).
            if ((m as { error?: string }).error === "rate_limit" || isUsageLimitText(block.text)) live.limitText = block.text.trim();
            // One assistant message per completed block; it settles the oldest text item still streaming.
            const itemId = live.streaming.shift();
            if (itemId) {
              live.text.delete(itemId);
              this.updateItem(itemId, (it) => (it.type === "agent" ? { ...it, markdown: block.text, streaming: false } : it));
            } else {
              this.appendItem(sessionId, { type: "agent", markdown: block.text, streaming: false }, { method: "assistant" });
            }
          } else if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            live.calls.set(block.id, { name: block.name, input });
            if (block.name === "Agent" || block.name === "Task") this.startSubagent(sessionId, live, block.id, input);
            // The question item stands for these calls; a row is added only if they never reach the person.
            else if (QUESTION_TOOLS.has(block.name)) live.questionTools.set(block.id, { name: block.name, input });
            else {
              this.addToolCard(sessionId, live, block.id, block.name, input);
              if (block.name === "SendMessage") this.messageToAgent(sessionId, live, input);
            }
          }
        }
        return;
      }
      case "user": {
        const content = m.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const child = live.subs.get(block.tool_use_id);
          if (child) {
            // A foreground subagent's final reply is not streamed: it only comes back in the Agent call's result.
            const result = (m as { tool_use_result?: { status?: string; content?: unknown } }).tool_use_result;
            const reply = result?.status === "completed" ? toolResultText(result.content).trim() : "";
            const shown = this.store.listItems(child).some((i) => i.type === "agent" && i.markdown.trim() === reply);
            if (reply && !shown) this.appendItem(child, { type: "agent", markdown: reply, streaming: false }, { method: "agent/result", itemId: block.tool_use_id });
            // A background subagent's result only says it was launched; its task notification ends it.
            if (!live.backgroundSubs.has(block.tool_use_id) || result?.status === "completed") this.setStatus(child, block.is_error ? "error" : "completed");
            continue;
          }
          const asked = live.questionTools.get(block.tool_use_id);
          if (asked) {
            live.questionTools.delete(block.tool_use_id);
            if (live.askedTools.delete(block.tool_use_id)) continue;
            // Rejected before it reached the person (bad input, not in plan mode…): show the call and its error.
            this.addToolCard(sessionId, live, block.tool_use_id, asked.name, asked.input);
          }
          this.settleToolCard(live, block.tool_use_id, block.content, block.is_error === true);
          const call = live.calls.get(block.tool_use_id);
          const toolResult = (m as { tool_use_result?: unknown }).tool_use_result;
          if (call?.name === "ScheduleWakeup" && block.is_error !== true) this.onScheduleWakeup(sessionId, live, call.input, toolResult);
          if (call?.name === "SendMessage" && block.is_error !== true) this.onAgentResumed(sessionId, live, block.tool_use_id, toolResult);
          // A command sent to the background: its result names the file its output goes to.
          const bg = [...live.tasks].find(([, t]) => t.toolUseId === block.tool_use_id);
          const bgItem = bg ? live.bgItems.get(bg[0]) : undefined;
          const outputFile = /Output is being written to:\s*(\S.*?\.output)\b/.exec(toolResultText(block.content))?.[1];
          if (bgItem && outputFile) this.updateItem(bgItem, (it) => (it.type === "background" && !it.outputFile ? { ...it, outputFile } : it));
        }
        return;
      }
      case "system":
        return this.onSystem(sessionId, live, m);
      case "prompt_suggestion": {
        const text = (m as { suggestion?: string }).suggestion?.trim();
        if (text && readChatSettings(this.store).promptSuggestions) this.appendItem(sessionId, { type: "suggestion", text: text.slice(0, 500) }, { method: "prompt_suggestion" });
        return;
      }
      case "tool_use_summary": {
        // The CLI's one-line summary of the calls before it: shown on the last of them.
        const ids = (m as { preceding_tool_use_ids?: string[] }).preceding_tool_use_ids ?? [];
        const summary = (m as { summary?: string }).summary?.trim();
        const itemId = [...ids].reverse().map((id) => live.calls.get(id)?.itemId).find(Boolean);
        if (summary && itemId) this.updateItem(itemId, (it) => (it.type === "tool" ? { ...it, progress: summary } : it));
        return;
      }
      case "result": {
        live.running = false;
        this.clearRetry(live);
        // A stream the CLI never completed (a refused response is withheld) ends with the turn.
        for (const id of live.streaming.splice(0)) {
          const text = live.text.get(id) ?? "";
          live.text.delete(id);
          this.updateItem(id, (it) => (it.type === "agent" ? { ...it, markdown: it.markdown || text, streaming: false } : it));
        }
        for (const t of live.thinking.splice(0)) {
          const text = live.text.get(t.itemId) ?? "";
          live.text.delete(t.itemId);
          this.updateItem(t.itemId, (it) => (it.type === "reasoning" ? { ...it, text: it.text || text, streaming: false } : it));
        }
        const usage = (m as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
        // The largest context among the models the turn used (subagents may use smaller ones).
        const windows = Object.values((m as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {}).map((u) => u.contextWindow ?? 0);
        const contextWindow = windows.length ? Math.max(...windows) : 0;
        this.endTurn(live, live.interrupted ? "interrupted" : m.is_error ? "failed" : "completed", usage, contextWindow || undefined);
        const limited = live.limitText !== null;
        if (live.interrupted) {
          live.interrupted = false;
          this.setStatus(sessionId, "idle");
        } else if (limited) {
          // A usage limit: the CLI has said so in the conversation; the wake bar shows when it resets.
          this.setStatus(sessionId, "idle");
        } else if (m.is_error) {
          const errors = (m as { errors?: string[] }).errors;
          // A refusal has said so already (its notices and the CLI's own message).
          const refused = (m as { stop_reason?: string | null }).stop_reason === "refusal";
          if (!refused || errors?.length) this.appendItem(sessionId, { type: "error", message: errors?.join("\n") || `回合出错（${m.subtype}）` }, { method: "result" });
          this.setStatus(sessionId, "error");
        } else {
          this.setStatus(sessionId, "idle");
        }
        this.wakeAfterTurn(sessionId, live);
        if (live.stopLoopAtEnd) {
          void this.close(sessionId);
          return;
        }
        this.scheduleIdle(sessionId, live);
        return;
      }
      default:
        // Not shown: tool_progress (a running row shows its own elapsed time), auth_status, hook_progress,
        // thinking-token counts, conversation_reset (/clear is refused), worker_shutting_down.
        return;
    }
  }

  /** System messages: tasks (subagents, background commands), compaction, retries, notices, the command list. */
  private onSystem(sessionId: Id, live: Live, m: SDKMessage): void {
    const s = m as unknown as Record<string, unknown> & { subtype: string };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    switch (s.subtype) {
      case "init": {
        const session = this.store.getSession(sessionId);
        if (session && Array.isArray(s.skills)) this.skillNames.set(session.profileId, new Set((s.skills as unknown[]).filter((x): x is string => typeof x === "string")));
        return;
      }
      case "commands_changed": {
        if (Array.isArray(s.commands)) live.commands = s.commands as SdkSlashCommand[];
        return;
      }
      case "task_started": {
        const taskId = str(s.task_id);
        if (!taskId) return;
        const toolUseId = str(s.tool_use_id) || undefined;
        live.background.add(taskId);
        live.tasks.set(taskId, { ...(toolUseId ? { toolUseId } : {}), description: str(s.description), ...(str(s.task_type) ? { type: str(s.task_type) } : {}) });
        if (toolUseId && live.subs.has(toolUseId)) {
          live.backgroundSubs.add(toolUseId);
          live.agents.set(taskId, toolUseId);
        }
        // An agent resumed with SendMessage starts again under the same task id.
        const resumed = (toolUseId ? live.resumes.get(toolUseId) : undefined) ?? this.agentChild(live, taskId);
        if (resumed) this.setStatus(resumed, "running");
        if (s.is_backgrounded === true) this.startBackground(sessionId, live, taskId);
        return;
      }
      case "task_updated": {
        const taskId = str(s.task_id);
        const patch = (s.patch ?? {}) as { status?: string; is_backgrounded?: boolean; error?: string };
        // A foreground command sent to the background while it ran.
        if (patch.is_backgrounded === true && !live.bgItems.has(taskId)) this.startBackground(sessionId, live, taskId);
        const itemId = live.bgItems.get(taskId);
        const state: BackgroundState | null = patch.status === "completed" ? "completed" : patch.status === "failed" ? "failed" : patch.status === "killed" ? "stopped" : null;
        if (itemId && state) this.settleBackground(itemId, state, patch.error);
        return;
      }
      case "task_notification": {
        const taskId = str(s.task_id);
        if (!taskId) return;
        live.background.delete(taskId);
        const toolUseId = str(s.tool_use_id);
        // A resumed agent's notification names the SendMessage call that resumed it.
        const child = (toolUseId ? (live.subs.get(toolUseId) ?? live.resumes.get(toolUseId)) : undefined) ?? this.agentChild(live, taskId);
        if (child) this.setStatus(child, s.status === "completed" ? "completed" : s.status === "stopped" ? "idle" : "error");
        const itemId = live.bgItems.get(taskId);
        if (itemId) {
          const state: BackgroundState = s.status === "completed" ? "completed" : s.status === "stopped" ? "stopped" : "failed";
          // task_updated may have ended it already; the notification still brings the summary and the output file.
          this.updateItem(itemId, (it) =>
            it.type === "background"
              ? {
                  ...it,
                  ...(it.state === "running" ? { state, endedAt: this.now().toISOString() } : {}),
                  ...(str(s.summary) ? { summary: str(s.summary) } : {}),
                  ...(str(s.output_file) && !it.outputFile ? { outputFile: str(s.output_file) } : {}),
                }
              : it,
          );
          live.bgItems.delete(taskId);
        }
        live.tasks.delete(taskId);
        return;
      }
      case "status": {
        if (s.status === "compacting" && !live.compaction) {
          if (!live.running) this.turnStarted(sessionId, live);
          live.compaction = this.appendItem(sessionId, { type: "compaction", state: "running" }, { method: "status/compacting" }).id;
        } else if (s.compact_result === "failed") {
          const error = str(s.compact_error);
          const failed = { state: "failed" as const, ...(error ? { error } : {}) };
          if (live.compaction) this.updateItem(live.compaction, (it) => (it.type === "compaction" ? { ...it, ...failed } : it));
          else this.appendItem(sessionId, { type: "compaction", ...failed }, { method: "status/compact_failed" });
          live.compaction = null;
        }
        return;
      }
      case "compact_boundary": {
        const meta = (s.compact_metadata ?? {}) as { trigger?: "manual" | "auto"; pre_tokens?: number; post_tokens?: number };
        const fields = {
          state: "completed" as const,
          ...(meta.trigger ? { trigger: meta.trigger } : {}),
          ...(typeof meta.pre_tokens === "number" ? { beforeTokens: meta.pre_tokens } : {}),
          ...(typeof meta.post_tokens === "number" ? { afterTokens: meta.post_tokens } : {}),
        };
        if (live.compaction) this.updateItem(live.compaction, (it) => (it.type === "compaction" ? { ...it, ...fields } : it));
        else this.appendItem(sessionId, { type: "compaction", ...fields }, { method: "compact_boundary" });
        live.compaction = null;
        // The context readout follows what is left after compacting.
        if (typeof meta.post_tokens === "number") live.context = meta.post_tokens;
        return;
      }
      case "api_retry": {
        const reason = retryReason(str(s.error), typeof s.error_status === "number" ? s.error_status : null);
        this.setRetry(live, { attempt: Number(s.attempt) || 1, ...(typeof s.max_retries === "number" ? { max: s.max_retries } : {}), reason });
        return;
      }
      case "model_refusal_fallback":
        return this.notice(sessionId, live, "warning", `模型 ${str(s.original_model)} 拒绝了这次请求，已改用 ${str(s.fallback_model)}。`, "refusal");
      case "model_refusal_no_fallback": {
        const why = str(s.api_refusal_explanation);
        return this.notice(sessionId, live, "warning", `模型 ${str(s.original_model)} 拒绝了这次请求${why ? `：${why}` : "。"}`, "refusal");
      }
      case "permission_denied": {
        if (live.declinedByPerson.has(str(s.tool_use_id))) return;
        const message = str(s.message) || str(s.decision_reason);
        return this.notice(sessionId, live, "warning", `${str(s.tool_name)} 没有获准运行${message ? `：${message}` : "。"}`, `denied:${str(s.tool_name)}`);
      }
      case "notification": {
        // Low-priority ones are the terminal UI's hints.
        if (s.priority === "low" || !str(s.text)) return;
        return this.notice(sessionId, live, s.priority === "high" || s.priority === "immediate" ? "warning" : "info", str(s.text), `notification:${str(s.key)}`);
      }
      case "informational": {
        if (s.level === "suggestion" || !str(s.content)) return;
        return this.notice(sessionId, live, s.level === "warning" ? "warning" : "info", str(s.content), `informational:${str(s.tag) || str(s.content)}`);
      }
      case "hook_response": {
        // Hooks only show when they fail or block (exit code 2).
        const blocked = s.exit_code === 2;
        if (s.outcome !== "error" && !blocked) return;
        const detail = firstLine(str(s.stderr) || str(s.output) || str(s.stdout));
        return this.notice(sessionId, live, "warning", `Hook ${str(s.hook_name)}（${str(s.hook_event)}）${blocked ? "拦截了这一步" : "运行失败"}${detail ? `：${detail}` : "。"}`, `hook:${str(s.hook_name)}`);
      }
      default:
        // hook_started, session_state_changed, files_persisted, memory_recall, mirror_error… are not shown.
        return;
    }
  }

  /** A background command: a `background` item the composer lists until it ends. */
  private startBackground(sessionId: Id, live: Live, taskId: string): void {
    const task = live.tasks.get(taskId);
    // Subagents sent to the background stay in the session tree; only commands are listed.
    if (!task || (task.type && task.type !== "local_bash") || (task.toolUseId && live.subs.has(task.toolUseId))) return;
    const call = task.toolUseId ? live.calls.get(task.toolUseId) : undefined;
    const command = typeof call?.input.command === "string" ? call.input.command : task.description;
    const item = this.appendItem(
      sessionId,
      { type: "background", taskId, command, ...(task.description && task.description !== command ? { description: task.description } : {}), state: "running", startedAt: this.now().toISOString() },
      { method: "task_started", ...(task.toolUseId ? { itemId: task.toolUseId } : {}) },
    );
    live.bgItems.set(taskId, item.id);
  }

  private settleBackground(itemId: Id, state: BackgroundState, summary?: string): void {
    this.updateItem(itemId, (it) => (it.type === "background" && it.state === "running" ? { ...it, state, endedAt: this.now().toISOString(), ...(summary ? { summary } : {}) } : it));
  }

  /** A notice row; the same key again in this turn updates that row (with a count) instead of adding another. */
  private notice(sessionId: Id, live: Live, level: "info" | "warning", message: string, key: string): void {
    const known = live.notices.get(key);
    const current = known ? this.store.getItem(known) : undefined;
    if (current?.type === "notice") {
      this.updateItem(current.id, (it) => (it.type === "notice" ? { ...it, level, message, count: (it.count ?? 1) + 1 } : it));
      return;
    }
    live.notices.set(key, this.appendItem(sessionId, { type: "notice", level, message, key }, { method: "notice" }).id);
  }

  private setRetry(live: Live, retry: TurnRetry): void {
    if (!live.turn) return;
    live.retrying = true;
    this.updateItem(live.turn.itemId, (it) => (it.type === "turn" ? { ...it, retry } : it));
  }

  private clearRetry(live: Live): void {
    if (!live.retrying || !live.turn) return;
    live.retrying = false;
    this.updateItem(live.turn.itemId, (it) => {
      if (it.type !== "turn" || !it.retry) return it;
      const { retry: _gone, ...rest } = it;
      return rest;
    });
  }

  /** An Agent call: a child session in the tree and a summary line in the parent, instead of a tool card. */
  private startSubagent(sessionId: Id, live: Live, toolUseId: string, input: Record<string, unknown>): void {
    const parent = this.requireSession(sessionId);
    const name = String(input.description ?? input.subagent_type ?? "子 agent");
    const child = this.createSession({
      taskId: parent.taskId,
      topicId: parent.topicId,
      parentId: parent.id,
      kind: "sub",
      profileId: parent.profileId,
      workspaceId: parent.workspaceId,
      title: name,
      runtimeRef: `${parent.runtimeRef}/agent/${toolUseId}`,
      options: parent.options,
    });
    this.setStatus(child.id, "running");
    if (typeof input.prompt === "string" && input.prompt) this.appendItem(child.id, { type: "user", text: input.prompt }, { method: "agent/prompt", itemId: toolUseId });
    live.subs.set(toolUseId, child.id);
    this.appendItem(sessionId, { type: "subagent", childSessionId: child.id, summary: name }, { method: "tool_use", itemId: toolUseId });
  }

  /**
   * Messages of a subagent (parent_tool_use_id set) go into its child session. Its partial stream is not shown. An agent
   * started by an earlier Claude Code process of this session (resumed with SendMessage after an idle close or a usage
   * limit) still finds its child session, by the Agent call in the child's runtimeRef.
   */
  private onSubagentMessage(sessionId: Id, live: Live, parentToolUse: string, m: SDKMessage): void {
    const child = live.subs.get(parentToolUse) ?? this.adoptChild(sessionId, live, parentToolUse);
    if (!child) return;
    if (m.type === "assistant" || m.type === "user") {
      const s = this.store.getSession(child);
      if (s && s.status !== "running") this.setStatus(child, "running");
    }
    if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "text" && block.text) this.appendItem(child, { type: "agent", markdown: block.text, streaming: false }, { method: "assistant" });
        else if (block.type === "tool_use") this.addToolCard(child, live, block.id, block.name, block.input as Record<string, unknown>);
      }
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_result") this.settleToolCard(live, block.tool_use_id, block.content, block.is_error === true);
      }
    }
  }

  /** The child session an earlier process of this session made for this Agent call; registered with this process. */
  private adoptChild(sessionId: Id, live: Live, toolUseId: string): Id | undefined {
    const parent = this.store.getSession(sessionId);
    if (!parent?.runtimeRef) return undefined;
    const child = this.store.findSessionByRuntimeRef("claude", `${parent.runtimeRef}/agent/${toolUseId}`);
    if (!child || child.parentId !== sessionId) return undefined;
    live.subs.set(toolUseId, child.id);
    live.backgroundSubs.add(toolUseId);
    return child.id;
  }

  /** A background agent's child session, by its agent id (the CLI's task id). */
  private agentChild(live: Live, agentId: string, sessionId?: Id): Id | undefined {
    let toolUseId = live.agents.get(agentId);
    if (!toolUseId && sessionId) {
      const ref = this.store.getSession(sessionId)?.runtimeRef;
      toolUseId = ref ? (agentToolUseId(this.homeOf(sessionId).dir, ref, agentId) ?? undefined) : undefined;
      if (toolUseId) live.agents.set(agentId, toolUseId);
    }
    if (!toolUseId) return undefined;
    return live.subs.get(toolUseId) ?? (sessionId ? this.adoptChild(sessionId, live, toolUseId) : undefined);
  }

  /** SendMessage to one of the session's agents: the message shows in the agent's child session, as its next prompt. */
  private messageToAgent(sessionId: Id, live: Live, input: Record<string, unknown>): void {
    const to = typeof input.to === "string" ? input.to : "";
    const text = typeof input.message === "string" ? input.message : "";
    if (!to || !text) return;
    const child = this.agentChild(live, to, sessionId);
    if (child) this.appendItem(child, { type: "user", text }, { method: "agent/message" });
  }

  /** SendMessage resumed a stopped agent: its child session runs again, and the agent's next notification ends it. */
  private onAgentResumed(sessionId: Id, live: Live, toolUseId: string, result: unknown): void {
    const agentId = (result as { resumedAgentId?: unknown } | null | undefined)?.resumedAgentId;
    if (typeof agentId !== "string") return;
    const child = this.agentChild(live, agentId, sessionId);
    if (!child) return;
    live.resumes.set(toolUseId, child);
    this.setStatus(child, "running");
  }

  // ---- wake: the agent's /loop and usage limits (stage 15) -----------------------------------------------------------

  private onScheduleWakeup(sessionId: Id, live: Live, input: Record<string, unknown>, result: unknown): void {
    live.scheduled = true;
    if (live.stopLoopAtEnd) return;
    const next = loopFromScheduleWakeup(input, result, this.now());
    const wake = this.store.getSession(sessionId)?.wake ?? {};
    const { loop: _old, ...rest } = wake;
    this.setWake(sessionId, next.stop ? rest : { ...rest, loop: next.loop });
  }

  /** At the end of a turn: a usage limit to wait for, or a loop that has ended (its wakeup fired and was not renewed). */
  private wakeAfterTurn(sessionId: Id, live: Live): void {
    const wake = this.store.getSession(sessionId)?.wake ?? null;
    const now = this.now();
    if (live.stopLoopAtEnd) {
      this.setWake(sessionId, null);
    } else if (live.limitText !== null) {
      const resetsAt = this.limitResetsAt(sessionId, live);
      // In a loop Studio goes on after the reset by default; otherwise as the person last chose for this session.
      const autoContinue = this.autoContinueChoice.get(sessionId) ?? !!wake?.loop;
      this.setWake(sessionId, { ...(wake?.loop ? { loop: wake.loop } : {}), limit: { resetsAt, message: live.limitText, autoContinue } });
      this.emit("log", `usage limit in ${sessionId}: resets ${resetsAt ?? "(unknown)"}, Studio continues: ${autoContinue}`);
    } else {
      if (live.afterLimit) this.emit("log", `${sessionId} went on after its usage limit (turn started by ${live.afterLimit})`);
      if (wake?.loop && !live.scheduled && Date.parse(wake.loop.at) <= now.getTime()) {
        const { loop: _done, ...rest } = wake;
        this.setWake(sessionId, rest);
      }
    }
    live.limitText = null;
    live.scheduled = false;
    live.afterLimit = null;
    live.refused = null;
  }

  /** When the usage limit that stopped this turn resets: from the refusal, else a quota window known to be used up. */
  private limitResetsAt(sessionId: Id, live: Live): string | null {
    if (live.refused?.resetsAt) return new Date(live.refused.resetsAt * 1000).toISOString();
    const profileId = this.store.getSession(sessionId)?.profileId;
    const windows = profileId ? [...(this.usageCache.get(profileId)?.values() ?? [])] : [];
    const now = this.now().getTime();
    const full = windows.filter((w) => (w.usedPercent ?? 0) >= 100 && w.resetsAt && Date.parse(w.resetsAt) > now).map((w) => Date.parse(w.resetsAt!));
    return full.length ? new Date(Math.max(...full)).toISOString() : null;
  }

  /** A turn starts: a usage limit it was waiting for is over (whoever started it: the CLI, Studio or the person). */
  private wakeOnTurnStart(sessionId: Id, live: Live, by: "cli" | "person"): void {
    const wake = this.store.getSession(sessionId)?.wake;
    live.afterLimit = wake?.limit ? (by === "person" && live.sendingForStudio ? "studio" : by) : null;
    live.sendingForStudio = false;
    if (wake?.limit) {
      const { limit: _over, ...rest } = wake;
      this.setWake(sessionId, rest);
    }
  }

  private setWake(sessionId: Id, wake: Session["wake"]): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const next = wake && (wake.loop || wake.limit) ? wake : null;
    if (JSON.stringify(session.wake ?? null) !== JSON.stringify(next)) this.updateSession(sessionId, { wake: next });
    this.armWake(sessionId);
  }

  /** Studio's own timer for the session's wake (see studioWakeDue): replaced on every change. */
  private armWake(sessionId: Id): void {
    const old = this.wakeTimers.get(sessionId);
    if (old) clearTimeout(old);
    this.wakeTimers.delete(sessionId);
    const session = this.store.getSession(sessionId);
    if (!session || session.archivedAt || this.shuttingDown) return;
    const due = this.wakeDue(session);
    if (!due) return;
    // setTimeout holds at most ~24.8 days; a later time is checked again then.
    const delay = Math.min(Math.max(0, due.at - this.now().getTime()), 2 ** 31 - 1);
    const timer = setTimeout(() => {
      this.wakeTimers.delete(sessionId);
      void this.fireWake(sessionId, due.at);
    }, delay);
    timer.unref?.();
    this.wakeTimers.set(sessionId, timer);
  }

  /** studioWakeDue, never sooner than WAKE_MIN_GAP_MS after Studio's last one (a reset time that is off cannot make it spin). */
  private wakeDue(session: Session): ReturnType<typeof studioWakeDue> {
    const due = studioWakeDue(session.wake, this.live.has(session.id), this.now());
    const last = this.lastStudioWake.get(session.id);
    return due && last !== undefined ? { ...due, at: Math.max(due.at, last + WAKE_MIN_GAP_MS) } : due;
  }

  /** Studio starts the session's next turn itself: the CLI did not (or its process is gone). */
  private async fireWake(sessionId: Id, plannedAt: number): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session || session.archivedAt || session.writer !== "workbench") return;
    const due = this.wakeDue(session);
    // Changed since (a turn ran, the person stepped in) or not yet: armed again for what holds now.
    if (!due || due.at !== plannedAt) return this.armWake(sessionId);
    if (due.at > this.now().getTime()) return this.armWake(sessionId);
    // Busy: the turn's end arms the timer again.
    if (this.live.get(sessionId)?.running) return;
    this.emit("log", `Studio wakes ${sessionId} (${due.why})`);
    this.lastStudioWake.set(sessionId, this.now().getTime());
    if (due.why === "loop") {
      // The wakeup Studio sends replaces the CLI's (gone with its process, or late): the loop's next ScheduleWakeup sets it again.
      const { loop: _sent, ...rest } = session.wake ?? {};
      this.updateSession(sessionId, { wake: rest.limit ? rest : null });
    }
    try {
      await this.closing.get(sessionId);
      const live = this.ensureLive(this.requireSession(sessionId));
      live.sendingForStudio = true;
      await this.sendMessage(sessionId, due.text);
    } catch (err) {
      this.emit("log", `Studio could not wake ${sessionId}: ${firstLine(err)}`);
      this.appendItem(sessionId, { type: "notice", level: "warning", message: `Studio 没能自动继续这条会话：${firstLine(err)}` });
    }
  }

  /** The person: stop the loop (and Studio's own continuation), or switch auto-continue after a usage limit. */
  async setWakeChoice(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (choice.stopLoop) {
      const live = this.live.get(sessionId);
      this.setWake(sessionId, null);
      // The CLI's own wakeup lives in its process: it goes with it (now, or when the running turn ends).
      if (live?.running) live.stopLoopAtEnd = true;
      else if (live) await this.close(sessionId);
      this.appendItem(sessionId, { type: "notice", level: "info", message: "你在 Studio 里停止了这条会话的 loop。" });
    } else if (typeof choice.autoContinue === "boolean") {
      this.autoContinueChoice.set(sessionId, choice.autoContinue);
      if (session.wake?.limit) this.setWake(sessionId, { ...session.wake, limit: { ...session.wake.limit, autoContinue: choice.autoContinue } });
    }
    return this.requireSession(sessionId);
  }

  private addToolCard(sessionId: Id, live: Live, toolUseId: string, name: string, input: Record<string, unknown>): void {
    const created = this.appendItem(sessionId, { type: "tool", ...describeToolUse(name, input, this.cwdOf(sessionId)), status: "running" }, { method: "tool_use", itemId: toolUseId });
    live.tools.set(toolUseId, created.id);
    live.calls.set(toolUseId, { name, input, itemId: created.id });
    live.toolStarted.set(toolUseId, this.now().getTime());
  }

  private cwdOf(sessionId: Id): string | undefined {
    const s = this.store.getSession(sessionId);
    return s ? this.store.getWorkspace(s.workspaceId)?.path : undefined;
  }

  private settleToolCard(live: Live, toolUseId: string, content: unknown, isError: boolean): void {
    const itemId = live.tools.get(toolUseId);
    if (!itemId) return;
    live.tools.delete(toolUseId);
    const declined = live.declinedTools.delete(toolUseId);
    const detail = toolResultText(content);
    const started = live.toolStarted.get(toolUseId);
    live.toolStarted.delete(toolUseId);
    // An image file read comes back as an image block: the row shows the file (the block itself is not kept).
    const call = live.calls.get(toolUseId);
    const path = call && typeof call.input.file_path === "string" ? call.input.file_path : "";
    const images = path && hasImageBlock(content) ? [{ id: null, path }] : [];
    this.updateItem(itemId, (it) =>
      it.type === "tool"
        ? {
            ...it,
            status: declined ? "declined" : isError ? "failed" : "completed",
            ...(detail ? { detail: tail(detail) } : {}),
            ...(started ? { durationMs: this.now().getTime() - started } : {}),
            ...(images.length ? { images } : {}),
          }
        : it,
    );
  }

  /** Items appended while a turn runs belong to it (the subagent sessions' items do not). */
  protected override appendItem(sessionId: Id, body: NewItemBody, raw?: { method: string; itemId?: string; turnId?: string }): SessionItem {
    const turnId = raw?.turnId ?? (body.type === "turn" ? undefined : this.live.get(sessionId)?.turn?.id);
    return super.appendItem(sessionId, body, turnId ? { method: body.type, ...raw, turnId } : raw);
  }

  private endTurn(live: Live, state: TurnState, usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }, contextWindow?: number): void {
    const turn = live.turn;
    if (!turn) return;
    live.turn = null;
    const read = usage?.cache_read_input_tokens ?? 0;
    const input = (usage?.input_tokens ?? 0) + read + (usage?.cache_creation_input_tokens ?? 0);
    this.updateItem(turn.itemId, (it) =>
      it.type === "turn"
        ? {
            ...it,
            state,
            endedAt: this.now().toISOString(),
            ...(usage
              ? {
                  usage: {
                    input,
                    cachedInput: read,
                    output: usage.output_tokens ?? 0,
                    reasoning: 0,
                    ...(live.context ? { context: live.context } : {}),
                    ...(contextWindow ? { contextWindow } : {}),
                  },
                }
              : {}),
          }
        : it,
    );
  }

  private addDecode(turnItemId: Id, ms: number, tokens: number): void {
    this.updateItem(turnItemId, (it) => (it.type === "turn" ? { ...it, decode: { ms: (it.decode?.ms ?? 0) + Math.max(0, ms), tokens: (it.decode?.tokens ?? 0) + tokens } } : it));
  }

  /** `by`: a message sent from Studio started it, or the CLI did (a wakeup, a task notification, a queued message). */
  private turnStarted(sessionId: Id, live: Live, by: "cli" | "person" = "cli"): void {
    if (!live.turn) {
      live.notices.clear();
      const turnId = randomUUID();
      const item = this.appendItem(sessionId, { type: "turn", turnId, state: "running", startedAt: this.now().toISOString() }, { method: "turn/start", turnId });
      live.turn = { id: turnId, itemId: item.id };
      this.wakeOnTurnStart(sessionId, live, by);
    }
    live.running = true;
    this.clearIdle(live);
    this.setStatus(sessionId, waitingStatus(live));
  }

  /** canUseTool: show an approval card (for questions and plan reviews, a question) and wait for the person. */
  private askPerson(
    sessionId: Id,
    live: Live,
    toolName: string,
    toolInput: Record<string, unknown>,
    ctx: { signal: AbortSignal; toolUseID?: string; title?: string; description?: string },
  ): Promise<PermissionResult> {
    const input = toolInput;
    if (toolName === "AskUserQuestion") {
      const questions = askedQuestions(input);
      if (questions.length) return this.askQuestion(sessionId, live, { kind: "ask", input, questions }, { source: "claude-ask", questions }, ctx);
    }
    if (toolName === "ExitPlanMode") {
      // The CLI puts the plan (read from its plan file) into the input.
      return this.askQuestion(sessionId, live, { kind: "plan", input, questions: [] }, { source: "plan-review", plan: typeof input.plan === "string" ? input.plan : "" }, ctx);
    }
    const approvalId = ctx.toolUseID ?? randomUUID();
    const kind: ApprovalKind = toolName === "Bash" || toolName === "PowerShell" ? "command" : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName) ? "fileChange" : "permissions";
    const summary = String(input.command ?? input.file_path ?? input.notebook_path ?? ctx.title ?? toolName);
    const detail = ctx.description ?? (typeof input.description === "string" ? input.description : undefined);
    const item = this.appendItem(
      sessionId,
      { type: "approval", approvalId, kind, summary, ...(detail ? { detail } : {}), state: "pending" },
      { method: "canUseTool", ...(ctx.toolUseID ? { itemId: ctx.toolUseID } : {}) },
    );
    this.setStatus(sessionId, "awaiting-approval");
    return new Promise<PermissionResult>((resolve) => {
      live.approvals.set(approvalId, { itemId: item.id, input, toolUseId: ctx.toolUseID ?? null, resolve });
      ctx.signal.addEventListener("abort", () => {
        if (!live.approvals.delete(approvalId)) return;
        this.updateItem(item.id, (it) => (it.type === "approval" && it.state === "pending" ? { ...it, state: "resolved-elsewhere" } : it));
        resolve({ behavior: "deny", message: "aborted" });
        this.afterWait(sessionId, live);
      });
    });
  }

  /** A question item in place of the approval card; the canUseTool call resolves when the person answers. */
  private askQuestion(
    sessionId: Id,
    live: Live,
    pending: Omit<PendingQuestion, "itemId" | "resolve">,
    fields: { source: "claude-ask"; questions: QuestionPrompt[] } | { source: "plan-review"; plan: string },
    ctx: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult> {
    if (ctx.toolUseID) live.askedTools.add(ctx.toolUseID);
    const item = this.appendItem(sessionId, { type: "question", ...fields, state: "pending" }, { method: "canUseTool", ...(ctx.toolUseID ? { itemId: ctx.toolUseID } : {}) });
    return new Promise<PermissionResult>((resolve) => {
      live.questions.set(item.id, { ...pending, itemId: item.id, resolve });
      this.setStatus(sessionId, "awaiting-answer");
      ctx.signal.addEventListener("abort", () => {
        if (!live.questions.delete(item.id)) return;
        this.cancelQuestion(item.id);
        resolve({ behavior: "deny", message: "aborted" });
        this.afterWait(sessionId, live);
      });
    });
  }

  /**
   * An approval or a question is settled: the session waits for the next one, or goes on. Between turns (an agent in the
   * background asked, 2026-10-16) there is no turn to go on with: it is idle again, not left 等你批准 for Focus.
   */
  private afterWait(sessionId: Id, live: Live): void {
    if (live.running || live.approvals.size || live.questions.size) this.setStatus(sessionId, waitingStatus(live));
    else {
      const status = this.store.getSession(sessionId)?.status;
      if (status === "awaiting-approval" || status === "awaiting-answer") this.setStatus(sessionId, "idle");
    }
  }

  private cancelQuestion(itemId: Id): void {
    this.updateItem(itemId, (it) => (it.type === "question" && it.state === "pending" ? { ...it, state: "cancelled" } : it));
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  /** After a Host restart no Claude process is running: turns that were in flight are over. */
  private recoverAfterRestart(): void {
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "claude") continue;
      for (const item of this.store.listItems(s.id)) {
        if (item.type === "approval" && item.state === "pending") this.updateItem(item.id, (it) => (it.type === "approval" ? { ...it, state: "resolved-elsewhere" } : it));
        if (item.type === "question" && item.state === "pending") this.cancelQuestion(item.id);
        if (item.type === "agent" && item.streaming) this.updateItem(item.id, (it) => (it.type === "agent" ? { ...it, streaming: false } : it));
        if (item.type === "tool" && item.status === "running") this.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "failed" } : it));
        if (item.type === "background" && item.state === "running") this.updateItem(item.id, (it) => (it.type === "background" ? { ...it, state: "stopped" } : it));
        if (item.type === "compaction" && item.state === "running") this.updateItem(item.id, (it) => (it.type === "compaction" ? { ...it, state: "failed" } : it));
      }
      if (s.status === "running" || s.status === "awaiting-approval" || s.status === "awaiting-answer") {
        if (s.kind !== "sub") this.appendItem(s.id, { type: "notice", level: "warning", message: "Host 重启时这条会话的回复被中断了。发一条消息即可接着对话。" });
        this.setStatus(s.id, "idle");
      }
      // The CLI's own timers went with its process: Studio sends the loop's wakeup (and goes on after a limit) itself.
      if (s.wake && !s.archivedAt) {
        if (s.wake.loop) this.appendItem(s.id, { type: "notice", level: "info", message: "Host 重启后，这条会话的 loop 由 Studio 按时唤醒。" });
        this.armWake(s.id);
      }
    }
  }

  /**
   * The AMO MCP as an in-process SDK server bound to this session. Reads and writes to the session's own task are
   * allowed up front; everything else still goes through canUseTool.
   */
  private mcpOptions(sessionId: Id) {
    const tools = this.options.mcpTools?.(sessionId) ?? [];
    if (!tools.length) return {};
    const server = createSdkMcpServer({
      name: AMO_MCP_NAME,
      version: "0.5.0",
      instructions: AMO_MCP_INSTRUCTIONS,
      tools: tools.map((t) => tool(t.name, t.description, t.inputSchema, async (args) => t.run(args as Record<string, unknown>), { annotations: { readOnlyHint: t.readOnly } })),
    });
    return { mcpServers: { [AMO_MCP_NAME]: server }, allowedTools: tools.filter((t) => t.autoApprove).map((t) => `mcp__${AMO_MCP_NAME}__${t.name}`) };
  }

  /** Whether the profile is the Claude subscription (the only one the local login applies to). */
  private isSubscription(profile: ModelProfile): boolean {
    return !!profile.provider && this.options.providers[profile.provider]?.auth === "oauth";
  }

  /** Where a session started now runs: the subscription follows 设置 → 模型, every other profile Studio's own dir. */
  private newHome(profile: ModelProfile): ClaudeHome {
    return this.isSubscription(profile) && readClaudeLogin(this.store) === "local" ? { ...this.local, login: "local" } : { dir: this.options.claudeHome, login: "token" };
  }

  /** Where an existing session runs: the way it was started (its transcript is in that dir). */
  private homeOf(sessionId: Id): ClaudeHome {
    return sessionClaudeLogin(this.store, sessionId) === "local" ? { ...this.local, login: "local" } : { dir: this.options.claudeHome, login: "token" };
  }

  /** In-process SDK helpers (forkSession, getSessionMessages) read CLAUDE_CONFIG_DIR from this process. */
  private async withConfigDir<T>(home: ClaudeHome, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home.dir;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }

  private transcript(ref: string, dir: string, home: ClaudeHome) {
    return this.withConfigDir(home, () => getSessionMessages(ref, { dir }));
  }

  /** Turns transcript messages (written by a terminal) into items; returns how many were added. */
  private importTranscript(sessionId: Id, messages: Array<{ type: string; message: unknown }>): number {
    let added = 0;
    const tools = new Map<string, Id>();
    for (const m of messages) {
      const content = (m.message as { content?: unknown })?.content;
      const blocks: Array<Record<string, unknown>> = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (m.type === "user" && b.type === "text" && typeof b.text === "string" && !/^\s*(<[a-z-]+>|\[Request interrupted|\[Image: source:)/.test(b.text)) {
          this.appendItem(sessionId, { type: "user", text: b.text }, { method: "transcript" });
          added++;
        } else if (m.type === "user" && b.type === "tool_result") {
          const itemId = tools.get(String(b.tool_use_id));
          const detail = toolResultText(b.content);
          if (itemId) this.updateItem(itemId, (it) => (it.type === "tool" ? { ...it, status: b.is_error ? "failed" : "completed", ...(detail ? { detail: tail(detail) } : {}) } : it));
        } else if (m.type === "assistant" && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          this.appendItem(sessionId, { type: "agent", markdown: b.text, streaming: false }, { method: "transcript" });
          added++;
        } else if (m.type === "assistant" && b.type === "tool_use") {
          const created = this.appendItem(sessionId, { type: "tool", ...describeToolUse(String(b.name), (b.input ?? {}) as Record<string, unknown>, this.cwdOf(sessionId)), status: "completed" }, { method: "transcript", itemId: String(b.id) });
          tools.set(String(b.id), created.id);
          added++;
        }
      }
    }
    return added;
  }

  private hasTranscript(ref: string, home: ClaudeHome): boolean {
    const projects = join(home.dir, "projects");
    if (!existsSync(projects)) return false;
    return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${ref}.jsonl`)));
  }

  private scheduleIdle(sessionId: Id, live: Live): void {
    this.clearIdle(live);
    if (live.background.size || live.approvals.size || live.questions.size) return;
    live.idleTimer = setTimeout(() => {
      if (live.running || live.background.size) return;
      // The agent's loop wakeup or the CLI's wait at a usage limit lives in this process, and so do its agents (one
      // resumed with SendMessage may run without a task of its own): kept, looked at again later.
      const agentRunning = [...live.subs.values()].some((id) => this.store.getSession(id)?.status === "running");
      if (agentRunning || keepsProcess(this.store.getSession(sessionId)?.wake, this.now())) return this.scheduleIdle(sessionId, live);
      void this.close(sessionId);
    }, this.options.idleCloseMs ?? 10 * 60_000);
    live.idleTimer.unref?.();
  }

  private clearIdle(live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }

  private profile(id: Id): ModelProfile {
    const p = this.options.profiles.find((x) => x.id === id);
    if (!p || p.runtime !== "claude") throw new Error(`unknown Claude profile ${id}`);
    return p;
  }

  private writable(id: Id): Session {
    const s = this.requireSession(id);
    if (s.kind === "sub") throw Object.assign(new Error("Claude 的子 agent 不能单独接收消息，请在父会话里继续"), { code: "read_only" });
    if (s.writer === "archived" || s.writer === "terminal-handoff") throw Object.assign(new Error(`session ${id} is read-only (${s.writer})`), { code: "read_only" });
    if (!s.runtimeRef) throw new Error(`session ${id} has no Claude session id`);
    return s;
  }
}

const handoffKey = (sessionId: Id) => `claude-handoff-seen:${sessionId}`;

/** What a running session waits for: an answer, an approval, or nothing. */
function waitingStatus(live: Live): SessionStatus {
  return live.questions.size ? "awaiting-answer" : live.approvals.size ? "awaiting-approval" : "running";
}

/** AskUserQuestion's questions (keyed by their text, as Claude keys the answers); malformed entries are left out. */
export function askedQuestions(input: Record<string, unknown>): QuestionPrompt[] {
  const list = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return list
    .filter((q) => q && typeof q === "object" && str(q.question))
    .map((q) => ({
      id: str(q.question),
      question: str(q.question),
      ...(str(q.header) ? { header: str(q.header) } : {}),
      options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [])
        .filter((o) => o && typeof o === "object" && str(o.label))
        .map((o) => ({ label: str(o.label), ...(str(o.description) ? { description: str(o.description) } : {}), ...(str(o.preview) ? { preview: str(o.preview) } : {}) })),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      // Claude Code's own dialog always offers "Other" (free text).
      other: true,
    }));
}

/** The Claude Code executable that ships with the SDK (same version as the SDK's own processes). */
function bundledClaudeExe(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/package.json")), "claude.exe");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref?.())]);
}

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split(/\r?\n/)[0]!.slice(0, 300);

function withoutKey(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = o;
  return rest;
}

/** Whether a tool result carries an image block (Read of an image file). */
function hasImageBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "image");
}

/** A local command's output without the CLI's stdout/stderr tags. */
export function localCommandText(text: string): string {
  return text.replace(/<\/?local-command-(?:stdout|stderr)>/g, "").trim();
}

const RETRY_REASONS: Record<string, string> = {
  rate_limit: "触发限流",
  overloaded: "服务繁忙",
  server_error: "服务出错",
  authentication_failed: "认证失败",
  billing_error: "账户额度不足",
  invalid_request: "请求无效",
  model_not_found: "找不到模型",
  max_output_tokens: "输出超长",
  unknown: "请求失败",
};

/** Why Claude Code retries a model request, as the running status line says it ("服务繁忙（529）"). */
export function retryReason(error: string, status: number | null): string {
  const what = RETRY_REASONS[error] ?? (error || "请求失败");
  return status ? `${what}（${status}）` : what;
}

/**
 * The runtime's rows of the `/` menu from Claude Code's command list: commands that would undo what Studio keeps for
 * the session are left out (HIDDEN_COMMANDS), removed and internal ones too; skills are told apart by name.
 */
export function claudeCommands(list: readonly SdkSlashCommand[], skills: ReadonlySet<string> = new Set()): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const c of list) {
    const name = c.name.trim();
    if (!name || name.startsWith("_") || HIDDEN_COMMANDS.has(name) || /^\(removed\)/.test(c.description ?? "")) continue;
    // Rows can share a name: Claude Code's own wins (it is the one /name runs).
    if (seen.has(name) && !c.builtin) continue;
    const description = (c.description ?? "").replace(/\s+/g, " ").trim();
    seen.set(name, {
      name,
      description,
      ...(c.argumentHint?.trim() ? { argumentHint: c.argumentHint.trim() } : {}),
      group: skills.has(name) ? "skill" : c.builtin ? "runtime" : "custom",
      ...(c.aliases?.length ? { aliases: c.aliases.filter((a) => !HIDDEN_COMMANDS.has(a)) } : {}),
    });
  }
  return [...seen.values()];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
}

/** Row fields for a Claude tool call (everything but its status and result). */
export function describeToolUse(name: string, input: Record<string, unknown>, cwd?: string): Omit<ToolFields, "status"> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const path = shortPath(str(input.file_path ?? input.notebook_path ?? input.path), cwd);
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const command = str(input.command);
      const guess = classifyCommand(command);
      const summary = guess ? (guess.kind === "search" ? guess.target : shortPath(guess.target, cwd)) : command;
      return { name: "shell", kind: guess?.kind ?? "command", summary, input: command, ...(cwd ? { cwd } : {}) };
    }
    case "Edit": {
      const diff = textDiff(str(input.old_string), str(input.new_string));
      return { name: "edit", kind: "edit", summary: path, files: [fileDiff(path, "update", diff)] };
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
      const diff = edits.map((e) => textDiff(str(e.old_string), str(e.new_string))).join("\n");
      return { name: "edit", kind: "edit", summary: path, files: [fileDiff(path, "update", diff)] };
    }
    case "Write":
      return { name: "write", kind: "edit", summary: path, files: [fileDiff(path, "add", textDiff("", str(input.content)))] };
    case "NotebookEdit":
      return { name: "edit", kind: "edit", summary: path, files: [fileDiff(path, "update", textDiff("", str(input.new_source)))] };
    case "Read":
      return { name: "read", kind: "read", summary: path };
    case "LS":
      return { name: "ls", kind: "list", summary: path || "." };
    case "Grep":
    case "Glob":
      return { name: name.toLowerCase(), kind: "search", summary: [str(input.pattern), path].filter(Boolean).join(" · "), ...(formatInput(input) ? { input: formatInput(input)! } : {}) };
    case "WebSearch":
      return { name: "web_search", kind: "web", summary: str(input.query) };
    case "WebFetch":
      return { name: "web_fetch", kind: "web", summary: str(input.url) };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
      const done = todos.filter((t) => t.status === "completed").length;
      const mark = (st: unknown) => (st === "completed" ? "✓" : st === "in_progress" ? "→" : "○");
      return { name: "update_plan", kind: "plan", summary: `${done}/${todos.length} 已完成`, input: todos.map((t) => `${mark(t.status)} ${str(t.content)}`).join("\n") };
    }
    case "Agent":
    case "Task":
      return { name: "agent", kind: "subagent", summary: str(input.description) };
    default: {
      const args = formatInput(input);
      return { name, kind: name.startsWith("mcp__") ? "mcp" : "other", summary: str(input.description), ...(args ? { input: args } : {}) };
    }
  }
}
