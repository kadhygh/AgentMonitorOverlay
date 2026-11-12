import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createSdkMcpServer, forkSession, getSessionInfo, getSessionMessages, query, renameSession, tool, type HookCallbackMatcher, type HookEvent, type SDKMessage, type SDKUserMessage, type SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { inTurn, parseSlashCommand, type ApprovalDecision, type Attachment, type ChatSettings, type Id, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionReply, type Session, type SessionItem, type SessionOptions, type UserDelivery, type SlashCommandList, type SlashCommandResult, type Workspace, type AccountUsage, type McpApply, type OutsideSessionList, type OutsideSessionPreview } from "@amo-studio/protocol";
import { readChatSettings } from "../chat-settings.js";
import { CLAUDE_BUILTIN_MODELS, CLAUDE_DEFAULT_PERMISSION, CLAUDE_PERMISSIONS, claudePermissionMode } from "../choices.js";
import type { Store } from "../../store/store.js";
import type { CredentialReader } from "../credentials.js";
import { RuntimeBase, STOP_GRACE_MS, type ForkSpec, type NewItemBody, type SendMode, type SendOptions, type SessionRuntimeApi } from "../runtime.js";
import { withDelivery } from "../items.js";
import { claudeEnv, type ClaudeHome, type ClaudeProviderDef } from "./claude-env.js";
import { claudeAutoCompactEnv } from "../compact.js";
import { spawnClaudeProcess } from "../priority.js";
import { localClaudeHome, readClaudeLogin, rememberSessionLogin, sessionClaudeLogin } from "./claude-login.js";
import { keepsProcess } from "./wake.js";
import { shellHelpEnv } from "../agent-env.js";
import { agentsMdInstructions } from "./project-instructions.js";
import { AMO_MCP_INSTRUCTIONS, AMO_MCP_NAME, type AmoTool } from "../../mcp/tools.js";
import { sameProcessPart, sdkServer, type McpLaunch, type McpSource } from "../mcp-launch.js";
import { ClaudeAsks } from "./asks.js";
import { BLOCKED_COMMANDS, claudeCommands } from "./commands.js";
import type { ClaudeCore } from "./core.js";
import { newLive, type Live, type LiveInput } from "./live.js";
import { ClaudeMessages } from "./messages.js";
import { askCommands, askModels, CLI_SETTING_SOURCES, withTimeout } from "./probe.js";
import { ClaudeSubagents } from "./subagents.js";
import { firstLine } from "./tool-use.js";
import { requireClaudeCode } from "./executable.js";
import { handoffKey, hasTranscript, importTranscript, readTranscript, withConfigDir } from "./transcripts.js";
import { ClaudeTurns } from "./turns.js";
import { ClaudeUsageTracker } from "./usage-tracker.js";
import { ClaudeAccounts } from "./accounts.js";
import { authEnvSummary, dirAccountSummary, settingsAuthSummary, windowsSummary } from "./account-log.js";
import { ClaudeWake } from "./wake-control.js";
import { adoptedKey, isCompactSummary, listOutsideSessions, previewOutsideSession, sameFolder } from "./outside.js";

export { claudeCommands, localCommandText } from "./commands.js";
export { askedQuestions, describeToolUse, retryReason } from "./tool-use.js";

// Drives Claude sessions through the Claude Agent SDK. Behaviour follows spikes/RESULTS.md section h:
// - permissionMode is passed as "default" (the CLI otherwise picks "auto", where a classifier approves instead of a
//   person) and switched to the session's mode once running; "auto" only when the person picks 帮我审批 (10-19);
//   canUseTool waits for the person and becomes an approval card (asks.ts);
// - a message sent while a turn runs waits at the CLI: it is folded into the turn after its next tool call, or runs as
//   the next turn (CLI 2.1.304; checked 2026-11-02 against the mock). command_lifecycle says when the model got it
//   (`delivery` on the user item); 立即发送 makes the turn give way to it (sendNow; not `priority: "now"`, see deliver);
// - interrupt() ends the turn with error_during_execution, treated as "interrupted"; the query goes on, and messages
//   still waiting run right after (as the CLI's "esc to interrupt and send");
// - one query can produce several results (a background subagent's notification starts another turn);
// - a subagent has no session of its own in Claude: its messages carry parent_tool_use_id (subagents.ts);
// - forks copy the transcript with forkSession() (no model call).
// - "在终端打开" hands the session to `claude --resume` in a terminal: Studio closes its own process first (one
//   process per session id), stays read-only meanwhile, and on reclaim imports what the terminal added.
// Stage 16 split the runtime: this file keeps the operations and each process's life; the messages (messages.ts),
// the turn's rows (turns.ts), loops and usage limits (wake-control.ts) and the quota (usage-tracker.ts) are parts.

export interface ClaudeRuntimeOptions {
  store: Store;
  profiles: readonly ModelProfile[];
  providers: Record<string, ClaudeProviderDef>;
  credentials: CredentialReader;
  /** Studio's own CLAUDE_CONFIG_DIR; transcripts live under <claudeHome>/projects. */
  claudeHome: string;
  /** The person's Claude Code config dir, used by sessions started with the local login (default: theirs, ~/.claude). */
  localClaudeHome?: string;
  /** Claude 多账号 (2026-11-03): the subscription's accounts; default: the person's own dir only. */
  accounts?: ClaudeAccounts;
  now?: () => Date;
  /** An idle query (no turn, no background task) is closed after this long; the next message resumes it. */
  idleCloseMs?: number;
  /** 停止 not answered by the CLI this long: Studio closes its process (and, as long again later, gives up on it). */
  stopGraceMs?: number;
  /** Variables the child environment starts from (default: process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** The AMO MCP tools, given to every Claude session in-process (no token reaches the CLI). */
  mcpTools?: (sessionId: Id) => AmoTool[];
  /** The MCP server's instructions for this session (its role card after the general ones); the general ones when absent. */
  mcpInstructions?: (sessionId: Id) => string;
  /** MCP 设置 (2026-11-04): the session's other MCP servers. Without it, only amo (strict with the local login, as before). */
  mcp?: McpSource;
}

/** How long after a process is up its MCP servers' statuses are read (they connect in the background). */
const MCP_STATUS_DELAY_MS = 8_000;
/** Claude 多账号的排查 (2026-11-12): how often host.log gets the processes and quotas while there are several accounts. */
const ACCOUNT_TICK_MS = 5 * 60_000;

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
          const { mode: _dropped, ...rest } = toolInput;
          return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: rest } };
        },
      ],
    },
  ],
};

export class ClaudeRuntime extends RuntimeBase implements SessionRuntimeApi {
  private readonly live = new Map<Id, Live>();
  private readonly modelCache = new Map<string, { at: number; models: ModelOption[] }>();
  private readonly askingModels = new Map<string, Promise<ModelOption[]>>();
  /** Queries being closed: a new one for the same session must wait, or the CLI says the session id is in use. */
  private readonly closing = new Map<Id, Promise<void>>();
  /** Skill names per profile, from the CLI's init message (its command list does not tell skills apart). */
  private readonly skillNames = new Map<Id, Set<string>>();
  /** Command lists asked without a session (profile and folder -> list). */
  private readonly commandCache = new Map<string, { at: number; list: SdkSlashCommand[] }>();
  /** The `/` command a session was last sent, to name the output of a command that runs without the model. */
  private readonly lastCommand = new Map<Id, string>();
  /** Claude 多账号的排查 (2026-11-12): the last rate-limit line logged per session, each account's last quota logged. */
  private readonly lastRateLog = new Map<Id, string>();
  private readonly lastUsageLog = new Map<string, string>();
  private accountTick: ReturnType<typeof setInterval> | null = null;

