import { asyncPrompts, type Id, type Session, type TurnRetry, type TurnState } from "@amo-studio/protocol";
import { messageImage } from "../items.js";
import type { ServerNotification } from "./rpc-client.js";
import type { CodexServerHandle } from "./server-manager.js";
import type { CodexAsks } from "./asks.js";
import { codexRetry, firstLineOf, type CodexRateWindow, type CodexTurnError } from "./account.js";
import { addUsage, describePlan, describeReview, describeTool, type CodexItem, type CodexReview } from "./describe.js";
import { turnKey, type CodexCore, type ThreadLike } from "./state.js";

// What a Codex app-server's notifications become in Studio (stage 16 split out of codex-runtime.ts): turns, items
// (messages, reasoning, tools, compaction, reviews, subagents), token usage, retries and notices. Approvals and
// questions are CodexAsks'.

export class CodexEvents {
  /** Notices a server sent for no thread (config warnings, deprecations, MCP start-up): shown in the next turn. */
  private readonly serverNotices = new Map<Id, Array<{ level: "info" | "warning"; message: string; key: string }>>();

  constructor(
    private readonly core: CodexCore,
    private readonly asks: CodexAsks,
    /** account/rateLimits/updated: the profile's quota as the server last told it. */
    private readonly onRateLimits: (profileId: Id, limits: { primary: CodexRateWindow; secondary: CodexRateWindow }) => void,
  ) {}

  /** A notice row; the same key again in this turn updates that row (with a count) instead of adding another. */
  notice(sessionId: Id, level: "info" | "warning", message: string, key: string, turnId?: string): void {
    const st = this.core.sessionState(sessionId);
    const known = st.notices.get(key);
    const current = known ? this.core.store.getItem(known) : undefined;
    if (current?.type === "notice") {
      this.core.updateItem(current.id, (it) => (it.type === "notice" ? { ...it, level, message, count: (it.count ?? 1) + 1 } : it));
      return;
    }
    st.notices.set(key, this.core.appendItem(sessionId, { type: "notice", level, message, key }, { method: "notice", ...(turnId ? { turnId } : {}) }).id);
  }

  /** A notice for no thread: into the profile's sessions that are working now, or the next one that starts a turn. */
  private serverNotice(profileId: Id, level: "info" | "warning", message: string, key: string): void {
    const running = this.core.store.listSessions().filter((s) => s.profileId === profileId && s.runtime === "codex" && this.core.knownState(s.id)?.activeTurnId);
    if (running.length) {
      for (const s of running) this.notice(s.id, level, message, key, this.core.knownState(s.id)!.activeTurnId!);
      return;
    }
    const queued = this.serverNotices.get(profileId) ?? [];
    if (!queued.some((n) => n.key === key)) queued.push({ level, message, key });
    this.serverNotices.set(profileId, queued);
  }

  private setRetry(sessionId: Id, turnId: string, retry: TurnRetry | null): void {
    const st = this.core.sessionState(sessionId);
    if (!retry && st.retrying !== turnId) return;
    const id = this.turnItemId(sessionId, turnId);
    if (!id) return;
    st.retrying = retry ? turnId : null;
    this.core.updateItem(id, (it) => {
      if (it.type !== "turn") return it;
      if (retry) return { ...it, retry };
      if (!it.retry) return it;
      const { retry: _gone, ...rest } = it;
      return rest;
    });
  }

  /** The context the session had before compacting: what its latest turn left. */
  private lastContext(sessionId: Id): number | undefined {
    const last = this.core.store.findItems(sessionId, "turn", {}, { newest: true }).find((i) => i.type === "turn" && i.usage?.context);
    return last?.type === "turn" ? last.usage?.context : undefined;
  }

