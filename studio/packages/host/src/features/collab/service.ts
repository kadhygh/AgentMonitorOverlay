import type { Id, TaskNote, MailMessage, MailRecipient, DecisionRequest, ChecklistItem } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError, boundedText, MAX_NOTE_CHARS, MAX_QUESTION_CHARS, MAX_OPTION_CHARS } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Collaboration (stage 5): notes and handoffs, mail, decision requests, checklists. */
export class CollabFeature extends Feature {
  taskNotes(taskId: Id): TaskNote[] {
    this.requireTask(taskId);
    return this.store.listTaskNotes(taskId);
  }

  /** A note on a task, by the person (`sessionId` null) or by a session of that task. */
  addTaskNote(taskId: Id, input: { text?: unknown; kind?: TaskNote["kind"] }, sessionId: Id | null = null): TaskNote {
    this.requireTask(taskId);
    const text = boundedText(input?.text, "text", MAX_NOTE_CHARS);
    if (sessionId && this.requireSession(sessionId).taskId !== taskId) throw new HostError("bad_request", "a session can only write to its own task (topic sessions have none; leave mail instead)");
    const note: TaskNote = { id: newId("note"), taskId, sessionId, kind: input.kind === "handoff" ? "handoff" : "progress", text, createdAt: new Date().toISOString() };
    this.store.addTaskNote(note);
    this.publish({ type: "task.note.added", note });
    return note;
  }

  /**
   * Mail by recipient; `forTaskId` / `forTopicId`: everything left for that task or topic or for any of its own
   * sessions.
   */
  mail(filter: { sessionId?: Id; taskId?: Id; topicId?: Id; forTaskId?: Id; forTopicId?: Id; states?: MailMessage["state"][] } = {}): MailMessage[] {
    const { forTaskId, forTopicId, ...rest } = filter;
    if (!forTaskId && !forTopicId) return this.store.listMail(rest);
    const sessions = new Set(this.store.listSessions(forTaskId ? { taskId: forTaskId } : { topicId: forTopicId! }).map((s) => s.id));
    return this.store
      .listMail(rest.states ? { states: rest.states } : {})
      .filter((m) => (m.to.kind === "session" ? sessions.has(m.to.sessionId) : m.to.kind === "task" ? m.to.taskId === forTaskId : m.to.topicId === forTopicId));
  }

  /** Leaves a message for a session or a task. `fromSessionId` null: from the person. */
  sendMail(fromSessionId: Id | null, to: unknown, textIn: unknown): MailMessage {
    const text = boundedText(textIn, "text", MAX_NOTE_CHARS);
    const recipient = this.validRecipient(to);
    const from = fromSessionId ? this.requireSession(fromSessionId) : null;
    if (from && recipient.kind === "session" && recipient.sessionId === from.id) throw new HostError("bad_request", "a session cannot leave mail for itself");
    const mail: MailMessage = {
      id: newId("mail"),
      fromSessionId: from?.id ?? null,
      fromTaskId: from?.taskId ?? null,
      fromTopicId: from?.topicId ?? null,
      to: recipient,
      text,
      state: "unread",
      createdAt: new Date().toISOString(),
      handledAt: null,
    };
    this.store.putMail(mail);
    this.publish({ type: "mail.upserted", mail });
    return mail;
  }

  updateMail(id: Id, state: unknown): MailMessage {
    if (state !== "read" && state !== "dismissed") throw new HostError("bad_request", "state must be read or dismissed");
    return this.setMailState(this.requireMail(id), state);
  }

  /** The person puts a message into a conversation; it goes in as a user message, marked as coming from AMO mail. */
  async forwardMail(id: Id, input: { sessionId?: unknown } = {}): Promise<MailMessage> {
    const mail = this.requireMail(id);
    if (mail.state === "forwarded") throw new HostError("conflict", "this message was already forwarded");
    const target = mail.to.kind === "session" ? mail.to.sessionId : typeof input.sessionId === "string" ? input.sessionId : null;
    if (!target) throw new HostError("bad_request", "name the session to forward this message to");
    const session = this.requireSession(target);
    if (mail.to.kind === "task" && session.taskId !== mail.to.taskId) throw new HostError("bad_request", "that session is not part of the task the message was left for");
    if (mail.to.kind === "topic" && session.topicId !== mail.to.topicId) throw new HostError("bad_request", "that session is not one of the topic's own sessions");
    await this.f.sessions.sendMessage(target, this.mailAsMessage(mail));
    return this.setMailState(mail, "forwarded");
  }

  /** Mail an agent reads for itself (`mailbox_read`): its own and its owner's unread messages, then marked read. */
  readMailFromSession(sessionId: Id): MailMessage[] {
    const s = this.requireSession(sessionId);
    const unread = this.store.listMail({ sessionId, ...(s.taskId ? { taskId: s.taskId } : { topicId: s.topicId! }), states: ["unread"] });
    return unread.map((m) => this.setMailState(m, "read"));
  }