  /** The person's own config dir; `explicit` when they set CLAUDE_CONFIG_DIR (read once: helpers set it for a while). */
  private readonly local: { dir: string; explicit: boolean };
  /** Claude 多账号: the subscription runs on the current one (its dir shares the default dir's records). */
  readonly accounts: ClaudeAccounts;

  private readonly core: ClaudeCore;
  private readonly usageTracker: ClaudeUsageTracker;
  private readonly wake: ClaudeWake;
  private readonly turns: ClaudeTurns;
  private readonly asks: ClaudeAsks;
  private readonly subagents: ClaudeSubagents;
  private readonly messages: ClaudeMessages;

  constructor(private readonly options: ClaudeRuntimeOptions) {
    super(options.store, "claude", options.now, options.profiles);
    const env = options.baseEnv ?? process.env;
    this.local = { dir: options.localClaudeHome ?? localClaudeHome(env), explicit: !!options.localClaudeHome || !!env.CLAUDE_CONFIG_DIR?.trim() };
    this.core = {
      ...this.makeCore(),
      live: this.live,
      closing: this.closing,
      homeOf: (id) => this.homeOf(id),
      cwdOf: (id) => this.cwdOf(id),
      ensureLive: (s) => this.ensureLive(s),
      sendMessage: (id, text) => this.sendMessage(id, text),
      close: (id) => this.close(id),
      clearIdle: (live) => this.clearIdle(live),
    };
    this.accounts = options.accounts ?? new ClaudeAccounts(this.store, { defaultDir: this.local.dir, defaultExplicit: this.local.explicit, ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}) });
    this.accounts.setGuard({ blocked: () => this.switchBlocked(), beforeSwitch: (from, to) => this.beforeAccountSwitch(from, to) });
    this.usageTracker = new ClaudeUsageTracker(this.store, { accounts: this.accounts, baseUrl: (p) => (p.provider ? this.options.providers[p.provider]?.baseUrl : undefined), log: (line) => this.emit("log", line) });
    this.wake = new ClaudeWake(this.core, (sessionId) => {
      const profileId = this.store.getSession(sessionId)?.profileId;
      return profileId ? this.usageTracker.usedUpUntil(this.limitKey(profileId), this.now().getTime()) : null;
    });
    this.turns = new ClaudeTurns(this.core, (sessionId, live, by) => {
      this.wake.onTurnStart(sessionId, live, by);
      this.traceTurnStart(sessionId, live, by);
    });
    this.asks = new ClaudeAsks(this.core);
    this.subagents = new ClaudeSubagents(this.core, this.turns);
    this.messages = new ClaudeMessages(this.core, {
      turns: this.turns,
      subagents: this.subagents,
      wake: this.wake,
      recordRateLimit: (sessionId, info) => {
        const profileId = this.store.getSession(sessionId)?.profileId;
        if (!profileId) return;
        // Claude 多账号的排查 (2026-11-12): Anthropic's answer for the account this process bills, with the account
        // Studio started it on — the two must be the same.
        const live = this.live.get(sessionId);
        const line = `${info.rateLimitType ?? "?"} ${typeof info.utilization === "number" ? info.utilization : "?"}${info.resetsAt ? ` resets ${new Date(info.resetsAt * 1000).toISOString()}` : ""}`;
        if (this.lastRateLog.get(sessionId) !== line) {
          this.lastRateLog.set(sessionId, line);
          this.emit("log", `claude account: rate limit event in ${sessionId} (process on ${live?.account ?? "-"}, current ${this.accounts.currentId()}): ${line}`);
        }
        this.usageTracker.record(this.limitKey(profileId), info);
      },
      noteSkills: (sessionId, skills) => {
        const profileId = this.store.getSession(sessionId)?.profileId;
        if (profileId) this.skillNames.set(profileId, new Set(skills));
      },
      lastCommand: (sessionId) => this.lastCommand.get(sessionId),
      scheduleIdle: (sessionId, live) => this.scheduleIdle(sessionId, live),
      noteMcp: (sessionId, live) => {
        if (!this.options.mcp?.noteStatus) return;
        setTimeout(() => {
          if (this.live.get(sessionId) !== live) return;
          void this.mcpStatus(sessionId)
            .then((list) => list && this.options.mcp?.noteStatus?.(sessionId, list))
            .catch(() => undefined);
        }, MCP_STATUS_DELAY_MS).unref?.();
      },
    });
    this.recoverAfterRestart();
    this.startAccountTick();
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions; resumeFrom?: string }): Promise<Session> {
    const profile = this.profile(input.profileId);
    if (input.resumeFrom) return this.resumeOutside(input, profile, input.resumeFrom);
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

  /**
   * 接续已有会话 (2026-11-05, plans/done/resume-cli-sessions.md): Claude sessions started outside Studio (a terminal, the
   * Claude desktop app), read where the local login's sessions are. Only the subscription on the local login sees them.
   */
  async outsideSessions(): Promise<OutsideSessionList> {
    const home = this.outsideHome();
    if (!home) return { sessions: [], unavailable: "Claude 订阅没有用本机 Claude Code 的登录，看不到终端和 Claude desktop app 里的会话" };
    return { sessions: await listOutsideSessions(home, this.store, this.store.listWorkspaces()) };
  }

  async outsidePreview(ref: string): Promise<OutsideSessionPreview | null> {
    const home = this.outsideHome();
    return home ? previewOutsideSession(home, ref) : null;
  }

  /** The config dir outside sessions are in: the current account's (every account links the default dir's `projects`). */
  private outsideHome(): ClaudeHome | null {
    const profile = this.options.profiles.find((p) => p.runtime === "claude" && this.isSubscription(p));
    return profile && this.newHome(profile).login === "local" ? this.accountHome() : null;
  }

  /** Whether a new session of this profile can go on from that outside session; throws why not (before a task is made). */
  async checkResume(profileId: Id, ref: string): Promise<void> {
    await this.outsideSource(profileId, ref);
  }

  private async outsideSource(profileId: Id, ref: string) {
    const home = this.isSubscription(this.profile(profileId)) ? this.outsideHome() : null;
    if (!home) throw Object.assign(new Error("接续已有会话只能用 Claude 订阅（本机 Claude Code 的登录）"), { code: "bad_request" });
    if (this.store.getKv(adoptedKey(ref)) || this.store.findSessionByRuntimeRef("claude", ref)) throw Object.assign(new Error("这个会话已经在 Studio 里了"), { code: "conflict" });
    const info = await withConfigDir(home, () => getSessionInfo(ref));
    if (!info) throw Object.assign(new Error("找不到这个会话的对话记录（可能已被删除）"), { code: "not_found" });
    return { home, info };
  }

  /**
   * A new session that goes on from an outside one: always from a copy (forkSession, no model call), so the original is
   * left as it is — it may still be open in the desktop app, and two writers on one transcript would break it. The copy
   * sits beside the original (its folder is the original's); the CLI finds it by id from the project folder Studio runs
   * it in (checked 2026-11-05). The conversation since its last compaction is imported, as the model will see it.
   */
  private async resumeOutside(input: { taskId: Id | null; topicId: Id | null; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }, profile: ModelProfile, ref: string): Promise<Session> {
    const { home, info } = await this.outsideSource(profile.id, ref);
    const original = (info.customTitle || info.summary || info.firstPrompt || "").trim().slice(0, 100);
    const title = (input.title?.trim() || original || "接续的会话").slice(0, 100);
    const forked = await withConfigDir(home, () => forkSession(ref, { title }));
    const session = this.createSession({
      taskId: input.taskId,
      topicId: input.topicId,
      parentId: null,
      kind: "main",
      profileId: profile.id,
      workspaceId: input.workspace.id,
      title,
      runtimeRef: forked.sessionId,
      options: input.options ?? {},
    });
    rememberSessionLogin(this.store, session.id, home.login);
    this.store.setKv(adoptedKey(ref), session.id);
    const messages = await withConfigDir(home, () => getSessionMessages(forked.sessionId));
    const compacted = messages.some(isCompactSummary);
    const where = info.cwd && !sameFolder(info.cwd, input.workspace.path) ? `原来在 ${info.cwd} 里工作，接过来后在项目目录 ${input.workspace.path} 里继续。` : "";
    const parts = [
      `接续自 Studio 之外的会话「${original || ref}」（${ref.slice(0, 8)}）。原会话没有改动，这里是它的一份副本。`,
      where,
      compacted ? "原会话压缩过上下文：下面只有最后一次压缩之后的对话，模型那边也只记得压缩摘要和之后的内容。" : "",
    ];
    this.appendItem(session.id, { type: "notice", level: "info", message: parts.filter(Boolean).join("") });
    importTranscript(this.core, session.id, input.workspace.path, messages.filter((m) => !isCompactSummary(m)));
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  /** Images go as base64 image blocks before the text (the CLI keeps them in the transcript). */
  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    const slash = parseSlashCommand(text);
    const blocked = slash ? BLOCKED_COMMANDS[slash.name.toLowerCase()] : undefined;
    if (blocked) throw Object.assign(new Error(blocked), { code: "bad_request" });
    if (slash) this.lastCommand.set(sessionId, slash.name);
    // Read the images first: a missing file fails the send before anything is shown or queued.
    const content = messageContent(text, images);
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    return this.deliver(session, content, options, (mode, delivery) => {
      const shown = images.map((a) => ({ id: a.id, path: a.path }));
      return this.appendItem(sessionId, { type: "user", text, ...(shown.length ? { images: shown } : {}), ...(delivery ? { delivery } : {}) }, { method: mode === "queue" ? "user/queued" : "user" }).id;
    });
  }

  /**
   * One message into the session's process: a turn starts, or it waits at the CLI while one runs (its item `waiting`
   * until command_lifecycle says the model got it — only when the CLI reports msg_lifecycle_v1, else it would never
   * clear). `item` makes the message's row (or brings one back, for 重新发送) and returns its id.
   */
  private async deliver(session: Session, content: SDKUserMessage["message"]["content"], options: SendOptions, item: (mode: SendMode, delivery: UserDelivery | undefined) => Id): Promise<{ mode: SendMode }> {
    const sessionId = session.id;
    await this.closing.get(sessionId);
    const live = this.ensureLive(session);
    const mode: SendMode = live.running ? "queue" : "start";
    if (!live.running) this.turns.started(sessionId, live, "person");
    const itemId = item(mode, mode === "queue" && live.capabilities.has("msg_lifecycle_v1") ? "waiting" : undefined);
    const uuid = randomUUID();
    live.undelivered.set(uuid, itemId);
    this.clearIdle(live);
    // Goes in once the permission mode is in force, without waiting for it here: a new session's process takes a few
    // seconds to come up, and the caller (开始, 新会话) is not held for it (2026-10-23). Sends queue up in order on it.
    void live.ready.then(() => live.push({ content, uuid }));
    // 立即发送 from the composer (Ctrl+Enter, 2026-11-02): the running turn gives way to it, as the button under a
    // waiting message does. 2026-11-03 (问题 #16, "it seems to hang a long time"): it went as a `priority: "now"` message,
    // which CLI 2.1.304 only lets through at once while a shell command is in its first second or two — after that the
    // turn waited for the command to finish (33–40 s for a 41 s sleep against the mock; the Send now request and 停止
    // took 0.03–0.1 s at any point, the command ended). So the message goes as any other and is sent now once at the CLI.
    if (options.now === true && mode === "queue") {
      void this.sendNow(sessionId, itemId).catch((err: unknown) => this.emit("log", `send now after Ctrl+Enter failed for ${sessionId}: ${String(err)}`));
    }
    return { mode };
  }

  /**
   * 立即发送 on a waiting message (2026-11-02): the CLI's own Send now (the interrupt request with `send_now`, internal
   * to the SDK; CLI 2.1.304 advertises interrupt_send_now_v1) — the turn gives way and the message runs at once, nothing
   * queued is cancelled. A CLI without it (or an SDK without `request`) gets a plain interrupt, which does the same here:
   * the waiting messages run right after. Not 停止: approvals are left to the turn's end, and there is no 15 s close.
   */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    this.writable(sessionId);
    const live = this.live.get(sessionId);
    const uuid = live ? [...live.undelivered].find(([, id]) => id === itemId)?.[0] : undefined;
    if (!live || !uuid || !live.running) return;
    // Pressed right after sending: the CLI may still be taking the message in (it would find nothing waiting).
    if (!live.atCli.has(uuid)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        live.onAtCli.set(uuid, () => (clearTimeout(timer), resolve()));
      });
      live.onAtCli.delete(uuid);
      if (!live.undelivered.has(uuid) || !live.running || live.finished) return;
    }
    live.givingWay = true;
    const request = (live.q as unknown as { request?: (r: Record<string, unknown>) => Promise<{ response?: { send_now?: unknown } } | undefined> }).request;
    try {
      if (live.capabilities.has("interrupt_send_now_v1") && typeof request === "function") {
        const answer = await request.call(live.q, { subtype: "interrupt", send_now: true, message_uuid: uuid });
        // "stopped": the turn ends (its result comes after this answer). Anything else (nothing waiting, or the CLI
        // moved what the turn waited on to the background and the turn takes the message in) ends no turn.
        if (answer?.response?.send_now !== "stopped") live.givingWay = false;
        this.emit("log", `${sessionId}: send now -> ${String(answer?.response?.send_now)}`);
      } else {
        await live.q.interrupt();
      }
    } catch (err) {
      live.givingWay = false;
      this.emit("log", `send now failed for ${sessionId}: ${String(err)}`);
      throw Object.assign(new Error(`没能立即发送：${firstLine(err)}`), { code: "conflict" });
    }
  }

  /**
   * 重新发送 (2026-11-02): a message its process never read goes again, as the same row (no second copy of it). Also
   * how Studio's inbox sends a held one (2026-11-04).
   */
  async resend(sessionId: Id, itemId: Id, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId) throw Object.assign(new Error(`message ${itemId} not found`), { code: "not_found" });
    if (item.delivery !== "unsent" && item.delivery !== "held") return { mode: this.live.get(sessionId)?.running ? "queue" : "start" };
    const content = messageContent(item.text, images);
    return this.deliver(session, content, options, (_mode, delivery) => {
      this.updateItem(itemId, (it) => (it.type === "user" ? withDelivery(it, delivery) : it));
      return itemId;
    });
  }

  /**
   * 停止. 2026-11-01 (the user: a session hung after moving its project's Claude memory folder; 停止 left it 正在工作
   * until the computer was restarted): the CLI is asked to stop, and Studio does not wait on it for long — a process
   * that has not ended the turn after stopGraceMs is closed, and one that does not even go then is let go.
   */
  async interrupt(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.running) return;
    live.interrupted = true;
    this.asks.declineAll(live);
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    // The turn that was stopped, not just one (2026-11-09, the user: s-35db5a8c, 停止 then a fuller message sent a few
    // seconds later — the stopped turn had ended at once, and 15 s after 停止 Studio closed the process in the middle of
    // the new one). The process lives on between turns, so `running` alone is any turn's.
    const turn = live.turn;
    const stillRunning = () => this.live.get(sessionId) === live && live.running && !live.finished && live.turn === turn;
    this.armStopGrace(sessionId, grace, stillRunning, () => {
      this.appendItem(sessionId, { type: "notice", level: "warning", message: `点了停止 ${Math.round(grace / 1000)} 秒后 Claude 还没停下（它可能卡在某个命令或文件操作上），Studio 关掉了它的进程。发一条消息即可接着对话。` });
      void this.close(sessionId);
      // The process did not go either: its end is handled here, so the session is not left 正在工作.
      this.armStopGrace(sessionId, grace, () => !live.finished, () => {
        this.finish(sessionId, live, null);
        // The next message starts a new process rather than waiting on this one (nor does the Host's shutdown).
        this.closing.delete(sessionId);
      }, "the CLI process did not exit after close; leaving it");
    }, "closing its process");
    await Promise.race([live.q.interrupt().catch((err: unknown) => this.emit("log", `interrupt failed for ${sessionId}: ${String(err)}`)), new Promise((r) => setTimeout(r, grace).unref?.())]);
  }

  /**
   * Copies the transcript into a new Claude session (no model call); the branch continues from there. `through.forkPoint`:
   * only up to that message (the end of a turn, 2026-11-10).
   */
  async fork(sessionId: Id, spec: ForkSpec = {}): Promise<Session> {
    const parent = this.requireSession(sessionId);
    if (parent.kind === "sub") throw Object.assign(new Error("Claude 的子 agent 没有独立的对话，不能分支"), { code: "read_only" });
    const profile = this.profile(spec.profileId ?? parent.profileId);
    const workspace = this.store.getWorkspace(parent.workspaceId);
    if (!workspace || !parent.runtimeRef) throw new Error(`session ${sessionId} cannot be forked`);
    const home = this.homeOf(parent.id);
    if (!hasTranscript(parent.runtimeRef, home)) throw Object.assign(new Error("这个会话还没有对话内容，不能分支"), { code: "conflict" });
    // The copy stays in the parent's config dir, so the branch runs the way the parent did.
    if (home.login === "local" && !this.isSubscription(profile)) throw Object.assign(new Error("这个会话用本机 Claude Code 的登录，分支只能继续用 Claude 订阅"), { code: "bad_request" });
    const title = spec.title || `${parent.title || "会话"} · 分支`;
    const upTo = spec.through?.forkPoint;
    const forked = await withConfigDir(home, () => forkSession(parent.runtimeRef!, { dir: workspace.path, title, ...(upTo ? { upToMessageId: upTo } : {}) }));
    const child = this.createSession({
      taskId: parent.taskId,
      topicId: parent.topicId,
      parentId: spec.peer ? null : parent.id,
      kind: spec.peer ? "main" : "fork",
      profileId: profile.id,
      workspaceId: parent.workspaceId,
      title,
      runtimeRef: forked.sessionId,
      options: spec.options ?? parent.options,
    });
    rememberSessionLogin(this.store, child.id, home.login);
    return child;
  }

  /** The Claude subscription's quota (see ClaudeUsageTracker); none for other profiles. */
  /**
   * Finished subagents whose usage turn has no speed (before 2026-10-27 none had, and their output was counted far too
   * low): their tokens and speed from Claude Code's transcripts, one session at a time, `gapMs` apart. No model is called.
   */
  async backfillSubagentStats(gapMs = 100): Promise<number> {
    let filled = 0;
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "claude" || s.kind !== "sub" || s.status === "running") continue;
      const turn = this.store.findItems(s.id, "turn", {}, { newest: true, limit: 1 })[0];
      if (turn?.type !== "turn" || turn.decode) continue;
      await new Promise((r) => setTimeout(r, gapMs));
      try {
        if (this.subagents.fillFromLog(s)) filled++;
      } catch (err) {
        this.emit("log", `claude subagent stats backfill failed for ${s.id}: ${String(err)}`);
      }
    }
    return filled;
  }

  /** One entry per account (current first) once there are several (Claude 多账号, 2026-11-03). */
  async usage(profileId: Id, refresh = false): Promise<AccountUsage | AccountUsage[] | null> {
    const profile = this.profile(profileId);
    if (!this.isSubscription(profile)) return null;
    const answer = await this.usageTracker.usage(profile, refresh);
    this.logUsage(answer);
    return answer;
  }

  /** Claude 多账号的排查 (2026-11-12): each account's quota into host.log whenever it changed (only with several accounts). */
  private logUsage(answer: AccountUsage | AccountUsage[]): void {
    if (!Array.isArray(answer)) return;
    for (const u of answer) {
      if (!u.account) continue;
      const line = `${windowsSummary(u.windows)}${u.note ? ` (${u.note})` : ""}`;
      const key = `${u.profileId}|${u.account.id}`;
      if (this.lastUsageLog.get(key) === line) continue;
      this.lastUsageLog.set(key, line);
      this.emit("log", `claude account: quota of ${u.account.id} (${u.account.label}${u.account.current ? ", in use" : ", not in use"}): ${line}`);
    }
  }

  private accountLabel(id: Id): string {
    const a = this.accounts.describe(id);
    return a ? `${a.label}${a.email && a.email !== a.label ? ` <${a.email}>` : ""}` : "?";
  }

  /**
   * Claude 多账号的排查 (2026-11-12): what the process itself says it is signed in as (accountInfo answers from its own
   * login, no model call), against the account Studio started it on.
   */
  private checkProcessAccount(sessionId: Id, live: Live): void {
    const expected = live.account!;
    withTimeout(live.q.accountInfo(), 60_000)
      .then((info) => {
        const want = this.accounts.describe(expected)?.email ?? null;
        const mismatch = !!want && !!info.email && want.toLowerCase() !== info.email.toLowerCase();
        this.emit(
          "log",
          `claude account: ${sessionId} process says ${info.email ?? "(no email)"} org=${info.organization ?? "-"} plan=${info.subscriptionType ?? "-"} tokenSource=${info.tokenSource ?? "-"} apiKeySource=${info.apiKeySource ?? "-"} provider=${info.apiProvider ?? "-"}${mismatch ? ` · WARNING: started on ${expected} (${want}), but signed in as someone else` : ""}`,
        );
      })
      .catch((err: unknown) => {
        if (this.live.get(sessionId) === live) this.emit("log", `claude account: ${sessionId} could not ask its process for the account: ${firstLine(err)}`);
      });
  }

  /**
   * Every turn start, for the account log (2026-11-12): a turn in a process of an account no longer current, and — the
   * other side's lead: 归档时取消了「恢复后自动继续」，归档后它还在跑？ — a turn in an archived session. Studio never starts
   * one there (archive closes the process, its wake timer skips archived sessions), so it can only be the CLI going on
   * by itself in a process that did not go away: said so, and that process is closed.
   */
  private traceTurnStart(sessionId: Id, live: Live, by: "cli" | "person"): void {
    const session = this.store.getSession(sessionId);
    const current = this.accounts.currentId();
    if (session?.archivedAt) {
      this.emit("log", `claude account: WARNING turn started (by ${by}) in archived session ${sessionId} (process on ${live.account ?? "-"}, current ${current}): closing its process`);
      setTimeout(() => {
        if (this.live.get(sessionId) === live) void this.close(sessionId);
      }, 0).unref?.();
      return;
    }
    if (!live.account) return;
    if (live.account !== current) this.emit("log", `claude account: WARNING turn started (by ${by}) in ${sessionId} in a process on ${live.account}, but the current account is ${current}`);
    else this.emit("log", `claude account: turn starts in ${sessionId} (by ${by}) on ${live.account}`);
  }

  /**
   * With several accounts: every 5 minutes, the Claude processes alive and the account each runs on, and each
   * account's quota (logged when it changed) — so a quota that moves while nothing of Studio runs on that account
   * shows up as such.
   */
  private startAccountTick(): void {
    const tick = () => {
      try {
        if (this.accounts.count() < 2 || readClaudeLogin(this.store) !== "local") return;
        const procs = [...this.live.entries()].map(([id, l]) => {
          const s = this.store.getSession(id);
          return `${id} on ${l.account ?? "-"} (${l.running ? "running" : "idle"}${s?.archivedAt ? ", ARCHIVED" : ""}${s?.wake ? `, wake ${s.wake.limit ? `limit autoContinue=${s.wake.limit.autoContinue}` : ""}${s.wake.loop ? " loop" : ""}` : ""})`;
        });
        const waking = this.store.listSessions().filter((s) => s.runtime === "claude" && s.wake && !this.live.has(s.id)).map((s) => `${s.id}${s.archivedAt ? " (archived)" : ""}`);
        this.emit("log", `claude account: tick · current ${this.accounts.currentId()} · processes: ${procs.length ? procs.join(", ") : "none"}${waking.length ? ` · wake set without a process: ${waking.join(", ")}` : ""}`);
        const profile = this.options.profiles.find((p) => p.runtime === "claude" && this.isSubscription(p));
        if (profile) void this.usage(profile.id, true).catch(() => undefined);
      } catch (err) {
        this.emit("log", `claude account: tick failed: ${firstLine(err)}`);
      }
    };
    this.accountTick = setInterval(tick, ACCOUNT_TICK_MS);
    this.accountTick.unref?.();
  }

  /** 远程额度 (2026-11-06): what usage() last read, without asking the account. */
  cachedUsage(profileId: Id): AccountUsage | AccountUsage[] | null {
    const profile = this.options.profiles.find((p) => p.id === profileId);
    if (!profile || !this.isSubscription(profile)) return null;
    return this.usageTracker.cached(profile);
  }

  /** The session's title in its transcript (what `claude --resume` lists); a session without a transcript yet keeps it here only. */
  async rename(sessionId: Id, title: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    const home = this.homeOf(sessionId);
    if (session.runtimeRef && hasTranscript(session.runtimeRef, home)) {
      const dir = this.store.getWorkspace(session.workspaceId)?.path;
      try {
        await withConfigDir(home, () => renameSession(session.runtimeRef!, title, dir ? { dir } : {}));
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
        await live.q.applyFlagSettings({ effortLevel: (options.effort as never) ?? null, fastMode: (options.fast as never) ?? null });
      } catch (err) {
        this.emit("log", `could not switch options of ${sessionId}: ${String(err)}`);
      }
    }
    return session;
  }

  /** Models: the provider's own list (GLM), or Claude Code's list for the account (asked without a model call). */
  async choices(profileId: Id): Promise<ProfileChoices> {
    const profile = this.profile(profileId);
    const provider = profile.provider ? this.options.providers[profile.provider] : undefined;
    // 帮我审批 (auto) asks Anthropic's classifier: another endpoint (GLM…) has none.
    const permissions = provider?.baseUrl ? CLAUDE_PERMISSIONS.map((p) => (p.id === "auto" ? { ...p, unavailable: "只有 Anthropic 的 Claude 能用（第三方模型没有这个分类器）" } : p)) : CLAUDE_PERMISSIONS;
    const base = { profileId, permissions, defaultPermission: CLAUDE_DEFAULT_PERMISSION };
    if (provider?.models) return { ...base, models: provider.models.map((m) => ({ ...m, ...(m.id === profile.model ? { isDefault: true } : {}) })), source: "builtin" };
    const cacheKey = `${profileId}|${this.newHome(profile).login}|${this.isSubscription(profile) ? this.accounts.currentId() : ""}`;
    const cached = this.modelCache.get(cacheKey);
    // An older list is answered at once and asked again behind it: asking starts a CLI, seconds that 开始 and 新会话
    // waited for (2026-10-23).
    if (cached) {
      if (Date.now() - cached.at >= 10 * 60_000) this.askModelsFor(profile, cacheKey).catch((err: unknown) => this.emit("log", `could not ask Claude Code for its models (${profileId}): ${firstLine(err)}`));
      return { ...base, models: cached.models, source: "cli" };
    }
    try {
      return { ...base, models: await this.askModelsFor(profile, cacheKey), source: "cli" };
    } catch (err) {
      this.emit("log", `could not ask Claude Code for its models (${profileId}): ${firstLine(err)}`);
      return { ...base, models: CLAUDE_BUILTIN_MODELS, source: "builtin" };
    }
  }

  /** Asks the CLI for the profile's models into the cache; one ask at a time per profile and login. */
  private async askModelsFor(profile: ModelProfile, cacheKey: string): Promise<ModelOption[]> {
    let asking = this.askingModels.get(cacheKey);
    if (!asking) {
      const env = claudeEnv(profile, this.options.providers, this.options.credentials, this.newHome(profile), this.options.baseEnv);
      asking = askModels(profile, env, this.options.claudeHome).finally(() => this.askingModels.delete(cacheKey));
      this.askingModels.set(cacheKey, asking);
    }
    const models = await asking;
    this.modelCache.set(cacheKey, { at: Date.now(), models });
    return models;
  }

  async archive(sessionId: Id): Promise<Session[]> {
    const changed = this.archiveTree(sessionId);
    // Claude 多账号的排查 (2026-11-12, 那边: 归档的会话是不是还在跑): what was alive when it was archived.
    const alive = changed.filter((s) => this.live.has(s.id));
    if (alive.length || changed.some((s) => s.wake)) {
      this.emit("log", `claude account: archived ${changed.map((s) => s.id).join(", ")}; closing ${alive.length ? alive.map((s) => `${s.id} on ${this.live.get(s.id)?.account ?? "-"}${this.live.get(s.id)?.running ? " (in a turn)" : ""}`).join(", ") : "no process"}${changed.some((s) => s.wake) ? ` · wake was set: ${changed.filter((s) => s.wake).map((s) => `${s.id}${s.wake?.limit ? ` limit autoContinue=${s.wake.limit.autoContinue}` : ""}${s.wake?.loop ? " loop" : ""}`).join(", ")}` : ""}`);
    }
    await Promise.all(changed.map((s) => this.close(s.id)));
    return changed;
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    return this.unarchiveTree(sessionId);
  }

  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.asks.respondApproval(sessionId, approvalId, decision);
  }

  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    return this.asks.answerQuestion(sessionId, itemId, reply);
  }

  /**
   * Hands the session to a terminal: closes Studio's own process for it, remembers how far the transcript went, and
   * marks the session read-only. Returns what the terminal should run; the key is only in `env`.
   */
  async handoff(sessionId: Id): Promise<{ command: string; cwd: string; env: Record<string, string> }> {
    const session = this.writable(sessionId);
    if (this.live.get(sessionId)?.running) throw Object.assign(new Error("回复还在生成，等这一轮结束或先打断，再交给终端"), { code: "conflict" });
    const exe = requireClaudeCode();
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
    const home = this.homeOf(sessionId);
    const env = { ...shellHelpEnv(this.store), ...claudeEnv(this.profile(session.profileId), this.options.providers, this.options.credentials, home, this.options.baseEnv), ...claudeAutoCompactEnv(this.store, session.profileId) };
    await this.close(sessionId);
    const ref = session.runtimeRef!;
    const seen = hasTranscript(ref, home) ? (await readTranscript(ref, workspace.path, home)).length : 0;
    this.store.setKv(handoffKey(sessionId), String(seen));
    this.updateSession(sessionId, { writer: "terminal-handoff" });
    // The Claude Code the sessions run on, so the transcript format matches; never the "auto" permission mode.
    const resume = hasTranscript(ref, home) ? `--resume ${ref}` : `--session-id ${ref}`;
    return { command: `& '${exe.replace(/'/g, "''")}' ${resume} --permission-mode default`, cwd: workspace.path, env };
  }

  /** Takes a handed-off session back and imports what the terminal added to the transcript. */
  async reclaim(sessionId: Id): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.writer !== "terminal-handoff") return session;
    const workspace = this.store.getWorkspace(session.workspaceId);
    const seen = Number(this.store.getKv(handoffKey(sessionId))?.value ?? "0") || 0;
    let added = 0;
    const home = this.homeOf(sessionId);
    if (workspace && session.runtimeRef && hasTranscript(session.runtimeRef, home)) {
      const messages = await readTranscript(session.runtimeRef, workspace.path, home);
      added = importTranscript(this.core, sessionId, this.cwdOf(sessionId), messages.slice(seen));
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
    this.wake.shutdown();
    this.accounts.shutdown();
    if (this.accountTick) clearInterval(this.accountTick);
    this.accountTick = null;
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
    await Promise.all([...this.closing.values()]);
  }

  /** The person: stop the loop, or switch going on after a usage limit (stage 15). */
  setWakeChoice(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session> {
    return this.wake.setChoice(sessionId, choice);
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
    const list = await askCommands(env, workspace.path);
    this.commandCache.set(key, { at: Date.now(), list });
    return list;
  }

  /** Every command goes to Claude Code as the text `/name args` (compact included); it answers as for a message. */
  async runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    const sent = await this.sendMessage(sessionId, `/${name}${args ? ` ${args}` : ""}`);
    return { mode: sent.mode };
  }

  async stopBackground(sessionId: Id, taskId: string): Promise<void> {
    const live = this.live.get(sessionId);
    const [item] = this.store.findItems(sessionId, "background", { taskId }, { limit: 1 });
    if (!item || item.type !== "background") throw Object.assign(new Error(`background command ${taskId} not found`), { code: "not_found" });
    if (item.state !== "running") return;
    // Without its process the command is gone already.
    if (!live?.bgItems.has(taskId)) return this.turns.settleBackground(item.id, "stopped");
    // Not answered in time (2026-11-01, a CLI stuck on a command): shown as stopped, with what that means.
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    const answered = await Promise.race([live.q.stopTask(taskId).then(() => true), new Promise<false>((r) => setTimeout(() => r(false), grace).unref?.())]);
    if (answered) return;
    const [still] = this.store.findItems(sessionId, "background", { taskId }, { limit: 1 });
    if (still?.type !== "background" || still.state !== "running") return;
    this.turns.settleBackground(still.id, "stopped");
    this.appendItem(sessionId, { type: "notice", level: "warning", message: `点了停止 ${Math.round(grace / 1000)} 秒后 Claude 还没回应，Studio 先把这条后台命令标成已停止，它可能还在跑。要彻底停掉，就停止这个会话。` });
  }

  /** Prompt suggestions follow the setting in running sessions too (the CLI's own setting of that name). */
  applyChatSettings(settings: ChatSettings): void {
    for (const [id, live] of this.live) {
      void live.q.applyFlagSettings({ promptSuggestionEnabled: settings.promptSuggestions } as never).catch((err: unknown) => this.emit("log", `could not apply chat settings to ${id}: ${firstLine(err)}`));
    }
  }

  // ---- the process --------------------------------------------------------------------------------------------------

  private ensureLive(session: Session): Live {
    const existing = this.live.get(session.id);
    if (existing) return existing;
    const profile = this.profile(session.profileId);
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
    const ref = session.runtimeRef!;
    const home = this.homeOf(session.id);
    const agentsMd = agentsMdInstructions(workspace.path);
    // Before anything is set up: without a Claude Code the person is told so, not a spawn error.
    const exe = requireClaudeCode();

    const queue: LiveInput[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (queue.length) {
          const next = queue.shift()!;
          yield { type: "user", message: { role: "user", content: next.content }, parent_tool_use_id: null, session_id: ref, uuid: next.uuid as `${string}-${string}-${string}-${string}-${string}` };
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    }

    const plan = this.mcpPlan(session.id, home);
    const live = newLive(
      (next) => {
        queue.push(next);
        wake?.();
      },
      () => {
        ended = true;
        wake?.();
      },
    );
    // 自动压缩点 (设置 → 模型) over the provider's own window; 命令行适配 (agent-env.ts) under everything.
    const env = { ...shellHelpEnv(this.store), ...claudeEnv(profile, this.options.providers, this.options.credentials, home, this.options.baseEnv), ...claudeAutoCompactEnv(this.store, profile.id) };
    // Claude 多账号的排查 (2026-11-12): which account this process is meant to bill, and what decides its login.
    if (home.login === "local") {
      live.account = this.accounts.currentId();
      this.emit("log", `claude account: ${session.id} starts a process on account ${live.account} (${this.accountLabel(live.account)}) · ${authEnvSummary(env)} · ${settingsAuthSummary(home.dir)} · ${dirAccountSummary(home.dir, !!home.explicit)}`);
    }
    live.q = query({
      prompt: input(),
      options: {
        cwd: workspace.path,
        env,
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
        // A subagent's thinking and text as well as its tool calls (2026-10-27): its child session reads as a
        // conversation, and its output counts come closer to the real ones.
        forwardSubagentText: true,
        promptSuggestions: readChatSettings(this.store).promptSuggestions,
        canUseTool: (toolName, toolInput, ctx) => this.asks.askPerson(session.id, live, toolName, toolInput, ctx),
        hooks: STRIP_SUBAGENT_MODE,
        ...this.mcpOptions(session.id, plan, live),
        // MCP 设置 (2026-11-04): in the person's own config dir the CLI loads their servers itself (OAuth, plugins and
        // its approvals as in a terminal); those turned off are denied to this process only (managedSettings is the
        // SDK's policy tier: nothing is written, unlike toggleMcpServer, which writes ~/.claude.json), .mcp.json ones
        // turned on are approved for it. Elsewhere, or with 加载本机 off, only what Studio passes (strict).
        ...(plan.strict ? { strictMcpConfig: true } : {}),
        ...(plan.deny.length ? { managedSettings: { deniedMcpServers: plan.deny.map((serverName) => ({ serverName })) } } : {}),
        // Fast mode (2026-11-05): only when chosen (on or off); never chosen, the person's own setting applies.
        ...(plan.enableJson.length || session.options.fast !== undefined
          ? { settings: { ...(plan.enableJson.length ? { enabledMcpjsonServers: plan.enableJson } : {}), ...(session.options.fast !== undefined ? { fastMode: session.options.fast } : {}) } }
          : {}),
        // A session that already has a transcript continues it; a new one starts under the id Studio chose.
        ...(hasTranscript(ref, home) ? { resume: ref } : { sessionId: ref }),
        pathToClaudeCodeExecutable: exe,
        spawnClaudeCodeProcess: spawnClaudeProcess(
          (line) => this.emit("log", `${session.id}: ${line}`),
          live.account
            ? {
                started: (pid, spawned) => this.emit("log", `claude account: ${session.id} pid ${pid ?? "?"} started on ${live.account} · ${authEnvSummary(spawned)}`),
                exited: (pid, code, sig) => this.emit("log", `claude account: ${session.id} pid ${pid ?? "?"} (on ${live.account}) exited${code !== null ? ` code ${code}` : ""}${sig ? ` ${sig}` : ""}`),
              }
            : undefined,
        ),
      },
    });
    if (live.account) this.checkProcessAccount(session.id, live);
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

  private onMessage(sessionId: Id, live: Live, m: SDKMessage): void {
    this.messages.onMessage(sessionId, live, m);
  }

  /** The query ended: normally (closed), after an interrupt, or with an error. */
  private finish(sessionId: Id, live: Live, err: unknown): void {
    if (live.finished) return;
    live.finished = true;
    if (live.account) this.emit("log", `claude account: ${sessionId} query on ${live.account} ended (${live.closedByHost ? "closed by Studio" : err ? `error: ${firstLine(err)}` : "by the CLI"})`);
    if (this.live.get(sessionId) === live) this.live.delete(sessionId);
    this.clearIdle(live);
    for (const id of live.streaming) this.updateItem(id, (it) => (it.type === "agent" ? { ...it, markdown: live.text.get(id) ?? it.markdown, streaming: false } : it));
    for (const t of live.thinking) this.updateItem(t.itemId, (it) => (it.type === "reasoning" ? { ...it, text: live.text.get(t.itemId) ?? it.text, streaming: false } : it));
    this.turns.end(live, err && !live.interrupted ? "failed" : "interrupted");
    this.asks.dropAll(live);
    for (const id of live.tools.values()) this.updateItem(id, (it) => (it.type === "tool" && it.status === "running" ? { ...it, status: "failed" } : it));
    // Background commands end with their Claude Code process.
    for (const id of live.bgItems.values()) this.turns.settleBackground(id, "stopped");
    if (live.compaction) this.updateItem(live.compaction, (it) => (it.type === "compaction" && it.state === "running" ? { ...it, state: "failed" } : it));
    // Messages still waiting went with the process (2026-11-02: the 15 s close after 停止 lost them unseen): the person
    // sends them again (重新发送) — not by itself, a process that had to be closed may be stuck.
    for (const itemId of live.undelivered.values()) this.updateItem(itemId, (it) => (it.type === "user" && it.delivery === "waiting" ? withDelivery(it, "unsent") : it));
    live.undelivered.clear();
    live.atCli.clear();
    for (const settle of live.onAtCli.values()) settle();
    this.subagents.endAll(live, !!err && !live.interrupted);
    if (!this.store.getSession(sessionId)) return;
    // Its CLI's timers went with the process: Studio's own takes over (see studioWakeDue).
    if (this.store.getSession(sessionId)?.wake) this.wake.arm(sessionId);
    if (err && !live.interrupted) {
      this.appendItem(sessionId, { type: "error", message: `Claude 会话异常结束：${firstLine(err)}` }, { method: "query/error" });
      this.setStatus(sessionId, "error");
    } else if (live.running || live.interrupted) {
      const cut = live.closedByHost && !live.interrupted;
      if (cut) this.appendItem(sessionId, { type: "notice", level: "warning", message: "Host 关闭时这条会话的回复被中断了。发一条消息即可接着对话。" });
      // Cut off from outside (2026-10-28): red until a message carries it on; the person's 停止 leaves it idle.
      this.setStatus(sessionId, cut ? "interrupted" : "idle");
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

  private scheduleIdle(sessionId: Id, live: Live): void {
    this.clearIdle(live);
    // A change of the person's MCP servers waited for this turn: the next message starts a process that has it.
    if (live.mcpStale && this.canRestart(live) && !keepsProcess(this.store.getSession(sessionId)?.wake, this.now())) {
      void this.close(sessionId);
      return;
    }
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

  /** Items appended while a turn runs belong to it (the subagent sessions' items do not). */
  protected override appendItem(sessionId: Id, body: NewItemBody, raw?: { method: string; itemId?: string; turnId?: string }): SessionItem {
    const turnId = raw?.turnId ?? (body.type === "turn" ? undefined : this.live.get(sessionId)?.turn?.id);
    return super.appendItem(sessionId, body, turnId ? { method: body.type, ...raw, turnId } : raw);
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  /** After a Host restart no Claude process is running: turns that were in flight are over. */
  private recoverAfterRestart(): void {
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "claude") continue;
      // Only what was under way, picked out by SQLite (2026-10-20: every item of every session was read and parsed).
      for (const item of this.store.listUnfinishedItems(s.id)) if (item.type === "question" && item.state === "pending") this.asks.cancelQuestion(item.id);
      this.settleLeftovers(s.id, { approvals: true });
      if (inTurn(s.status)) {
        if (s.kind !== "sub") this.appendItem(s.id, { type: "notice", level: "warning", message: "Host 重启时这条会话的回复被中断了。发一条消息即可接着对话。" });
        this.setStatus(s.id, "interrupted");
      } else if (s.kind === "sub" && s.status === "idle") {
        // Before 2026-10-27 a stopped subagent was left `idle`: nothing else leaves one there (a finished one is completed).
        this.setStatus(s.id, "interrupted");
      }
      // The CLI's own timers went with its process: Studio sends the loop's wakeup (and goes on after a limit) itself.
      if (s.wake && !s.archivedAt) {
        if (s.wake.loop) this.appendItem(s.id, { type: "notice", level: "info", message: "Host 重启后，这条会话的 loop 由 Studio 按时唤醒。" });
        this.wake.arm(s.id);
      }
    }
  }

  /**
   * The AMO MCP as an in-process SDK server bound to this session. Reads and writes to the session's own task are
   * allowed up front; everything else still goes through canUseTool.
   */
  private mcpOptions(sessionId: Id, plan: McpLaunch, live: Live) {
    const tools = this.options.mcpTools?.(sessionId) ?? [];
    const others = Object.fromEntries(Object.entries(plan.explicit).map(([name, spec]) => [name, sdkServer(spec)]));
    if (!tools.length) {
      live.mcp = { plan, amo: null, dynamic: {} };
      return Object.keys(others).length ? { mcpServers: others as never } : {};
    }
    const server = createSdkMcpServer({
      name: AMO_MCP_NAME,
      version: "0.5.0",
      instructions: this.options.mcpInstructions?.(sessionId) ?? AMO_MCP_INSTRUCTIONS,
      tools: tools.map((t) => tool(t.name, t.description, t.inputSchema, async (args) => t.run(args as Record<string, unknown>), { annotations: { readOnlyHint: t.readOnly } })),
      // Claude Code 2.1.304 (SDK 0.3.304) defers MCP tools behind ToolSearch by default: the agent would have to look
      // AMO's few, always-used tools up before every first use. They stay in the prompt (2026-10-20).
      alwaysLoad: true,
    });
    live.mcp = { plan, amo: server, dynamic: {} };
    return { mcpServers: { ...(others as Record<string, never>), [AMO_MCP_NAME]: server }, allowedTools: tools.filter((t) => t.autoApprove).map((t) => `mcp__${AMO_MCP_NAME}__${t.name}`) };
  }

  /** The session's MCP servers now. `native`: it runs in the person's own config dir (the default account's). */
  private mcpPlan(sessionId: Id, home: ClaudeHome): McpLaunch {
    const native = home.login === "local" && sameDir(home.dir, this.local.dir);
    return this.options.mcp?.launch(sessionId, native) ?? { explicit: {}, deny: [], enableJson: [], strict: home.login === "local" };
  }

  /**
   * MCP 设置: a change of Studio's servers reaches the running process at once (setMcpServers, amo passed along: it
   * replaces the whole dynamic set); one of the person's own (denied or approved names, strict) needs a new process —
   * closed now when idle, else when it gets idle (scheduleIdle); the next message resumes it.
   */
  async refreshMcp(sessionId: Id): Promise<McpApply> {
    const live = this.live.get(sessionId);
    if (!live?.mcp || !this.options.mcp) return "next-message";
    const next = this.mcpPlan(sessionId, this.homeOf(sessionId));
    const started = live.mcp.plan.explicit;
    // What only a new process takes: the person's own servers, or one given at the start going or changing.
    const startChanged = Object.entries(started).some(([name, spec]) => JSON.stringify(next.explicit[name]) !== JSON.stringify(spec));
    if (!sameProcessPart(live.mcp.plan, next) || startChanged) {
      live.mcpStale = true;
      if (this.canRestart(live)) {
        await this.close(sessionId);
        return "next-message";
      }
      return "after-turn";
    }
    const dynamic = Object.fromEntries(Object.entries(next.explicit).filter(([name]) => !(name in started)));
    if (JSON.stringify(sortedEntries(dynamic)) === JSON.stringify(sortedEntries(live.mcp.dynamic))) return "now";
    const all = Object.fromEntries(Object.entries(dynamic).map(([name, spec]) => [name, sdkServer(spec)])) as Record<string, never>;
    if (live.mcp.amo) all[AMO_MCP_NAME] = live.mcp.amo as never;
    const result = await live.q.setMcpServers(all);
    live.mcp = { ...live.mcp, dynamic };
    const failed = Object.entries(result.errors ?? {});
    if (failed.length) this.appendItem(sessionId, { type: "notice", level: "warning", message: `MCP 没连上：${failed.map(([n, e]) => `${n}（${firstLine(e)}）`).join("；")}` });
    return "now";
  }

  async mcpStatus(sessionId: Id): Promise<Array<{ name: string; status: string; error?: string; source?: string }> | null> {
    const live = this.live.get(sessionId);
    if (!live || live.finished) return null;
    const list = await withTimeout(live.q.mcpServerStatus(), 5_000);
    return list
      .filter((x) => x.name !== AMO_MCP_NAME)
      .map((x) => {
        const source = x.source ?? x.scope;
        return { name: x.name, status: x.status, ...(x.error ? { error: x.error } : {}), ...(source ? { source } : {}) };
      });
  }

  /** Nothing of the process's own is under way: no turn, approval, question, background command or running agent. */
  private canRestart(live: Live): boolean {
    if (live.running || live.background.size || live.approvals.size || live.questions.size) return false;
    return ![...live.subs.values()].some((id) => this.store.getSession(id)?.status === "running");
  }

  /** Whether the profile is the Claude subscription (the only one the local login applies to). */
  private isSubscription(profile: ModelProfile): boolean {
    return !!profile.provider && this.options.providers[profile.provider]?.auth === "oauth";
  }

  /** Where a session started now runs: the subscription on the current account, every other profile Studio's own dir. */
  private newHome(profile: ModelProfile): ClaudeHome {
    return this.isSubscription(profile) && readClaudeLogin(this.store) === "local" ? this.accountHome() : { dir: this.options.claudeHome, login: "token" };
  }

  /**
   * Where an existing session runs: the way it was started. With the local login that is the current account, whichever
   * it was started on: every account's dir shares the default dir's `projects`, so the transcript is found (2026-11-03).
   */
  private homeOf(sessionId: Id): ClaudeHome {
    return sessionClaudeLogin(this.store, sessionId) === "local" ? this.accountHome() : { dir: this.options.claudeHome, login: "token" };
  }

  private accountHome(): ClaudeHome {
    const { dir, explicit } = this.accounts.currentHome();
    return { dir, explicit, login: "local" };
  }

  /** The key of a profile's rate-limit windows: the subscription's are the current account's. */
  private limitKey(profileId: Id): string {
    const profile = this.options.profiles.find((p) => p.id === profileId);
    return profile && this.isSubscription(profile) ? `${profileId}|${this.accounts.currentId()}` : profileId;
  }

  /**
   * Claude 多账号: switching waits until no session on the local login is at work — a turn, an approval or question
   * waiting, a background command or a subagent in its process (the user, 2026-11-03: 会话进行中禁止切换).
   */
  private switchBlocked(): string | null {
    const busy = new Set<Id>();
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "claude" || s.archivedAt || s.kind === "sub") continue;
      if (!inTurn(s.status)) continue;
      if (sessionClaudeLogin(this.store, s.id) === "local") busy.add(s.id);
    }
    for (const [id, live] of this.live) {
      if (sessionClaudeLogin(this.store, id) !== "local") continue;
      if (live.running || live.background.size || live.approvals.size || live.questions.size) busy.add(id);
    }
    return busy.size ? `有 ${busy.size} 个 Claude 会话正在进行，等它${busy.size > 1 ? "们" : ""}结束（或停止）后再切换账号` : null;
  }

  /** Before switching: the idle processes on the old account close; their next message resumes on the new one. */
  private async beforeAccountSwitch(from?: Id, to?: Id): Promise<void> {
    const ids = [...this.live.keys()].filter((id) => sessionClaudeLogin(this.store, id) === "local");
    this.emit("log", `claude account: switching ${from ?? "?"} -> ${to ?? "?"}; closing ${ids.length} process(es)${ids.length ? `: ${ids.map((id) => `${id} on ${this.live.get(id)?.account ?? "-"}`).join(", ")}` : ""}`);
    await Promise.all(ids.map((id) => this.close(id)));
    await Promise.all(ids.map((id) => this.closing.get(id)));
    const left = [...this.live.keys()].filter((id) => sessionClaudeLogin(this.store, id) === "local");
    this.emit("log", `claude account: switch ${from ?? "?"} -> ${to ?? "?"}: processes closed${left.length ? `; WARNING still alive: ${left.join(", ")}` : ""}`);
  }

  private cwdOf(sessionId: Id): string | undefined {
    const s = this.store.getSession(sessionId);
    return s ? this.store.getWorkspace(s.workspaceId)?.path : undefined;
  }

  private profile(id: Id): ModelProfile {
    const p = this.options.profiles.find((x) => x.id === id);
    if (!p || p.runtime !== "claude") throw new Error(`unknown Claude profile ${id}`);
    return p;
  }

  protected override writable(id: Id): Session {
    if (this.requireSession(id).kind === "sub") throw Object.assign(new Error("Claude 的子 agent 不能单独接收消息，请在父会话里继续"), { code: "read_only" });
    return super.writable(id);
  }
}

/** A message for the CLI: image blocks (read now, so a missing file fails the send) before the text. */
function messageContent(text: string, images: readonly Attachment[]): SDKUserMessage["message"]["content"] {
  const blocks = images.map((a) => ({ type: "image" as const, source: { type: "base64" as const, media_type: a.mime as "image/png", data: readFileSync(a.path).toString("base64") } }));
  return blocks.length ? [...blocks, ...(text ? [{ type: "text" as const, text }] : [])] : text;
}

/** Two config dirs are the same folder (case and slashes aside, as on Windows). */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => resolvePath(p).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function sortedEntries<T>(v: Record<string, T>): Array<[string, T]> {
  return Object.entries(v).sort(([a], [b]) => a.localeCompare(b));
}
