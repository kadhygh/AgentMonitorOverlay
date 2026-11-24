import { inTurn, LOCAL_PERSON, sessionParty, type Id, type LocalMessageVia, type MessageOrigin, type TaskNote, type MailMessage, type MailRecipient, type DecisionRequest, type ChecklistItem, type Session } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { LocalMatters } from "./matters.js";
import { LocalPendingSource } from "./pending-source.js";
import { HostError, boundedText, MAX_NOTE_CHARS, MAX_QUESTION_CHARS, MAX_OPTION_CHARS } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Collaboration (stage 5): notes and handoffs, mail, decision requests, checklists. */
export class CollabFeature extends Feature<"pending" | "sessions"> {
  /** 本机的事项和消息 (2026-11-25): every message here is one of a 事项's (matters.ts). */
  readonly matters = new LocalMatters(this.host);

  /**
   * 待我处理's local source (2026-11-25, source "local" of features/pending): registered once the 事项 are read, and told
   * whenever a message, a 事项 or a session's turn moves.
   */
  watchPending(): void {
    const source = new LocalPendingSource(this.matters, this.f.pending, {
      inbox: this.f.sessions.inbox,
      // 处理了 on a message waiting to be let in is 不送 (a 传话 is the person's to decide on its own card).
      dropAsk: (mail) => {
        if (!mail.relayId) this.updateMail(mail.id, { state: "dismissed" });
      },
    });
    this.f.pending.register(source);
    this.host.on("event", (e) => {
      if (e.type === "mail.upserted" || e.type === "matter.upserted" || (e.type === "session.upserted" && (!inTurn(e.session.status) || e.session.archivedAt))) source.poke();
    });
  }

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

  /**
   * Leaves a message for a session or a task, kept for the recipient's mailbox_read or the person's 送进会话 (Studio's
   * own notes, the answer to a decision, the person's POST /api/mail). `fromSessionId` null: from the person. Since
   * 2026-11-25 it is a message of a new 事项 (or of `matter`) with a 「#seq」 and a receipt.
   */
  sendMail(fromSessionId: Id | null, to: unknown, textIn: unknown, opts: { via?: LocalMessageVia; matter?: Id } = {}): MailMessage {
    const text = boundedText(textIn, "text", MAX_NOTE_CHARS);
    const recipient = this.validRecipient(to);
    const from = fromSessionId ? this.requireSession(fromSessionId) : null;
    if (from && recipient.kind === "session" && recipient.sessionId === from.id) throw new HostError("bad_request", "a session cannot leave mail for itself");
    const matter = opts.matter ? (this.matters.get(opts.matter) ?? null) : null;
    return this.matters.record({ from, to: recipient, text, via: opts.via ?? (from ? "mail" : "note"), matter, mode: "none" }).mail;
  }

  /**
   * mailbox_send (2026-11-25): a message in a 事项 — `replyTo` answers a message (to its sender, in its 事项), `matter`
   * writes in a 事项 (to its other side), otherwise a new 事项 to the session, task or topic named. It goes in by the
   * distance rule (localmail.ts deliveryMode). `withdraw` / `edit`: 撤回 or 改写 one of the caller's still queued.
   */
  async sendFromSession(sessionId: Id, args: { toSessionId?: unknown; toTaskId?: unknown; toTopicId?: unknown; text?: unknown; replyTo?: unknown; matter?: unknown; withdraw?: unknown; edit?: unknown }): Promise<MailMessage> {
    const from = this.requireSession(sessionId);
    const given = (v: unknown) => v !== undefined && v !== null && v !== "";
    if (given(args.withdraw)) return this.matters.withdraw(args.withdraw, from);
    if (given(args.edit)) return this.matters.rewrite(args.edit, args.text, from);
    const text = boundedText(args.text, "text", MAX_NOTE_CHARS);
    const replied = given(args.replyTo) ? this.matters.bySeq(args.replyTo) : null;
    let matter = given(args.matter) ? this.matters.resolve(args.matter, from) : null;
    if (replied && !matter && replied.matter) matter = this.matters.get(replied.matter) ?? null;
    let to: MailRecipient | null =
      typeof args.toSessionId === "string" && args.toSessionId
        ? { kind: "session", sessionId: args.toSessionId }
        : typeof args.toTaskId === "string" && args.toTaskId
          ? { kind: "task", taskId: args.toTaskId }
          : typeof args.toTopicId === "string" && args.toTopicId
            ? { kind: "topic", topicId: args.toTopicId }
            : null;
    if (!to && replied) {
      if (!replied.fromSessionId) throw new HostError("bad_request", `#${replied.seq} 是人写的：要问人，用 decision_request`);
      to = { kind: "session", sessionId: replied.fromSessionId === from.id ? (replied.to.kind === "session" ? replied.to.sessionId : "") : replied.fromSessionId };
      if (to.kind === "session" && !to.sessionId) throw new HostError("bad_request", `#${replied.seq} 是你自己发的：用 toSessionId 说发给谁`);
    }
    if (!to && matter) {
      // The other side of the 事项: its owner when the caller is not, else its one other bound session.
      const owner = matter.owner.startsWith("agent:") ? matter.owner.slice(6) : null;
      const others = matter.bindings.sessions.filter((id) => id !== from.id);
      if (owner && owner !== from.id) to = { kind: "session", sessionId: owner };
      else if (others.length === 1) to = { kind: "session", sessionId: others[0]! };
      else throw new HostError("bad_request", `事项 ${matter.no} 里不止一方（或只有你）：用 toSessionId 说发给谁`);
    }
    if (!to) throw new HostError("bad_request", "给 toSessionId、toTaskId 或 toTopicId；回话用 replyTo（消息编号），在事项里说用 matter");
    return this.matters.post({ from, to: this.validRecipient(to), text, via: "mail", matter, ...(replied?.seq ? { replyTo: replied.seq } : {}) });
  }

