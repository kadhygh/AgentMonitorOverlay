import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSdkMcpServer, forkSession, getSessionMessages, query, renameSession, tool, type HookCallbackMatcher, type HookEvent, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalDecision, ApprovalKind, Attachment, Id, ModelOption, ModelProfile, ProfileChoices, Session, SessionItem, SessionOptions, ToolFields, TurnState, Workspace, AccountUsage, UsageWindow } from "@amo-studio/protocol";
import { CLAUDE_BUILTIN_MODELS, CLAUDE_DEFAULT_PERMISSION, CLAUDE_PERMISSIONS, claudePermissionMode } from "../choices.js";
import type { Store } from "../../store/store.js";
import type { CredentialReader } from "../credentials.js";
import { RuntimeBase, type NewItemBody, type SendMode, type SessionRuntimeApi } from "../runtime.js";
import { classifyCommand, fileDiff, formatInput, shortPath, tail, textDiff } from "../items.js";
import { claudeEnv, type ClaudeProviderDef } from "./claude-env.js";
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

/** One running Claude Code process for a session, fed through a streaming input. */
interface Live {
  q: Query;
  /** Settles when the query has ended and its process is gone. */
  done: Promise<void>;
  push(content: SDKUserMessage["message"]["content"]): void;
  end(): void;
  running: boolean;
  interrupted: boolean;
  /** Closed by Studio (idle, archive, Host shutdown) rather than ended by the CLI. */
  closedByHost: boolean;
  background: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Tokens in the context after the latest model call of this turn (from the assistant messages' usage). */
  context?: number;
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
  /** Agent tool_use id -> child session */
  subs: Map<string, Id>;
  /** Agent calls running in the background (their tool result arrives at once; a task notification ends them) */
  backgroundSubs: Set<string>;
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
          return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: withoutKey(toolInput, "mode") } };
        },
      ],
    },
  ],
};

const DECLINED = "The person declined this in AMO Studio.";

export class ClaudeRuntime extends RuntimeBase implements SessionRuntimeApi {
  private readonly live = new Map<Id, Live>();
  /** The subscription's quota windows, from the rate_limit_event messages of its sessions. */
  private readonly usageCache = new Map<Id, Map<string, UsageWindow>>();
  private readonly usageAt = new Map<Id, string>();
  private readonly modelCache = new Map<Id, { at: number; models: ModelOption[] }>();
  /** Queries being closed: a new one for the same session must wait, or the CLI says the session id is in use. */
  private readonly closing = new Map<Id, Promise<void>>();

  constructor(private readonly options: ClaudeRuntimeOptions) {
    super(options.store, "claude", options.now);
    this.recoverAfterRestart();
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session> {
    const profile = this.profile(input.profileId);
    // Fail early (missing provider or key) rather than on the first message.
    claudeEnv(profile, this.options.providers, this.options.credentials, this.options.claudeHome, this.options.baseEnv);
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
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  /** Images go as base64 image blocks before the text (the CLI keeps them in the transcript). */
  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = []): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    // Read the images first: a missing file fails the send before anything is shown or queued.
    const blocks = images.map((a) => ({ type: "image" as const, source: { type: "base64" as const, media_type: a.mime as "image/png", data: readFileSync(a.path).toString("base64") } }));
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    await this.closing.get(sessionId);
    const live = this.ensureLive(session);
    const mode: SendMode = live.running ? "queue" : "start";
    if (!live.running) this.turnStarted(sessionId, live);
    const shown = images.map((a) => ({ id: a.id, path: a.path }));
    this.appendItem(sessionId, { type: "user", text, ...(shown.length ? { images: shown } : {}) }, { method: mode === "queue" ? "user/queued" : "user" });
    this.clearIdle(live);
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
    await live.q.interrupt().catch((err: unknown) => this.emit("log", `interrupt failed for ${sessionId}: ${String(err)}`));
  }

