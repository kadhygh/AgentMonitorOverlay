import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSdkMcpServer, forkSession, query, renameSession, tool, type HookCallbackMatcher, type HookEvent, type SDKMessage, type SDKUserMessage, type SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { parseSlashCommand, type ApprovalDecision, type Attachment, type ChatSettings, type Id, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionReply, type Session, type SessionItem, type SessionOptions, type SlashCommandList, type SlashCommandResult, type Workspace, type AccountUsage } from "@amo-studio/protocol";
import { readChatSettings } from "../chat-settings.js";
import { CLAUDE_BUILTIN_MODELS, CLAUDE_DEFAULT_PERMISSION, CLAUDE_PERMISSIONS, claudePermissionMode } from "../choices.js";
import type { Store } from "../../store/store.js";
import type { CredentialReader } from "../credentials.js";
import { RuntimeBase, type NewItemBody, type SendMode, type SessionRuntimeApi } from "../runtime.js";
import { claudeEnv, type ClaudeHome, type ClaudeProviderDef } from "./claude-env.js";
import { claudeAutoCompactEnv } from "../compact.js";
import { localClaudeHome, readClaudeLogin, rememberSessionLogin, sessionClaudeLogin } from "./claude-login.js";
import { keepsProcess } from "./wake.js";
import { agentsMdInstructions } from "./project-instructions.js";
import { AMO_MCP_INSTRUCTIONS, AMO_MCP_NAME, type AmoTool } from "../../mcp/tools.js";
import { ClaudeAsks } from "./asks.js";
import { BLOCKED_COMMANDS, claudeCommands } from "./commands.js";
import type { ClaudeCore } from "./core.js";
import { newLive, type Live } from "./live.js";
import { ClaudeMessages } from "./messages.js";
import { askCommands, askModels, CLI_SETTING_SOURCES, withTimeout } from "./probe.js";
import { ClaudeSubagents } from "./subagents.js";
import { firstLine } from "./tool-use.js";
import { bundledClaudeExe, handoffKey, hasTranscript, importTranscript, readTranscript, withConfigDir } from "./transcripts.js";
import { ClaudeTurns } from "./turns.js";
import { ClaudeUsageTracker } from "./usage-tracker.js";
import { ClaudeWake } from "./wake-control.js";

export { claudeCommands, localCommandText } from "./commands.js";
export { askedQuestions, describeToolUse, retryReason } from "./tool-use.js";

