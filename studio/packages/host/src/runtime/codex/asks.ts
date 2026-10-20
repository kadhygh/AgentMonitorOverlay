import { codexAnswers, elicitationForm, formContent, storedAnswers, type ApprovalDecision, type Id, type QuestionReply, type SessionItem } from "@amo-studio/protocol";
import type { ServerRequest } from "./rpc-client.js";
import type { CodexServerHandle } from "./server-manager.js";
import { inputQuestions } from "./describe.js";
import { approvalKey, ELICITATION, isApprovalMethod, USER_INPUT, type CodexCore, type PendingApproval, type PendingQuestion } from "./state.js";

// What waits for the person in a Codex session (stage 16 split out of codex-runtime.ts): approvals (broadcast, first
// answer wins), request_user_input and MCP forms (question items), request_user_input_async (a card; the answer is the
// next message), and the session's status while they wait.

export class CodexAsks {
  private readonly approvals = new Map<string, PendingApproval>();
  /** question item id -> the server request waiting for its answer */
  private readonly questions = new Map<Id, PendingQuestion>();

  constructor(private readonly core: CodexCore) {}

  onServerRequest(handle: CodexServerHandle, r: ServerRequest): void {
    if (r.method === USER_INPUT || (r.method === ELICITATION && elicitationForm((r.params as { requestedSchema?: unknown }).requestedSchema))) return this.onQuestion(handle, r);
    if (!isApprovalMethod(r.method)) return;
    const params = r.params as { threadId?: string; turnId?: string; itemId?: string; command?: string | null; reason?: string | null; cwd?: string; message?: string; serverName?: string };
    const s = params.threadId ? this.core.findByThread(params.threadId) : undefined;
    if (!s) return;
    const key = approvalKey(s.id, String(r.id));
    if (this.approvals.has(key)) return; // replayed on resubscribe
    const elicitation = r.method === ELICITATION;
    const kind = elicitation ? "permissions" : r.method.includes("fileChange") || r.method === "applyPatchApproval" ? "fileChange" : r.method.includes("permissions") ? "permissions" : "command";
    // The tool row the approval is for already has a readable summary (the command without its shell wrapper, the files).
    const toolItemId = params.itemId ? this.core.sessionState(s.id).items.get(params.itemId) : undefined;
    const tool = toolItemId ? this.core.store.getItem(toolItemId) : undefined;
    const toolSummary = tool?.type === "tool" ? (kind === "command" ? tool.input : tool.summary) || undefined : undefined;
    const item = this.core.appendItem(s.id, {
      type: "approval",
      approvalId: String(r.id),
      kind,
      summary: elicitation ? (params.message ?? `MCP 服务 ${params.serverName ?? ""} 请求批准`) : (toolSummary ?? params.command ?? params.reason ?? r.method),
      ...(elicitation ? (params.serverName ? { detail: `MCP：${params.serverName}` } : {}) : params.cwd ? { detail: params.cwd } : {}),
      state: "pending",
    }, { method: r.method, ...(params.itemId ? { itemId: params.itemId } : {}), ...(params.turnId ? { turnId: params.turnId } : {}) });
    this.approvals.set(key, { kind: elicitation ? "elicitation" : "approval", sessionId: s.id, itemId: item.id, profileId: handle.profileId, requestId: r.id });
    this.core.setStatus(s.id, "awaiting-approval");
  }