  handlerFailed(method: string, threadId: string | undefined, err: unknown): void {
    this.core.log(`failed to handle ${method}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const s = threadId ? this.core.findByThread(threadId) : undefined;
    if (s) this.notice(s.id, "warning", `Studio 处理 Codex 的一条消息（${method}）时出错，这条可能没显示出来：${firstLineOf(err instanceof Error ? err.message : String(err))}。详情在 host.log。`, `handler-error:${method}`);
  }

  onNotification(handle: CodexServerHandle, n: ServerNotification): void {
    switch (n.method) {
      case "thread/started":
        return this.onThreadStarted(handle, n.params.thread);
      case "account/rateLimits/updated":
        return this.onRateLimits(handle.profileId, n.params.rateLimits);
      case "thread/name/updated": {
        // Renamed here or in an attached TUI: the session follows its thread's name.
        const s = this.core.findByThread(n.params.threadId);
        const name = n.params.threadName?.trim();
        if (s && name && name !== s.title) this.core.updateSession(s.id, { title: name });
        return;
      }
      case "turn/started": {
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.core.sessionState(s.id);
        const turnId = turnKey(st, n.params.turn as { id: string; rootTurnId?: string | null });
        st.activeTurnId = turnId;
        st.notices.clear();
        st.callFirstAt = null;
        this.openTurn(s.id, turnId, n.params.turn.startedAt);
        this.core.setStatus(s.id, "running");
        const queued = this.serverNotices.get(handle.profileId);
        if (queued?.length) {
          this.serverNotices.delete(handle.profileId);
          for (const q of queued) this.notice(s.id, q.level, q.message, q.key, turnId);
        }
        return;
      }
      case "turn/completed": {
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.core.sessionState(s.id);
        const turnId = turnKey(st, n.params.turn as { id: string; rootTurnId?: string | null });
        if (st.activeTurnId === turnId || st.activeTurnId === n.params.turn.id) st.activeTurnId = null;
        this.setRetry(s.id, turnId, null);
        st.reviewTurns.delete(turnId);
        const turn = { ...(n.params.turn as { id: string; status: string; error?: { message: string } | null; startedAt?: number | null; completedAt?: number | null }), id: turnId };
        this.asks.cancelQuestionsOf(s.id);
        this.closeTurn(s.id, turn);
        if (turn.status === "failed") {
          this.core.appendItem(s.id, { type: "error", message: turn.error?.message ?? "turn failed" }, { method: n.method, turnId });
          this.core.setStatus(s.id, "error");
        } else if (s.kind !== "sub" && this.asks.openAsync(s.id).length) {
          this.core.setStatus(s.id, "awaiting-answer");
        } else {
          this.core.setStatus(s.id, s.kind !== "sub" ? "idle" : turn.status === "interrupted" ? "interrupted" : "completed");
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const type = (n.params.item as { type?: string }).type;
        if (n.method === "item/started" && (type === "reasoning" || type === "agentMessage")) this.callOutput(n.params.threadId);
        return this.onItem(n.method, n.params.threadId, n.params.turnId, n.params.item as unknown as CodexItem);
      }
      case "item/agentMessage/delta": {
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.core.sessionState(s.id);
        this.callOutput(n.params.threadId);
        // A review's own messages are its raw findings; exitedReviewMode brings the review as written for people.
        if (st.reviewTurns.has(n.params.turnId)) return;
        const itemId = this.ensureAgentItem(s.id, n.params.itemId, n.params.turnId);
        st.text.set(n.params.itemId, (st.text.get(n.params.itemId) ?? "") + n.params.delta);
        this.core.emitTransient({ type: "item.delta", sessionId: s.id, itemId, append: n.params.delta });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryPartAdded": {
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.core.sessionState(s.id);
        this.callOutput(n.params.threadId);
        const channel = n.method === "item/reasoning/textDelta" ? "content" : "summary";
        const itemId = this.ensureReasoningItem(s.id, n.params.itemId, n.params.turnId);
        const r = st.reasoning.get(n.params.itemId)!;
        // Show one stream: whichever arrives first (raw thinking from DeepSeek-style models, or OpenAI's summaries).
        if (r.channel && r.channel !== channel) return;
        r.channel = channel;
        const sofar = st.text.get(n.params.itemId) ?? "";
        const append = n.method === "item/reasoning/summaryPartAdded" ? (sofar ? "\n\n" : "") : n.params.delta;
        if (!append) return;
        st.text.set(n.params.itemId, sofar + append);
        this.core.emitTransient({ type: "item.delta", sessionId: s.id, itemId, append });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        const itemId = this.core.sessionState(s.id).items.get(n.params.itemId);
        if (itemId && n.params.delta) this.core.emitTransient({ type: "item.delta", sessionId: s.id, itemId, append: n.params.delta });
        return;
      }
      case "thread/tokenUsage/updated": {
        const s = this.core.findByThread(n.params.threadId);
        const id = s && this.turnItemId(s.id, n.params.turnId);
        if (!id) return;
        const { last, modelContextWindow } = n.params.tokenUsage;
        const st = this.core.sessionState(s.id);
        const firstAt = st.callFirstAt;
        st.callFirstAt = null;
        const ms = firstAt === null ? 0 : Date.now() - firstAt;
        this.core.updateItem(id, (it) =>
          it.type === "turn"
            ? {
                ...it,
                usage: addUsage(it.usage, last, modelContextWindow),
                ...(firstAt !== null && last.outputTokens > 0 ? { decode: { ms: (it.decode?.ms ?? 0) + ms, tokens: (it.decode?.tokens ?? 0) + last.outputTokens } } : {}),
              }
            : it,
        );
        return;
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        // "Approve for me": Codex's review agent decides an approval request. Shown as a row in the work.
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.core.sessionState(s.id);
        const key = `review:${n.params.reviewId}`;
        const row = describeReview(n.params as unknown as CodexReview, this.core.store.getWorkspace(s.workspaceId)?.path);
        const existing = st.items.get(key);
        if (existing) this.core.updateItem(existing, (it) => (it.type === "tool" ? { ...it, ...row } : it));
        else st.items.set(key, this.core.appendItem(s.id, { type: "tool", ...row }, { method: n.method, turnId: n.params.turnId, itemId: n.params.reviewId }).id);
        return;
      }
      case "turn/plan/updated": {
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        const st = this.core.sessionState(s.id);
        const key = `plan:${n.params.turnId}`;
        const plan = describePlan(n.params.plan, n.params.explanation);
        const existing = st.items.get(key);
        if (existing) this.core.updateItem(existing, (it) => (it.type === "tool" ? { ...it, ...plan } : it));
        else st.items.set(key, this.core.appendItem(s.id, { type: "tool", ...plan }, { method: n.method, turnId: n.params.turnId }).id);
        return;
      }
      case "serverRequest/resolved":
        return this.asks.onResolved(handle.profileId, String(n.params.requestId));
      case "error": {
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        // A retry shows in the running status line (and goes away when the model answers), not as a row.
        if (n.params.willRetry) this.setRetry(s.id, n.params.turnId, codexRetry(n.params.error as CodexTurnError));
        else this.core.appendItem(s.id, { type: "error", message: n.params.error.message }, { method: n.method, turnId: n.params.turnId });
        return;
      }
      case "thread/compacted": {
        // Deprecated in favour of the contextCompaction item (Codex 0.162 sends only the item); kept for older servers.
        const s = this.core.findByThread(n.params.threadId);
        if (!s) return;
        if (this.core.store.findItems(s.id, "compaction", { "raw.turnId": n.params.turnId }, { limit: 1 }).length) return;
        const before = this.lastContext(s.id);
        this.core.appendItem(s.id, { type: "compaction", state: "completed", ...(before ? { beforeTokens: before } : {}) }, { method: n.method, turnId: n.params.turnId });
        return;
      }
      case "model/rerouted": {
        const s = this.core.findByThread(n.params.threadId);
        const why = n.params.reason === "highRiskCyberActivity" ? "（涉及高风险网络安全内容）" : "";
        if (s) this.notice(s.id, "warning", `这一轮改用了 ${n.params.toModel}，不是 ${n.params.fromModel}${why}。`, "rerouted", n.params.turnId);
        return;
      }
      case "warning":
      case "guardianWarning": {
        const p = n.params as { threadId: string | null; message: string };
        const s = p.threadId ? this.core.findByThread(p.threadId) : undefined;
        const level = n.method === "guardianWarning" ? "warning" : "info";
        if (s) this.notice(s.id, level, p.message, `${n.method}:${p.message}`, this.core.knownState(s.id)?.activeTurnId ?? undefined);
        else if (!p.threadId) this.serverNotice(handle.profileId, level, p.message, `${n.method}:${p.message}`);
        return;
      }
      case "configWarning": {
        const p = n.params as { summary: string; details: string | null; path?: string };
        const message = `Codex 配置有问题：${p.summary}${p.details ? `（${p.details}）` : ""}${p.path ? ` · ${p.path}` : ""}`;
        this.serverNotice(handle.profileId, "warning", message, `${n.method}:${p.summary}`);
        return;
      }
      case "deprecationNotice": {
        // About how Studio calls app-server (e.g. full-history thread/resume in 0.162), not about the person's work.
        const p = n.params as { summary: string; details: string | null };
        this.core.log(`codex deprecation (${handle.profileId}): ${p.summary}${p.details ? ` (${p.details})` : ""}`);
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const p = n.params as { threadId: string | null; name: string; status: string; error: string | null; failureReason: string | null };
        if (p.status !== "failed") return;
        const message = `MCP 服务 ${p.name} 没能启动${p.failureReason === "reauthenticationRequired" ? "：需要重新登录" : p.error ? `：${firstLineOf(p.error)}` : "。"}`;
        const s = p.threadId ? this.core.findByThread(p.threadId) : undefined;
        if (s) this.notice(s.id, "warning", message, `mcp:${p.name}`, this.core.knownState(s.id)?.activeTurnId ?? undefined);
        else this.serverNotice(handle.profileId, "warning", message, `mcp:${p.name}`);
        return;
      }
      case "hook/completed": {
        // Hooks only show when they fail or block.
        const p = n.params as { threadId: string; turnId: string | null; run: { eventName: string; status: string; statusMessage: string | null; sourcePath: string; entries: Array<{ text: string }> } };
        if (p.run.status !== "failed" && p.run.status !== "blocked") return;
        const s = this.core.findByThread(p.threadId);
        const detail = p.run.statusMessage || p.run.entries.map((e) => e.text).find(Boolean) || "";
        const name = p.run.sourcePath.split(/[\\/]/).at(-1) || p.run.eventName;
        if (s) this.notice(s.id, "warning", `Hook ${name}（${p.run.eventName}）${p.run.status === "blocked" ? "拦截了这一步" : "运行失败"}${detail ? `：${firstLineOf(detail)}` : "。"}`, `hook:${name}`, p.turnId ?? undefined);
        return;
      }
      case "item/mcpToolCall/progress":
      case "item/commandExecution/terminalInteraction": {
        const p = n.params as { threadId: string; itemId: string; message?: string; stdin?: string };
        const s = this.core.findByThread(p.threadId);
        const itemId = s ? this.core.sessionState(s.id).items.get(p.itemId) : undefined;
        // Input the agent typed into a running command; an empty write only reads its output.
        const progress = n.method === "item/mcpToolCall/progress" ? p.message?.trim() : p.stdin?.trim() ? `已向命令输入：${p.stdin.trim().slice(0, 200)}` : "";
        if (itemId && progress) this.core.updateItem(itemId, (it) => (it.type === "tool" ? { ...it, progress } : it));
        return;
      }
      default:
        // Not shown: turn/diff/updated (the turn's changed files come from its edit items), item/fileChange/outputDelta
        // (no longer sent), process/* and command/exec/* (only for processes a client starts), realtime, account
        // and login, fuzzy file search, thread metadata.
        return;
    }
  }

  private onThreadStarted(handle: CodexServerHandle, thread: ThreadLike): void {
    if (this.core.findByThread(thread.id)) return;
    if (thread.forkedFromId) {
      const parent = this.core.findByThread(thread.forkedFromId);
      if (parent) this.adoptThread(thread, parent, "fork", handle.profileId);
    } else if (thread.parentThreadId) {
      const parent = this.core.findByThread(thread.parentThreadId);
      if (parent) this.adoptThread(thread, parent, "sub", handle.profileId);
    }
  }

  /** Records a fork or subagent thread as a child session, warns on provider drift, and follows its events. */
  adoptThread(thread: ThreadLike, parent: Session, kind: "fork" | "sub", profileId: Id, title?: string): Session {
    const existing = this.core.findByThread(thread.id);
    if (existing) return existing;
    const session = this.core.createSession({
      taskId: parent.taskId,
      topicId: parent.topicId,
      parentId: parent.id,
      kind,
      profileId,
      workspaceId: parent.workspaceId,
      title: title ?? (kind === "sub" ? "子 agent" : `${parent.title || "会话"} · 分支`),
      runtimeRef: thread.id,
      // Forks and subagents start with the parent's model, effort and permissions.
      options: parent.options,
    });
    const expected = this.core.profile(parent.profileId).provider;
    if (expected && thread.modelProvider && thread.modelProvider !== expected) {
      this.core.appendItem(session.id, {
        type: "notice",
        level: "warning",
        message: `这个${kind === "fork" ? "分支" : "子 agent"}用的模型提供方是 ${thread.modelProvider}，与父会话的 ${expected} 不一致。`,
      });
    }
    if (kind === "fork") {
      void this.core.handleFor(profileId)
        .then((h) => h.client.request("thread/resume", { threadId: thread.id } as never))
        .catch((err: unknown) => this.core.log(`could not follow fork ${thread.id}: ${String(err)}`));
    }
    return session;
  }

  private onItem(method: "item/started" | "item/completed", threadId: string, turnId: string, item: CodexItem): void {
    const s = this.core.findByThread(threadId);
    if (!s) return;
    const st = this.core.sessionState(s.id);
    const raw = { method, itemId: item.id, turnId };
    const done = method === "item/completed";
    const review = st.reviewTurns.has(turnId);
    // The model answered: a retry it was making is over.
    if (item.type !== "userMessage" && st.retrying === turnId) this.setRetry(s.id, turnId, null);
    switch (item.type) {
      case "userMessage": {
        // In review mode the message is Codex's own review prompt (the person's /code-review opened the turn).
        if (!done || review) return;
        const content = (item.content ?? []) as Array<{ type?: string; text?: unknown; path?: unknown }>;
        const text = content.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : "")).join("");
        const images = content.filter((c) => c?.type === "localImage" && typeof c.path === "string").map((c) => messageImage(c.path as string));
        this.core.appendItem(s.id, { type: "user", text, ...(images.length ? { images } : {}) }, raw);
        return;
      }
      case "reasoning": {
        const itemId = this.ensureReasoningItem(s.id, item.id, turnId);
        if (done) {
          const join = (parts: unknown[] | undefined) => (parts ?? []).filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n\n");
          const text = join(item.content) || join(item.summary) || (st.text.get(item.id) ?? "");
          const startedAt = st.reasoning.get(item.id)?.startedAt;
          this.core.updateItem(itemId, (it) =>
            it.type === "reasoning" ? { ...it, text, streaming: false, ...(startedAt ? { durationMs: this.core.now().getTime() - startedAt } : {}) } : it,
          );
          st.text.delete(item.id);
          st.reasoning.delete(item.id);
        }
        return;
      }
      case "agentMessage": {
        if (review) return;
        // request_user_input_async: the model asks and carries on; the questions become a card, the answer a message.
        const asked = item.delivery === "async" ? asyncPrompts(item.questions) : [];
        if (asked.length) {
          if (!st.items.has(item.id)) {
            st.items.set(item.id, this.core.appendItem(s.id, { type: "question", source: "codex-async", state: "pending", questions: asked }, raw).id);
            // The person is wanted now, not when the turn ends (stage 13: Focus and the board showed it seconds late).
            // A pending approval stays first: it blocks the turn.
            if (s.kind !== "sub" && s.status === "running") this.core.setStatus(s.id, "awaiting-answer");
          }
          return;
        }
        const itemId = this.ensureAgentItem(s.id, item.id, turnId);
        if (done) {
          this.core.updateItem(itemId, (it) => (it.type === "agent" ? { ...it, markdown: item.text ?? st.text.get(item.id) ?? "", streaming: false } : it));
          st.text.delete(item.id);
        }
        return;
      }
      case "contextCompaction": {
        const existing = st.items.get(item.id);
        if (!existing) {
          const before = this.lastContext(s.id);
          st.items.set(item.id, this.core.appendItem(s.id, { type: "compaction", state: done ? "completed" : "running", ...(before ? { beforeTokens: before } : {}) }, raw).id);
        } else if (done) {
          this.core.updateItem(existing, (it) => (it.type === "compaction" ? { ...it, state: "completed" } : it));
        }
        return;
      }
      case "enteredReviewMode": {
        st.reviewTurns.add(turnId);
        if (!done || st.items.has(item.id)) return;
        this.openTurn(s.id, turnId, null);
        const what = item.review && item.review !== "current changes" ? item.review : "当前未提交的改动";
        st.items.set(item.id, this.core.appendItem(s.id, { type: "notice", level: "info", message: `Codex 开始审查：${what}` }, raw).id);
        return;
      }
      case "exitedReviewMode": {
        // The review as written for people: the turn's answer.
        if (!done || st.items.has(item.id)) return;
        st.items.set(item.id, this.core.appendItem(s.id, { type: "agent", markdown: item.review?.trim() || "（审查没有给出结论）", streaming: false }, raw).id);
        return;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "webSearch":
      case "imageView":
      case "imageGeneration":
      case "hookPrompt":
      case "collabAgentToolCall":
      case "sleep":
      case "functionCallOutput": {
        const tool = describeTool(item, this.core.store.getWorkspace(s.workspaceId)?.path, done);
        const existing = st.items.get(item.id);
        if (!existing) {
          const created = this.core.appendItem(s.id, { type: "tool", ...tool }, raw);
          st.items.set(item.id, created.id);
        } else {
          this.core.updateItem(existing, (it) => (it.type === "tool" ? { ...it, ...tool } : it));
        }
        return;
      }
      case "subAgentActivity": {
        if (!item.agentThreadId) return;
        // Codex 0.161 announces subagents only through this item (no thread/started), so this is where the child
        // session is created; its own turn events follow on the same connection.
        const name = item.agentPath?.split("/").filter(Boolean).at(-1) ?? "子 agent";
        const child = this.core.findByThread(item.agentThreadId) ?? this.adoptThread({ id: item.agentThreadId, parentThreadId: threadId }, s, "sub", s.profileId, name);
        if (item.kind !== "started" || st.items.has(`sub:${item.agentThreadId}`)) return;
        const created = this.core.appendItem(s.id, { type: "subagent", childSessionId: child.id, summary: item.agentPath ?? name }, raw);
        st.items.set(`sub:${item.agentThreadId}`, created.id);
        return;
      }
      default:
        // userMessage aside, the remaining types (plan text, reasoning) are handled above or by their own events.
        return;
    }
  }

  private ensureAgentItem(sessionId: Id, codexItemId: string, turnId: string): Id {
    const st = this.core.sessionState(sessionId);
    const known = st.items.get(codexItemId);
    if (known) return known;
    const created = this.core.appendItem(sessionId, { type: "agent", markdown: "", streaming: true }, { method: "item/started", itemId: codexItemId, turnId });
    st.items.set(codexItemId, created.id);
    return created.id;
  }

  private ensureReasoningItem(sessionId: Id, codexItemId: string, turnId: string): Id {
    const st = this.core.sessionState(sessionId);
    if (!st.reasoning.has(codexItemId)) st.reasoning.set(codexItemId, { startedAt: this.core.now().getTime() });
    const known = st.items.get(codexItemId);
    if (known) return known;
    const created = this.core.appendItem(sessionId, { type: "reasoning", text: "", streaming: true }, { method: "item/started", itemId: codexItemId, turnId });
    st.items.set(codexItemId, created.id);
    return created.id;
  }

  /** The turn item of a Codex turn: known in memory, or (after a Host restart) found among the session's items. */
  private turnItemId(sessionId: Id, turnId: string): Id | undefined {
    const st = this.core.sessionState(sessionId);
    const known = st.turns.get(turnId);
    if (known) return known;
    const [found] = this.core.store.findItems(sessionId, "turn", { turnId }, { limit: 1 });
    if (found) st.turns.set(turnId, found.id);
    return found?.id;
  }

  private openTurn(sessionId: Id, turnId: string, startedAt: number | null | undefined): Id {
    const existing = this.turnItemId(sessionId, turnId);
    if (existing) return existing;
    const started = startedAt ? new Date(startedAt * 1000) : this.core.now();
    const item = this.core.appendItem(sessionId, { type: "turn", turnId, state: "running", startedAt: started.toISOString() }, { method: "turn/started", turnId });
    this.core.sessionState(sessionId).turns.set(turnId, item.id);
    return item.id;
  }

  private closeTurn(sessionId: Id, turn: { id: string; status: string; error?: { message: string } | null; startedAt?: number | null; completedAt?: number | null }): void {
    const id = this.openTurn(sessionId, turn.id, turn.startedAt);
    const state: TurnState = turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : "completed";
    const endedAt = (turn.completedAt ? new Date(turn.completedAt * 1000) : this.core.now()).toISOString();
    this.core.updateItem(id, (it) => (it.type === "turn" ? { ...it, state, endedAt, ...(turn.error?.message ? { error: turn.error.message } : {}) } : it));
    // Tools still running when the turn ends were cut off; streaming thinking stops with the turn.
    const from = (this.core.store.getItem(id)?.seq ?? 1) - 1;
    for (const item of this.core.store.listItems(sessionId, from)) {
      if (item.raw?.turnId !== turn.id) continue;
      if (item.type === "tool" && item.status === "running") this.core.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "declined" } : it));
      if (item.type === "reasoning" && item.streaming) this.core.updateItem(item.id, (it) => (it.type === "reasoning" ? { ...it, streaming: false } : it));
    }
  }

  /** The model call streaming in this thread gave output: its first one starts its generation time. */
  private callOutput(threadId: string): void {
    const s = this.core.findByThread(threadId);
    if (!s) return;
    const st = this.core.sessionState(s.id);
    if (st.callFirstAt === null) st.callFirstAt = Date.now();
  }
}