// Drives Claude sessions through the Claude Agent SDK. Behaviour follows spikes/RESULTS.md section h:
// - permissionMode is always "default" (the CLI otherwise picks "auto", where a classifier approves instead of a person);
//   canUseTool waits for the person and becomes an approval card (asks.ts);
// - a message sent while a turn runs is queued for the next turn (the SDK does not fold it into the running one);
// - after interrupt() the SDK ends the query with an error, which is treated as "interrupted";
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
  now?: () => Date;
  /** An idle query (no turn, no background task) is closed after this long; the next message resumes it. */
  idleCloseMs?: number;
  /** Variables the child environment starts from (default: process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** The AMO MCP tools, given to every Claude session in-process (no token reaches the CLI). */
  mcpTools?: (sessionId: Id) => AmoTool[];
  /** The MCP server's instructions for this session (its role card after the general ones); the general ones when absent. */
  mcpInstructions?: (sessionId: Id) => string;
}

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
  /** Queries being closed: a new one for the same session must wait, or the CLI says the session id is in use. */
  private readonly closing = new Map<Id, Promise<void>>();
  /** Skill names per profile, from the CLI's init message (its command list does not tell skills apart). */
  private readonly skillNames = new Map<Id, Set<string>>();
  /** Command lists asked without a session (profile and folder -> list). */
  private readonly commandCache = new Map<string, { at: number; list: SdkSlashCommand[] }>();
  /** The `/` command a session was last sent, to name the output of a command that runs without the model. */
  private readonly lastCommand = new Map<Id, string>();

  /** The person's own config dir; `explicit` when they set CLAUDE_CONFIG_DIR (read once: helpers set it for a while). */
  private readonly local: { dir: string; explicit: boolean };

  private readonly core: ClaudeCore;
  private readonly usageTracker: ClaudeUsageTracker;
  private readonly wake: ClaudeWake;
  private readonly turns: ClaudeTurns;
  private readonly asks: ClaudeAsks;
  private readonly subagents: ClaudeSubagents;
  private readonly messages: ClaudeMessages;

  constructor(private readonly options: ClaudeRuntimeOptions) {
    super(options.store, "claude", options.now);
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
    this.usageTracker = new ClaudeUsageTracker(this.store, { localDir: this.local.dir, baseUrl: (p) => (p.provider ? this.options.providers[p.provider]?.baseUrl : undefined) });
    this.wake = new ClaudeWake(this.core, (sessionId) => {
      const profileId = this.store.getSession(sessionId)?.profileId;
      return profileId ? this.usageTracker.usedUpUntil(profileId, this.now().getTime()) : null;
    });
    this.turns = new ClaudeTurns(this.core, (sessionId, live, by) => this.wake.onTurnStart(sessionId, live, by));
    this.asks = new ClaudeAsks(this.core);
    this.subagents = new ClaudeSubagents(this.core, this.turns);
    this.messages = new ClaudeMessages(this.core, {
      turns: this.turns,
      subagents: this.subagents,
      wake: this.wake,
      recordRateLimit: (sessionId, info) => {
        const profileId = this.store.getSession(sessionId)?.profileId;
        if (profileId) this.usageTracker.record(profileId, info);
      },
      noteSkills: (sessionId, skills) => {
        const profileId = this.store.getSession(sessionId)?.profileId;
        if (profileId) this.skillNames.set(profileId, new Set(skills));
      },
      lastCommand: (sessionId) => this.lastCommand.get(sessionId),
      scheduleIdle: (sessionId, live) => this.scheduleIdle(sessionId, live),
    });
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
    if (!live.running) this.turns.started(sessionId, live, "person");
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
    this.asks.declineAll(live);
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
    if (!hasTranscript(parent.runtimeRef, home)) throw Object.assign(new Error("这个会话还没有对话内容，不能分支"), { code: "conflict" });
    // The copy stays in the parent's config dir, so the branch runs the way the parent did.
    if (home.login === "local" && !this.isSubscription(profile)) throw Object.assign(new Error("这个会话用本机 Claude Code 的登录，分支只能继续用 Claude 订阅"), { code: "bad_request" });
    const title = `${parent.title || "会话"} · 分支`;
    const forked = await withConfigDir(home, () => forkSession(parent.runtimeRef!, { dir: workspace.path, title }));
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

  /** The Claude subscription's quota (see ClaudeUsageTracker); none for other profiles. */
  async usage(profileId: Id, refresh = false): Promise<AccountUsage | null> {
    const profile = this.profile(profileId);
    if (!this.isSubscription(profile)) return null;
    return this.usageTracker.usage(profile, refresh);
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
      const env = claudeEnv(profile, this.options.providers, this.options.credentials, this.newHome(profile), this.options.baseEnv);
      const models = await askModels(profile, env, this.options.claudeHome);
      this.modelCache.set(cacheKey, { at: Date.now(), models });
      return { ...base, models, source: "cli" };
    } catch (err) {
      this.emit("log", `could not ask Claude Code for its models (${profileId}): ${firstLine(err)}`);
      return { ...base, models: CLAUDE_BUILTIN_MODELS, source: "builtin" };
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
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
    const home = this.homeOf(sessionId);
    const env = { ...claudeEnv(this.profile(session.profileId), this.options.providers, this.options.credentials, home, this.options.baseEnv), ...claudeAutoCompactEnv(this.store) };
    await this.close(sessionId);
    const ref = session.runtimeRef!;
    const seen = hasTranscript(ref, home) ? (await readTranscript(ref, workspace.path, home)).length : 0;
    this.store.setKv(handoffKey(sessionId), String(seen));
    this.updateSession(sessionId, { writer: "terminal-handoff" });
    // The same Claude Code build as the SDK, so the transcript format always matches; never the "auto" permission mode.
    const resume = hasTranscript(ref, home) ? `--resume ${ref}` : `--session-id ${ref}`;
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
    const item = this.store.listItems(sessionId).find((i) => i.type === "background" && i.taskId === taskId);
    if (!item || item.type !== "background") throw Object.assign(new Error(`background command ${taskId} not found`), { code: "not_found" });
    if (item.state !== "running") return;
    // Without its process the command is gone already.
    if (!live?.bgItems.has(taskId)) return this.turns.settleBackground(item.id, "stopped");
    await live.q.stopTask(taskId);
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

    const live = newLive(
      (content) => {
        queue.push(content);
        wake?.();
      },
      () => {
        ended = true;
        wake?.();
      },
    );
    live.q = query({
      prompt: input(),
      options: {
        cwd: workspace.path,
        // 自动压缩点 (设置 → 模型) over the provider's own window.
        env: { ...claudeEnv(profile, this.options.providers, this.options.credentials, home, this.options.baseEnv), ...claudeAutoCompactEnv(this.store) },
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
        canUseTool: (toolName, toolInput, ctx) => this.asks.askPerson(session.id, live, toolName, toolInput, ctx),
        hooks: STRIP_SUBAGENT_MODE,
        ...this.mcpOptions(session.id),
        // A session that already has a transcript continues it; a new one starts under the id Studio chose.
        // The local login brings the person's config dir: only Studio's MCP server, not the ones they set up there.
        ...(home.login === "local" ? { strictMcpConfig: true } : {}),
        ...(hasTranscript(ref, home) ? { resume: ref } : { sessionId: ref }),
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

  private onMessage(sessionId: Id, live: Live, m: SDKMessage): void {
    this.messages.onMessage(sessionId, live, m);
  }

  /** The query ended: normally (closed), after an interrupt, or with an error. */
  private finish(sessionId: Id, live: Live, err: unknown): void {
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
    this.subagents.endAll(live, !!err && !live.interrupted);
    if (!this.store.getSession(sessionId)) return;
    // Its CLI's timers went with the process: Studio's own takes over (see studioWakeDue).
    if (this.store.getSession(sessionId)?.wake) this.wake.arm(sessionId);
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
      for (const item of this.store.listItems(s.id)) {
        if (item.type === "approval" && item.state === "pending") this.updateItem(item.id, (it) => (it.type === "approval" ? { ...it, state: "resolved-elsewhere" } : it));
        if (item.type === "question" && item.state === "pending") this.asks.cancelQuestion(item.id);
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
        this.wake.arm(s.id);
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
      instructions: this.options.mcpInstructions?.(sessionId) ?? AMO_MCP_INSTRUCTIONS,
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

  private cwdOf(sessionId: Id): string | undefined {
    const s = this.store.getSession(sessionId);
    return s ? this.store.getWorkspace(s.workspaceId)?.path : undefined;
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