  /** request_user_input, or an MCP form with fields to fill in: a question item instead of an approval. */
  private onQuestion(handle: CodexServerHandle, r: ServerRequest): void {
    const params = r.params as { threadId?: string; turnId?: string | null; itemId?: string; questions?: unknown; message?: string; serverName?: string; requestedSchema?: unknown };
    const s = params.threadId ? this.core.findByThread(params.threadId) : undefined;
    if (!s) return;
    // Replayed on resubscribe: the item already stands for it.
    if ([...this.questions.values()].some((q) => q.profileId === handle.profileId && String(q.requestId) === String(r.id))) return;
    const raw = { method: r.method, ...(params.itemId ? { itemId: params.itemId } : {}), ...(params.turnId ? { turnId: params.turnId } : {}) };
    const questions = r.method === USER_INPUT ? inputQuestions(params.questions) : [];
    const item =
      r.method === USER_INPUT
        ? this.core.appendItem(s.id, { type: "question", source: "codex-input", questions, state: "pending" }, raw)
        : this.core.appendItem(
            s.id,
            { type: "question", source: "mcp-form", message: params.message ?? "", form: elicitationForm(params.requestedSchema)!, ...(params.serverName ? { serverName: params.serverName } : {}), state: "pending" },
            raw,
          );
    this.questions.set(item.id, { kind: r.method === USER_INPUT ? "input" : "form", sessionId: s.id, itemId: item.id, profileId: handle.profileId, requestId: r.id, questions });
    this.core.setStatus(s.id, "awaiting-answer");
  }