  /** The person: 已读 / 不送 (dismissed), 撤回 (`withdraw`) or 改写 (`text`) of a message still queued. */
  updateMail(id: Id, body: { state?: unknown; withdraw?: unknown; text?: unknown }): MailMessage {
    const mail = this.requireMail(id);
    if (body.withdraw === true) return this.matters.withdraw(mail.seq, null);
    if (typeof body.text === "string") return this.matters.rewrite(mail.seq, body.text, null);
    const state = body.state;
    if (state !== "read" && state !== "dismissed") throw new HostError("bad_request", "state must be read or dismissed");
    if (state === "dismissed" && mail.via === "relay" && mail.relayId) throw new HostError("bad_request", "这是一条传话：用传话的「不送」");
    const next = this.setMailState(mail, state);
    if (state !== "dismissed") return next;
    // 不送 (the person drops what waited for them): done with, as a 事项's message.
    const done = this.saveMail({ ...this.matters.setReceipts(next, "handled", undefined, true), ask: false });
    if (mail.matter) this.matters.update(mail.matter, {}, LOCAL_PERSON);
    return done;
  }

  /**
   * The person puts a message into a conversation; it goes in as a user message, marked as coming from AMO mail —
   * through the session's inbox (2026-11-04): an agent's words, so once the session's turn is over (立即发送 on the row
   * sends it at once).
   */
  /**
   * The person puts a message into a conversation (送进会话); it goes in marked as coming from where it came from —
   * through the session's inbox (2026-11-04): an agent's words, so once the session's turn is over (立即发送 on the row
   * sends it at once). A message of a 事项 (2026-11-25) says its 「#seq」 and how to answer; one from before reads as it
   * always did. Mail to a task without a session named goes into the task's latest main session.
   */
  async forwardMail(id: Id, input: { sessionId?: unknown } = {}): Promise<MailMessage> {
    const mail = this.requireMail(id);
    if (mail.state === "forwarded") throw new HostError("conflict", "this message was already forwarded");
    if (mail.withdrawnAt !== undefined) throw new HostError("conflict", "这条已经被发的一方撤回了");
    if (mail.via === "relay" && mail.relayId) throw new HostError("bad_request", "这是一条传话：用传话的「送进去」");
    const named = typeof input.sessionId === "string" && input.sessionId ? input.sessionId : null;
    const target = mail.to.kind === "session" ? mail.to.sessionId : (named ?? this.matters.targetSession(mail.to)?.id ?? null);
    if (!target) throw new HostError("bad_request", "name the session to forward this message to");
    const session = this.requireSession(target);
    if (mail.to.kind === "task" && session.taskId !== mail.to.taskId) throw new HostError("bad_request", "that session is not part of the task the message was left for");
    if (mail.to.kind === "topic" && session.topicId !== mail.to.topicId) throw new HostError("bad_request", "that session is not one of the topic's own sessions");
    if (mail.matter) return this.matters.putIn(mail, target);
    const r = await this.f.sessions.inbox.put(target, this.mailAsMessage(mail), this.mailOrigin(mail));
    const next = this.setMailState(mail, "forwarded");
    return r.delivered ? this.matters.setReceipts(next, "delivered") : next;
  }

