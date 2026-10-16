import { randomUUID } from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { claudeAnswers, storedAnswers, type ApprovalDecision, type ApprovalKind, type Id, type QuestionPrompt, type QuestionReply, type SessionItem } from "@amo-studio/protocol";
import { CLAUDE_DEFAULT_PERMISSION, claudePermissionMode } from "../choices.js";
import type { ClaudeCore } from "./core.js";
import { waitingStatus, type Live, type PendingQuestion } from "./live.js";
import { askedQuestions } from "./tool-use.js";

// What waits for the person in canUseTool (stage 16 split out of claude-runtime.ts): approval cards, and AskUserQuestion
// and ExitPlanMode as question items; their answers; and the session's status while they wait.

export const DECLINED = "The person declined this in AMO Studio.";
const QUESTIONS_DISMISSED =
  "The user closed these questions in AMO Studio without answering them. Do not ask them again right away: carry on with what you know, stating any assumptions you make, or stop and say what you need from the user.";
const PLAN_DISMISSED = "The user closed the plan review in AMO Studio without approving the plan. Stay in plan mode: do not edit files or run commands; wait for the user's next message.";
const planRevision = (feedback: string) =>
  `The user reviewed the plan in AMO Studio and wants changes before you start:\n\n${feedback}\n\nRevise the plan accordingly and present it again with ExitPlanMode. Stay in plan mode until the user approves.`;

export class ClaudeAsks {
  constructor(private readonly core: ClaudeCore) {}

  /** canUseTool: show an approval card (for questions and plan reviews, a question) and wait for the person. */
  askPerson(
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
    const item = this.core.appendItem(
      sessionId,
      { type: "approval", approvalId, kind, summary, ...(detail ? { detail } : {}), state: "pending" },
      { method: "canUseTool", ...(ctx.toolUseID ? { itemId: ctx.toolUseID } : {}) },
    );
    this.core.setStatus(sessionId, "awaiting-approval");
    return new Promise<PermissionResult>((resolve) => {
      live.approvals.set(approvalId, { itemId: item.id, input, toolUseId: ctx.toolUseID ?? null, resolve });
      ctx.signal.addEventListener("abort", () => {
        if (!live.approvals.delete(approvalId)) return;
        this.core.updateItem(item.id, (it) => (it.type === "approval" && it.state === "pending" ? { ...it, state: "resolved-elsewhere" } : it));
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
    const item = this.core.appendItem(sessionId, { type: "question", ...fields, state: "pending" }, { method: "canUseTool", ...(ctx.toolUseID ? { itemId: ctx.toolUseID } : {}) });
    return new Promise<PermissionResult>((resolve) => {
      live.questions.set(item.id, { ...pending, itemId: item.id, resolve });
      this.core.setStatus(sessionId, "awaiting-answer");
      ctx.signal.addEventListener("abort", () => {
        if (!live.questions.delete(item.id)) return;
        this.cancelQuestion(item.id);
        resolve({ behavior: "deny", message: "aborted" });
        this.afterWait(sessionId, live);
      });
    });
  }

  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): void {
    const live = this.core.live.get(sessionId);
    const pending = live?.approvals.get(approvalId);
    if (!live || !pending) throw new Error(`approval ${approvalId} is not pending`);
    live.approvals.delete(approvalId);
    if (decision === "decline" && pending.toolUseId) {
      live.declinedTools.add(pending.toolUseId);
      live.declinedByPerson.add(pending.toolUseId);
    }
    pending.resolve(decision === "accept" ? { behavior: "allow", updatedInput: pending.input } : { behavior: "deny", message: DECLINED });
    this.core.updateItem(pending.itemId, (item) => (item.type === "approval" ? { ...item, state: decision === "accept" ? "accepted" : "declined" } : item));
    this.afterWait(sessionId, live);
  }

  /**
   * Answers AskUserQuestion (allowed with the answers filled in, as Claude Code's own dialog does) or the plan review
   * of ExitPlanMode (approve: allowed, and the session leaves plan mode for 每次询问; revise: denied with the person's
   * feedback). Dismissing denies with a message that says so, and the model carries on.
   */
  async answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    const live = this.core.live.get(sessionId);
    const pending = live?.questions.get(itemId);
    if (!live || !pending) throw new Error(`question ${itemId} is not pending`);
    const settle = (patch: Partial<Extract<SessionItem, { type: "question" }>>) =>
      this.core.updateItem(itemId, (it) => (it.type === "question" && it.state === "pending" ? { ...it, ...patch } : it));
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
      const session = this.core.updateSession(sessionId, { options: { ...this.core.requireSession(sessionId).options, permission: CLAUDE_DEFAULT_PERMISSION } });
      await live.q.setPermissionMode(claudePermissionMode(session.options.permission)).catch((err: unknown) => this.core.log(`could not leave plan mode in ${sessionId}: ${String(err)}`));
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

  /** An interrupt declines whatever waits for the person (the CLI stops the turn). */
  declineAll(live: Live): void {
    for (const [key, a] of live.approvals) {
      live.approvals.delete(key);
      a.resolve({ behavior: "deny", message: DECLINED, interrupt: true });
      this.core.updateItem(a.itemId, (item) => (item.type === "approval" && item.state === "pending" ? { ...item, state: "declined" } : item));
    }
    for (const [key, question] of live.questions) {
      live.questions.delete(key);
      question.resolve({ behavior: "deny", message: DECLINED, interrupt: true });
      this.cancelQuestion(question.itemId);
    }
  }

  /** The process ended: what still waited can no longer be answered here. */
  dropAll(live: Live): void {
    for (const a of live.approvals.values()) this.core.updateItem(a.itemId, (it) => (it.type === "approval" && it.state === "pending" ? { ...it, state: "resolved-elsewhere" } : it));
    for (const question of live.questions.values()) this.cancelQuestion(question.itemId);
    live.questions.clear();
  }

  /**
   * An approval or a question is settled: the session waits for the next one, or goes on. Between turns (an agent in the
   * background asked, 2026-10-16) there is no turn to go on with: it is idle again, not left 等你批准 for Focus.
   */
  private afterWait(sessionId: Id, live: Live): void {
    if (live.running || live.approvals.size || live.questions.size) this.core.setStatus(sessionId, waitingStatus(live));
    else {
      const status = this.core.store.getSession(sessionId)?.status;
      if (status === "awaiting-approval" || status === "awaiting-answer") this.core.setStatus(sessionId, "idle");
    }
  }

  cancelQuestion(itemId: Id): void {
    this.core.updateItem(itemId, (it) => (it.type === "question" && it.state === "pending" ? { ...it, state: "cancelled" } : it));
  }
}