  /** Copies the transcript into a new Claude session (no model call); the branch continues from there. */
  async fork(sessionId: Id, profileId?: Id): Promise<Session> {
    const parent = this.requireSession(sessionId);
    if (parent.kind === "sub") throw Object.assign(new Error("Claude 的子 agent 没有独立的对话，不能分支"), { code: "read_only" });
    const profile = this.profile(profileId ?? parent.profileId);
    const workspace = this.store.getWorkspace(parent.workspaceId);
    if (!workspace || !parent.runtimeRef) throw new Error(`session ${sessionId} cannot be forked`);
    if (!this.hasTranscript(parent.runtimeRef)) throw Object.assign(new Error("这个会话还没有对话内容，不能分支"), { code: "conflict" });
    const title = `${parent.title || "会话"} · 分支`;
    const forked = await this.withConfigDir(() => forkSession(parent.runtimeRef!, { dir: workspace.path, title }));
    return this.createSession({
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
  }

  /** Switches model, effort or permissions; a running Claude Code process takes them at once. */
  /** The Claude subscription's quota, as the last rate_limit_event messages told it (none: no conversation yet). */
  async usage(profileId: Id): Promise<AccountUsage | null> {
    const profile = this.profile(profileId);
    if (profile.provider !== "anthropic") return null;
    const windows = [...(this.usageCache.get(profileId)?.values() ?? [])];
    return { profileId, label: profile.label, windows, note: windows.length ? null : "用 Claude 对话一次后显示", updatedAt: this.usageAt.get(profileId) ?? null };
  }

  private recordRateLimit(sessionId: Id, info: { rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    const session = this.store.getSession(sessionId);
    if (!session || !info.rateLimitType) return;
    const labels: Record<string, string> = { five_hour: "5 小时", seven_day: "每周", seven_day_opus: "Opus 每周", seven_day_sonnet: "Sonnet 每周", overage: "超额" };
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
    if (session.runtimeRef && this.hasTranscript(session.runtimeRef)) {
      const dir = this.store.getWorkspace(session.workspaceId)?.path;
      try {
        await this.withConfigDir(() => renameSession(session.runtimeRef!, title, dir ? { dir } : {}));
      } catch (err) {
        this.emit("log", `could not rename the Claude session of ${sessionId}: ${String(err)}`);
      }
    }
    return this.updateSession(sessionId, { title });
  }

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
    const cached = this.modelCache.get(profileId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return { ...base, models: cached.models, source: "cli" };
    try {
      const models = await this.askModels(profile);
      this.modelCache.set(profileId, { at: Date.now(), models });
      return { ...base, models, source: "cli" };
    } catch (err) {
      this.emit("log", `could not ask Claude Code for its models (${profileId}): ${firstLine(err)}`);
      return { ...base, models: CLAUDE_BUILTIN_MODELS, source: "builtin" };
    }
  }

  /** Starts Claude Code with no prompt just to read its model list (no model request is made), then closes it. */
  private async askModels(profile: ModelProfile): Promise<ModelOption[]> {
    const env = claudeEnv(profile, this.options.providers, this.options.credentials, this.options.claudeHome, this.options.baseEnv);
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
    if (decision === "decline" && pending.toolUseId) live.declinedTools.add(pending.toolUseId);
    pending.resolve(decision === "accept" ? { behavior: "allow", updatedInput: pending.input } : { behavior: "deny", message: DECLINED });
    this.updateItem(pending.itemId, (item) => (item.type === "approval" ? { ...item, state: decision === "accept" ? "accepted" : "declined" } : item));
    if (live.running && live.approvals.size === 0) this.setStatus(sessionId, "running");
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
    const env = claudeEnv(this.profile(session.profileId), this.options.providers, this.options.credentials, this.options.claudeHome, this.options.baseEnv);
    await this.close(sessionId);
    const ref = session.runtimeRef!;
    const seen = this.hasTranscript(ref) ? (await this.transcript(ref, workspace.path)).length : 0;
    this.store.setKv(handoffKey(sessionId), String(seen));
    this.updateSession(sessionId, { writer: "terminal-handoff" });
    // The same Claude Code build as the SDK, so the transcript format always matches; never the "auto" permission mode.
    const resume = this.hasTranscript(ref) ? `--resume ${ref}` : `--session-id ${ref}`;
    return { command: `& '${bundledClaudeExe()}' ${resume} --permission-mode default`, cwd: workspace.path, env };
  }

  /** Takes a handed-off session back and imports what the terminal added to the transcript. */
  async reclaim(sessionId: Id): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.writer !== "terminal-handoff") return session;
    const workspace = this.store.getWorkspace(session.workspaceId);
    const seen = Number(this.store.getKv(handoffKey(sessionId))?.value ?? "0") || 0;
    let added = 0;
    if (workspace && session.runtimeRef && this.hasTranscript(session.runtimeRef)) {
      const messages = await this.transcript(session.runtimeRef, workspace.path);
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
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
    await Promise.all([...this.closing.values()]);
  }

  // ---- the query ----------------------------------------------------------------------------------------------------

  private ensureLive(session: Session): Live {
    const existing = this.live.get(session.id);
    if (existing) return existing;
    const profile = this.profile(session.profileId);
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
    const ref = session.runtimeRef!;

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
      interrupted: false,
      closedByHost: false,
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
      subs: new Map(),
      backgroundSubs: new Set(),
    };
    live.q = query({
      prompt: input(),
      options: {
        cwd: workspace.path,
        env: claudeEnv(profile, this.options.providers, this.options.credentials, this.options.claudeHome, this.options.baseEnv),
        settingSources: [],
        permissionMode: claudePermissionMode(session.options.permission),
        // Lets the person switch to 全部允许 mid-session; the mode itself stays what the session chose.
        allowDangerouslySkipPermissions: true,
        ...(session.options.model ? { model: session.options.model } : {}),
        ...(session.options.effort ? { effort: session.options.effort as never } : {}),
        includePartialMessages: true,
        canUseTool: (toolName, toolInput, ctx) => this.askPerson(session.id, live, toolName, toolInput, ctx),
        hooks: STRIP_SUBAGENT_MODE,
        ...this.mcpOptions(session.id),
        // A session that already has a transcript continues it; a new one starts under the id Studio chose.
        ...(this.hasTranscript(ref) ? { resume: ref } : { sessionId: ref }),
      },
    });
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
          this.emit("log", `failed to handle a ${m.type} message for ${sessionId}: ${String(err)}`);
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
    for (const id of live.tools.values()) this.updateItem(id, (it) => (it.type === "tool" && it.status === "running" ? { ...it, status: "failed" } : it));
    for (const childId of live.subs.values()) {
      if (this.store.getSession(childId)?.status === "running") this.setStatus(childId, err && !live.interrupted ? "error" : "idle");
    }
    if (!this.store.getSession(sessionId)) return;
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
    if (parentToolUse) return this.onSubagentMessage(live, parentToolUse, m);
    switch (m.type) {
      case "rate_limit_event": {
        this.recordRateLimit(sessionId, (m as { rate_limit_info: { rateLimitType?: string; utilization?: number; resetsAt?: number } }).rate_limit_info);
        return;
      }
      case "stream_event": {
        const e = m.event as { type: string; index?: number; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string } };
        if (e.type === "message_start") {
          if (!live.running) this.turnStarted(sessionId, live);
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
            // One assistant message per completed block; it settles the oldest text item still streaming.
            const itemId = live.streaming.shift();
            if (itemId) {
              live.text.delete(itemId);
              this.updateItem(itemId, (it) => (it.type === "agent" ? { ...it, markdown: block.text, streaming: false } : it));
            } else {
              this.appendItem(sessionId, { type: "agent", markdown: block.text, streaming: false }, { method: "assistant" });
            }
          } else if (block.type === "tool_use") {
            if (block.name === "Agent" || block.name === "Task") this.startSubagent(sessionId, live, block.id, block.input as Record<string, unknown>);
            else this.addToolCard(sessionId, live, block.id, block.name, block.input as Record<string, unknown>);
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
          this.settleToolCard(live, block.tool_use_id, block.content, block.is_error === true);
        }
        return;
      }
      case "system": {
        const s = m as { subtype: string; task_id?: string; tool_use_id?: string; status?: string };
        if (s.subtype === "task_started" && s.task_id) {
          live.background.add(s.task_id);
          if (s.tool_use_id && live.subs.has(s.tool_use_id)) live.backgroundSubs.add(s.tool_use_id);
        }
        if (s.subtype === "task_notification" && s.task_id) {
          live.background.delete(s.task_id);
          const child = s.tool_use_id ? live.subs.get(s.tool_use_id) : undefined;
          if (child) this.setStatus(child, s.status === "completed" ? "completed" : s.status === "stopped" ? "idle" : "error");
        }
        return;
      }
      case "result": {
        live.running = false;
        const usage = (m as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
        // The largest context among the models the turn used (subagents may use smaller ones).
        const windows = Object.values((m as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {}).map((u) => u.contextWindow ?? 0);
        const contextWindow = windows.length ? Math.max(...windows) : 0;
        this.endTurn(live, live.interrupted ? "interrupted" : m.is_error ? "failed" : "completed", usage, contextWindow || undefined);
        if (live.interrupted) {
          live.interrupted = false;
          this.setStatus(sessionId, "idle");
        } else if (m.is_error) {
          const errors = (m as { errors?: string[] }).errors;
          this.appendItem(sessionId, { type: "error", message: errors?.join("\n") || `回合出错（${m.subtype}）` }, { method: "result" });
          this.setStatus(sessionId, "error");
        } else {
          this.setStatus(sessionId, "idle");
        }
        this.scheduleIdle(sessionId, live);
        return;
      }
      default:
        return;
    }
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

  /** Messages of a subagent (parent_tool_use_id set) go into its child session. Its partial stream is not shown. */
  private onSubagentMessage(live: Live, parentToolUse: string, m: SDKMessage): void {
    const child = live.subs.get(parentToolUse);
    if (!child) return;
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

  private addToolCard(sessionId: Id, live: Live, toolUseId: string, name: string, input: Record<string, unknown>): void {
    const created = this.appendItem(sessionId, { type: "tool", ...describeToolUse(name, input, this.cwdOf(sessionId)), status: "running" }, { method: "tool_use", itemId: toolUseId });
    live.tools.set(toolUseId, created.id);
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
    this.updateItem(itemId, (it) =>
      it.type === "tool"
        ? {
            ...it,
            status: declined ? "declined" : isError ? "failed" : "completed",
            ...(detail ? { detail: tail(detail) } : {}),
            ...(started ? { durationMs: this.now().getTime() - started } : {}),
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

  private turnStarted(sessionId: Id, live: Live): void {
    if (!live.turn) {
      const turnId = randomUUID();
      const item = this.appendItem(sessionId, { type: "turn", turnId, state: "running", startedAt: this.now().toISOString() }, { method: "turn/start", turnId });
      live.turn = { id: turnId, itemId: item.id };
    }
    live.running = true;
    this.clearIdle(live);
    this.setStatus(sessionId, live.approvals.size ? "awaiting-approval" : "running");
  }

  /** canUseTool: show an approval card and wait for the person. */
  private askPerson(
    sessionId: Id,
    live: Live,
    toolName: string,
    toolInput: Record<string, unknown>,
    ctx: { signal: AbortSignal; toolUseID?: string; title?: string; description?: string },
  ): Promise<PermissionResult> {
    const input = toolInput;
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
      });
    });
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  /** After a Host restart no Claude process is running: turns that were in flight are over. */
  private recoverAfterRestart(): void {
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "claude") continue;
      for (const item of this.store.listItems(s.id)) {
        if (item.type === "approval" && item.state === "pending") this.updateItem(item.id, (it) => (it.type === "approval" ? { ...it, state: "resolved-elsewhere" } : it));
        if (item.type === "agent" && item.streaming) this.updateItem(item.id, (it) => (it.type === "agent" ? { ...it, streaming: false } : it));
        if (item.type === "tool" && item.status === "running") this.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "failed" } : it));
      }
      if (s.status === "running" || s.status === "awaiting-approval") {
        if (s.kind !== "sub") this.appendItem(s.id, { type: "notice", level: "warning", message: "Host 重启时这条会话的回复被中断了。发一条消息即可接着对话。" });
        this.setStatus(s.id, "idle");
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

  /** In-process SDK helpers (forkSession, getSessionMessages) read CLAUDE_CONFIG_DIR from this process. */
  private async withConfigDir<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = this.options.claudeHome;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }

  private transcript(ref: string, dir: string) {
    return this.withConfigDir(() => getSessionMessages(ref, { dir }));
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

  private hasTranscript(ref: string): boolean {
    const projects = join(this.options.claudeHome, "projects");
    if (!existsSync(projects)) return false;
    return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${ref}.jsonl`)));
  }

  private scheduleIdle(sessionId: Id, live: Live): void {
    this.clearIdle(live);
    if (live.background.size || live.approvals.size) return;
    live.idleTimer = setTimeout(() => {
      if (!live.running && !live.background.size) void this.close(sessionId);
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

/** The Claude Code executable that ships with the SDK (same version as the SDK's own processes). */
function bundledClaudeExe(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/package.json")), "claude.exe");
}

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split(/\r?\n/)[0]!.slice(0, 300);

function withoutKey(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = o;
  return rest;
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