  /**
   * Mail an agent reads for itself (`mailbox_read`): its own and its owner's unread messages, then marked read (看过).
   * Messages it is done with are marked first (matters.markHandledBy, mailbox_read's `handled`).
   */
  readMailFromSession(sessionId: Id): MailMessage[] {
    const s = this.requireSession(sessionId);
    const unread = this.store.listMail({ sessionId, ...(s.taskId ? { taskId: s.taskId } : { topicId: s.topicId! }), states: ["unread"] }).filter((m) => m.via !== "background" && m.withdrawnAt === undefined);
    const party = sessionParty(sessionId);
    const messages = unread.map((m) => {
      const read = this.setMailState(m, "read");
      // One left for the task or topic: it is this session's now.
      const own = read.receipts?.map((r) => (r.party === party || r.party.startsWith("agent:task:") || r.party.startsWith("agent:topic:") ? { ...r, party } : r));
      const next = own ? this.saveMail({ ...read, receipts: own, ask: false }) : read;
      return this.matters.setReceipts(next, "seen", party);
    });
    return messages;
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
    const mail = this.sendMail(null, { kind: "session", sessionId: d.sessionId }, `针对你的问题「${d.question}」，我的决定：${answer}`, { via: "answer" });
    const next: DecisionRequest = { ...d, state: "answered", answer, answeredAt: new Date().toISOString(), mailId: mail.id };
    this.store.putDecision(next);
    this.publish({ type: "decision.upserted", decision: next });
    this.deliverAnswer(next);
    return next;
  }

  /**
   * decision_request does not hold the turn, so the answer often comes after the turn ended — and then it sat in the
   * mailbox unread with nothing happening (2026-11-05, the user: "回复过慢，在会话结束之后才选完，则没有任何反应"; a
   * Codex session of 10-22 and a DSH one of 10-27 still had theirs unread). The answer stays mail while the turn runs
   * (mailbox_read finds it there); once the session is out of its turn and has not read it, it goes into the
   * conversation as a message (the inbox: held while the session is not free, see sessions/inbox.ts).
   */
  watchAnswers(): void {
    this.host.on("event", (e) => {
      if (e.type === "session.upserted" && this.answersFor.has(e.session.id) && !inTurn(e.session.status)) this.forwardAnswers(e.session);
    });
    // Answers a Host before a restart had not handed on yet (a decision without mailId predates this: left as it was).
    for (const d of this.store.listDecisions({ state: "answered" })) if (d.mailId && this.store.getMail(d.mailId)?.state === "unread") this.deliverAnswer(d);
  }

  /** Sessions with an answered decision still to hand on: session id -> mail ids. */
  private readonly answersFor = new Map<Id, Set<Id>>();

  private deliverAnswer(d: DecisionRequest): void {
    const s = this.store.getSession(d.sessionId);
    // A subagent cannot take a message of its own, an archived session none: the answer stays mail, as before.
    if (!d.mailId || !s || s.archivedAt || s.kind === "sub") return;
    const ids = this.answersFor.get(s.id) ?? new Set<Id>();
    ids.add(d.mailId);
    this.answersFor.set(s.id, ids);
    if (!inTurn(s.status)) this.forwardAnswers(s);
  }

  private forwardAnswers(s: Session): void {
    const ids = this.answersFor.get(s.id);
    this.answersFor.delete(s.id);
    for (const id of ids ?? []) {
      if (this.store.getMail(id)?.state !== "unread") continue; // read with mailbox_read during the turn
      void this.forwardMail(id).catch((err: unknown) => this.log(`${s.id}: the answer to a decision could not go into the session: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** Who a forwarded 留言 is from, as its row in the conversation says (2026-11-15, MessageOrigin). */
  private mailOrigin(mail: MailMessage): MessageOrigin {
    if (!mail.fromSessionId) return { kind: "mail", from: "我" };
    const from = this.store.getSession(mail.fromSessionId);
    return { kind: "mail", from: `会话「${from?.title || "会话"}」`, sessionId: mail.fromSessionId };
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
    return this.saveMail({ ...mail, state, handledAt: new Date().toISOString() });
  }

  private saveMail(mail: MailMessage): MailMessage {
    this.store.putMail(mail);
    this.publish({ type: "mail.upserted", mail });
    return mail;
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