  decisions(filter: { state?: DecisionRequest["state"] } = {}): DecisionRequest[] {
    return this.store.listDecisions(filter);
  }

  requestDecisionFromSession(sessionId: Id, questionIn: unknown, optionsIn: unknown): DecisionRequest {
    const s = this.requireSession(sessionId);
    const question = boundedText(questionIn, "question", MAX_QUESTION_CHARS);
    const options = Array.isArray(optionsIn) ? optionsIn.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, MAX_OPTION_CHARS)).slice(0, 6) : [];
    const d: DecisionRequest = { id: newId("dec"), sessionId, taskId: s.taskId, topicId: s.topicId, question, options, state: "open", answer: null, createdAt: new Date().toISOString(), answeredAt: null };
    this.store.putDecision(d);
    this.publish({ type: "decision.upserted", decision: d });
    return d;
  }

  answerDecision(id: Id, answerIn: unknown): DecisionRequest {
    const d = this.store.getDecision(id);
    if (!d) throw new HostError("not_found", `decision ${id} not found`);
    if (d.state !== "open") throw new HostError("conflict", "this decision was already answered");
    const answer = boundedText(answerIn, "answer", MAX_QUESTION_CHARS);
    const next: DecisionRequest = { ...d, state: "answered", answer, answeredAt: new Date().toISOString() };
    this.store.putDecision(next);
    this.publish({ type: "decision.upserted", decision: next });
    this.sendMail(null, { kind: "session", sessionId: d.sessionId }, `针对你的问题「${d.question}」，我的决定：${answer}`);
    return next;
  }

  private mailAsMessage(mail: MailMessage): string {
    if (!mail.fromSessionId) return `[AMO 留言] 来自我：\n\n${mail.text}`;
    const from = this.store.getSession(mail.fromSessionId);
    if (mail.fromTopicId) {
      const topic = this.store.getTopic(mail.fromTopicId);
      return `[AMO 留言] 来自专题「${topic?.title || "未命名专题"}」的会话「${from?.title || "会话"}」：\n\n${mail.text}`;
    }
    const task = mail.fromTaskId ? this.store.getTask(mail.fromTaskId) : undefined;
    return `[AMO 留言] 来自任务「${task?.title || "未命名任务"}」的会话「${from?.title || "会话"}」：\n\n${mail.text}`;
  }

  private setMailState(mail: MailMessage, state: MailMessage["state"]): MailMessage {
    if (mail.state === state) return mail;
    const next: MailMessage = { ...mail, state, handledAt: new Date().toISOString() };
    this.store.putMail(next);
    this.publish({ type: "mail.upserted", mail: next });
    return next;
  }

  private requireMail(id: Id): MailMessage {
    const m = this.store.getMail(id);
    if (!m) throw new HostError("not_found", `mail ${id} not found`);
    return m;
  }

  private validRecipient(to: unknown): MailRecipient {
    const r = to as Partial<{ kind: string; sessionId: string; taskId: string; topicId: string }> | null;
    if (r?.kind === "session" && typeof r.sessionId === "string") {
      this.requireSession(r.sessionId);
      return { kind: "session", sessionId: r.sessionId };
    }
    if (r?.kind === "task" && typeof r.taskId === "string") {
      this.requireTask(r.taskId);
      return { kind: "task", taskId: r.taskId };
    }
    if (r?.kind === "topic" && typeof r.topicId === "string") {
      this.requireTopic(r.topicId);
      return { kind: "topic", topicId: r.topicId };
    }
    throw new HostError("bad_request", "to must be { kind: \"session\", sessionId }, { kind: \"task\", taskId } or { kind: \"topic\", topicId }");
  }

  checklist(taskId?: Id): ChecklistItem[] {
    if (taskId) this.requireTask(taskId);
    return this.store.listChecklist(taskId);
  }

  /** Ticks or unticks a checklist step; a session may only tick its own task's steps. */
  setChecklistDone(id: Id, done: unknown, sessionId: Id | null = null): ChecklistItem {
    const item = this.store.getChecklistItem(id);
    if (!item) throw new HostError("not_found", `checklist item ${id} not found`);
    if (typeof done !== "boolean") throw new HostError("bad_request", "done must be true or false");
    if (sessionId && this.requireSession(sessionId).taskId !== item.taskId) throw new HostError("bad_request", "a session can only tick its own task's checklist");
    const next: ChecklistItem = { ...item, done, doneBySessionId: done ? sessionId : null, doneAt: done ? new Date().toISOString() : null };
    this.store.putChecklistItem(next);
    this.publish({ type: "checklist.upserted", item: next });
    return next;
  }
}