  /** Answers a pending approval. Throws if it was already answered here or elsewhere. */
  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(approvalKey(sessionId, approvalId));
    if (!pending) throw new Error(`approval ${approvalId} is not pending`);
    const handle = await this.core.handleFor(pending.profileId);
    handle.client.respond(
      pending.requestId,
      pending.kind === "elicitation" ? { action: decision === "accept" ? "accept" : "decline", content: decision === "accept" ? {} : null, _meta: null } : { decision },
    );
    this.approvals.delete(approvalKey(sessionId, approvalId));
    this.core.updateItem(pending.itemId, (item) => (item.type === "approval" ? { ...item, state: decision === "accept" ? "accepted" : "declined" } : item));
    this.afterAnswer(sessionId);
  }

  /**
   * Answers request_user_input (answers by question id; dismissing answers none) or an MCP form (accept with the
   * values, or decline). Secret answers go to Codex only; the item keeps them masked.
   */
  async answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    const asked = this.core.store.getItem(itemId);
    if (asked?.type === "question" && asked.source === "codex-async" && asked.sessionId === sessionId) {
      // Nothing waits on Codex's side: the item records the answer, the sessions service sends it as a message.
      if (reply.action !== "answer" && reply.action !== "dismiss") throw new Error(`questions take an answer, not ${reply.action}`);
      this.core.updateItem(itemId, (it) =>
        it.type === "question" && it.state === "pending"
          ? { ...it, state: reply.action === "answer" ? "answered" : "dismissed", ...(reply.action === "answer" ? { answers: storedAnswers(it.questions ?? [], reply.answers) } : {}) }
          : it,
      );
      // Asked mid-turn (stage 13: the session waits for the person at once): the turn may still be going.
      if (this.core.sessionState(sessionId).activeTurnId) this.afterAnswer(sessionId);
      else if (reply.action === "dismiss" && this.core.store.getSession(sessionId)?.status === "awaiting-answer" && !this.openAsync(sessionId).length) this.core.setStatus(sessionId, "idle");
      return;
    }
    const pending = this.questions.get(itemId);
    if (!pending || pending.sessionId !== sessionId) throw new Error(`question ${itemId} is not pending`);
    const handle = await this.core.handleFor(pending.profileId);
    const item = this.core.store.getItem(itemId);
    if (pending.kind === "input") {
      if (reply.action !== "answer" && reply.action !== "dismiss") throw new Error(`questions take an answer, not ${reply.action}`);
      const answers = reply.action === "answer" ? reply.answers : [];
      handle.client.respond(pending.requestId, codexAnswers(pending.questions, answers));
      this.closeQuestion(pending, reply.action === "answer" ? "answered" : "dismissed", reply.action === "answer" ? { answers: storedAnswers(pending.questions, answers) } : {});
    } else {
      if (reply.action === "submit") {
        const form = item?.type === "question" ? (item.form ?? []) : [];
        const checked = formContent(form, reply.values);
        if ("error" in checked) throw new Error(checked.error);
        handle.client.respond(pending.requestId, { action: "accept", content: checked.content, _meta: null });
        this.closeQuestion(pending, "answered", { values: checked.content });
      } else if (reply.action === "dismiss") {
        handle.client.respond(pending.requestId, { action: "decline", content: null, _meta: null });
        this.closeQuestion(pending, "dismissed");
      } else throw new Error(`a form takes its values, not ${reply.action}`);
    }
    this.afterAnswer(sessionId);
  }

  /** After an answer: still waiting for another question or approval (an open async question too), or back to running. */
  afterAnswer(sessionId: Id): void {
    if ([...this.questions.values()].some((q) => q.sessionId === sessionId)) this.core.setStatus(sessionId, "awaiting-answer");
    else if ([...this.approvals.values()].some((a) => a.sessionId === sessionId)) this.core.setStatus(sessionId, "awaiting-approval");
    else if (this.core.sessionState(sessionId).activeTurnId) this.core.setStatus(sessionId, this.openAsync(sessionId).length ? "awaiting-answer" : "running");
  }

  private closeQuestion(q: PendingQuestion, state: "answered" | "dismissed" | "cancelled", patch: Partial<Extract<SessionItem, { type: "question" }>> = {}): void {
    this.questions.delete(q.itemId);
    this.core.updateItem(q.itemId, (it) => (it.type === "question" && it.state === "pending" ? { ...it, ...patch, state } : it));
  }

  /** The session's turn ended or was interrupted: its questions can no longer be answered. */
  cancelQuestionsOf(sessionId: Id): void {
    for (const q of [...this.questions.values()]) if (q.sessionId === sessionId) this.closeQuestion(q, "cancelled");
  }

  /** At start-up no request is waiting yet: questions left pending by the last Host are over (servers replay live ones). */
  cancelStale(): void {
    for (const s of this.core.store.listSessions()) {
      if (s.runtime !== "codex") continue;
      for (const item of this.core.store.findItems(s.id, "question", { state: "pending" })) {
        if (item.type === "question" && item.state === "pending" && item.source !== "codex-async") this.core.updateItem(item.id, (it) => (it.type === "question" ? { ...it, state: "cancelled" } : it));
      }
    }
  }

  /** request_user_input_async questions still open in a session. */
  openAsync(sessionId: Id): SessionItem[] {
    return this.core.store.findItems(sessionId, "question", { source: "codex-async", state: "pending" });
  }

  /** The person wrote: open async questions count as answered by that message. */
  closeAsync(sessionId: Id): void {
    for (const q of this.openAsync(sessionId)) this.core.updateItem(q.id, (it) => (it.type === "question" && it.state === "pending" ? { ...it, state: "answered" } : it));
  }

  /**
   * The connection to a server dropped (crash or restart). Answers can no longer reach pending approvals, so they are
   * closed here; if the turn is still waiting, the server replays the request after resubscribing.
   */
  onConnectionLost(profileId: Id): void {
    for (const [key, a] of this.approvals) {
      if (a.profileId !== profileId) continue;
      this.approvals.delete(key);
      this.core.updateItem(a.itemId, (item) => (item.type === "approval" && item.state === "pending" ? { ...item, state: "resolved-elsewhere" } : item));
    }
    for (const q of [...this.questions.values()]) if (q.profileId === profileId) this.closeQuestion(q, "cancelled");
  }

  /** serverRequest/resolved: answered elsewhere (an attached terminal), or no longer wanted. */
  onResolved(profileId: Id, requestId: string): void {
    for (const [key, a] of this.approvals) {
      if (a.profileId !== profileId || String(a.requestId) !== requestId) continue;
      this.approvals.delete(key);
      this.core.updateItem(a.itemId, (item) => (item.type === "approval" && item.state === "pending" ? { ...item, state: "resolved-elsewhere" } : item));
      if (this.core.sessionState(a.sessionId).activeTurnId) this.afterAnswer(a.sessionId);
    }
    for (const q of [...this.questions.values()]) {
      if (q.profileId !== profileId || String(q.requestId) !== requestId) continue;
      // Answered in an attached terminal: what it answered is not known here.
      this.closeQuestion(q, "answered");
      this.afterAnswer(q.sessionId);
    }
  }

  pendingApprovals(sessionId: Id): string[] {
    return [...this.approvals.values()].filter((a) => a.sessionId === sessionId).map((a) => String(a.requestId));
  }
}
