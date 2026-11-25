import {
  advanceReceipt,
  deliveryMode,
  inTurn,
  isQueued,
  LOCAL_PERSON,
  LOCAL_VIA_LABEL,
  matterRef,
  messageRef,
  pendingFor,
  sessionParty,
  titleFrom,
  type Id,
  type LocalMessageVia,
  type LocalPendingView,
  type LocalThread,
  type MailMessage,
  type MailRecipient,
  type Matter,
  type MatterKind,
  type MatterStatus,
  type MessageOrigin,
  type Party,
  type PendingItem,
  type PendingMessage,
  type Receipt,
  type ReceiptState,
  type Session,
  type Task,
} from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError, MAX_NOTE_CHARS } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

// 本机的事项和消息 (2026-11-25, protocol/src/localmail.ts, plans/collab-framework.md「留言和主控的来往也在本轮改」): the
// Host's own 事项 table and the messages in them. Every 留言 (mailbox_send), 传话 (task_message), session_start's first
// message and its reports, session_send and the person's messages to a session are a MailMessage with a 「#seq」, a
// 事项 and a receipt per recipient (排队 → 送到 → 看过 → 处理了, matters.ts). Who it goes in to and when: the distance
// rule (deliveryMode). No model is spent on any of it.
//
// Receipts here: 排队 while it waits (in the session's inbox, or for the person's OK); 送到 once it went into the
// conversation (the inbox says so: SessionInbox.sent); 看过 once the turn that took it in is over (the model has read
// it) or the agent read it with mailbox_read; 处理了 when the recipient answers it (replyTo), writes anything else in the
// same 事项 after it, marks it (mailbox_read's `handled`), or the 事项 is closed. A 事项 whose messages are all 处理了
// and that waits on nobody closes by itself; a new message in a closed one opens it again.

/** kv: a session's 传话 to report back (委派): [{ mail, lead }] — once the turn that read it ends, its reply goes to the 主控. */
const RELAY_REPORT_KEY = "matters.relay-report:";
/** kv: the session that opened this one forPerson (its 背景更新 go in with the person's next message). */
export const FOR_PERSON_KEY = "sessions.for-person:";

/** How a message goes in: by the distance rule, or as the caller says. `none`: only recorded (the caller put it in itself). */
export type PostMode = "auto" | "ask" | "background" | "none";

export interface PostInput {
  /** The sender: a session, or null for the person (or Studio itself). */
  from: Session | null;
  to: MailRecipient;
  text: string;
  via: LocalMessageVia;
  /** The 事项 it is in; missing: a new one is opened (`open` says what kind). */
  matter?: Matter | null;
  open?: { kind?: MatterKind; title?: string; waitingOn?: Party[] };
  replyTo?: number;
  mode?: PostMode;
  /** For mode "none": it is in the session already (session_start's first message). */
  delivered?: { sessionId: Id; itemId?: Id };
  origin?: MessageOrigin;
}

const ts = () => new Date().toISOString();

export class LocalMatters extends Feature<"sessions"> {
  /** inbox row → mail, for the rows still queued (filled on start and as messages are put in). */
  private readonly byRow = new Map<Id, Id>();
  /** session → mails 送到 there and not 看过 yet. */
  private readonly unseen = new Map<Id, Set<Id>>();

  // ---- 事项

  /** Where a session's 事项 live: its task, or its topic for a topic's own session. */
  scopeOf(s: Pick<Session, "taskId" | "topicId">): Id {
    const scope = s.taskId ?? s.topicId;
    if (!scope) throw new HostError("bad_request", "this session has no task or topic");
    return scope;
  }

  open(input: { scopeId: Id; kind: MatterKind; title: string; owner: Party; side?: string; status?: MatterStatus; waitingOn?: Party[]; sessions?: Id[]; tasks?: Id[] }): Matter {
    const now = Date.now();
    const status = input.status ?? "doing";
    const m: Matter = {
      id: newId("mt"),
      scope: "task",
      scopeId: input.scopeId,
      no: this.store.nextMatterNo(input.scopeId),
      kind: input.kind,
      title: input.title.slice(0, 200),
      owner: input.owner,
      side: input.side ?? "me",
      lead: input.owner.startsWith("agent:") ? input.owner.slice(6) : null,
      status,
      waitingOn: input.waitingOn ?? [],
      waitingWhy: input.waitingOn?.length ? { reason: "address", by: input.owner, at: now, seq: null } : null,
      lastEventAt: now,
      // A task's 事项 has no AI-to-AI cap and is not drawn on a board (protocol/src/matters.ts: 协作 only).
      limited: false,
      place: null,
      placeVersion: 0,
      bindings: { sessions: input.sessions ?? [], tasks: input.tasks ?? [], commits: [] },
      blocker: null,
      dependsOn: [],
      gate: null,
      conclusion: null,
      history: [{ at: now, by: input.owner, from: null, to: status }],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    return this.save(m);
  }

  get(id: Id): Matter | undefined {
    return this.store.getMatter(id);
  }

  require(id: Id): Matter {
    const m = this.store.getMatter(id);
    if (!m) throw new HostError("not_found", `事项 ${id} not found`);
    return m;
  }

  /** Change a 事项's status / waiting on / bindings; closing marks all of its messages 处理了. */
  update(id: Id, patch: { status?: MatterStatus; waitingOn?: Party[]; bindSession?: Id; bindTask?: Id; note?: string; conclusion?: string | null }, by: Party): Matter {
    const m = this.require(id);
    const next: Matter = { ...m, bindings: { ...m.bindings }, history: [...m.history] };
    if (patch.waitingOn) {
      next.waitingOn = patch.waitingOn;
      const same = patch.waitingOn.length === m.waitingOn.length && patch.waitingOn.every((p) => m.waitingOn.includes(p));
      if (!same) next.waitingWhy = patch.waitingOn.length ? { reason: by === LOCAL_PERSON ? "manual" : "address", by, at: Date.now(), seq: null } : null;
    }
    if (patch.bindSession && !next.bindings.sessions.includes(patch.bindSession)) next.bindings.sessions = [...next.bindings.sessions, patch.bindSession];
    if (patch.bindTask && !next.bindings.tasks.includes(patch.bindTask)) next.bindings.tasks = [...next.bindings.tasks, patch.bindTask];
    if (patch.conclusion !== undefined) next.conclusion = patch.conclusion;
    if (patch.status && patch.status !== m.status) {
      next.status = patch.status;
      next.history.push({ at: Date.now(), by, from: m.status, to: patch.status, ...(patch.note ? { note: patch.note } : {}) });
    }
    if (next.status === "closed") {
      next.waitingOn = [];
      next.waitingWhy = null;
    }
    const changed = JSON.stringify({ ...next, history: next.history.length }) !== JSON.stringify({ ...m, history: m.history.length });
    if (!changed) return m;
    next.updatedAt = Date.now();
    next.lastEventAt = next.updatedAt;
    next.version = m.version + 1;
    this.save(next);
    if (next.status === "closed" && m.status !== "closed") for (const mail of this.store.listMailInMatter(id)) this.setReceipts(mail, "handled", undefined, true);
    return next;
  }

  close(id: Id, by: Party, note?: string): Matter {
    return this.update(id, { status: "closed", ...(note ? { note } : {}) }, by);
  }

  /** The person's change (PATCH /api/matters/:id). */
  patchByPerson(id: Id, body: { status?: unknown; note?: unknown }): Matter {
    const status = body.status;
    if (status !== undefined && !(typeof status === "string" && ["todo", "doing", "waiting", "confirm", "pushed", "verified", "closed"].includes(status))) throw new HostError("bad_request", "unknown status");
    return this.update(id, { ...(status ? { status: status as MatterStatus } : {}), ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim().slice(0, 200) } : {}) }, LOCAL_PERSON);
  }

  /**
   * 「事项 3」, 3 or an id, as `session` means it: first among the 事项 it takes part in (owner, bound, a message to or
   * from it), then its own task's (or topic's).
   */
  resolve(ref: unknown, session: Session): Matter {
    const r = matterRef(ref);
    if (!r) throw new HostError("bad_request", "matter: 写「事项 3」、3 或事项的 id");
    if ("id" in r) return this.require(r.id);
    const mine = this.involving(session.id).filter((m) => m.no === r.no);
    if (mine.length === 1) return mine[0]!;
    const own = this.store.getMatterByNo(this.scopeOf(session), r.no);
    if (own) return own;
    if (mine.length > 1) throw new HostError("bad_request", `有几件「事项 ${r.no}」和你有关（不同任务的）：用 replyTo 回那条消息，或写事项的 id（${mine.map((m) => m.id).join("、")}）`);
    throw new HostError("bad_request", `没有「事项 ${r.no}」`);
  }

  /** The 事项 a session takes part in: owns, is bound to, or has a message to or from it. Newest change first. */
  involving(sessionId: Id): Matter[] {
    const party = sessionParty(sessionId);
    const ids = new Set<Id>();
    for (const m of this.store.listMatters()) if (m.owner === party || m.bindings.sessions.includes(sessionId) || m.waitingOn.includes(party)) ids.add(m.id);
    for (const mail of [...this.store.listMail({ sessionId }), ...this.store.listMailFrom(sessionId)]) if (mail.matter) ids.add(mail.matter);
    return [...ids].map((id) => this.store.getMatter(id)).filter((m): m is Matter => !!m).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The open 委派事项 `owner` opened for `worker` (session_start), if any. */
  delegateOf(workerId: Id, ownerId?: Id): Matter | undefined {
    const w = this.store.getSession(workerId);
    if (!w) return undefined;
    const scope = w.taskId ?? w.topicId;
    return this.store
      .listMatters(scope ? { scopeId: scope } : {})
      .find((m) => m.kind === "delegate" && m.bindings.sessions.includes(workerId) && (!ownerId || m.owner === sessionParty(ownerId)));
  }

  private save(m: Matter): Matter {
    this.store.putMatter(m);
    this.publish({ type: "matter.upserted", matter: m });
    return m;
  }

  // ---- messages

  /**
   * A message in a 事项 (a new one when none is given), going in by the distance rule unless `mode` says otherwise.
   * Returns the message as stored (its receipt says whether it went in).
   */
  async post(input: PostInput): Promise<MailMessage> {
    const { mail, mode, target } = this.record(input);
    let out = mail;
    if (mode === "auto" && target) out = await this.putIn(mail, target.id, input.origin);
    return this.store.getMail(out.id) ?? out;
  }

  /**
   * The message stored (and its 事项 opened or reopened), not put into any session yet: `post` puts it in when the
   * mode is auto; mode "none" leaves it for the person or the recipient's mailbox_read (the old 留言's way).
   */
  record(input: PostInput): { mail: MailMessage; mode: PostMode; target: Session | null } {
    const text = input.text.trim();
    if (!text) throw new HostError("bad_request", "text is required");
    if (text.length > Math.max(MAX_NOTE_CHARS, 20_000)) throw new HostError("bad_request", "text is too long");
    const from = input.from;
    const author: Party = from ? sessionParty(from.id) : LOCAL_PERSON;
    const target = this.targetSession(input.to);
    const party = target ? sessionParty(target.id) : recipientParty(input.to);
    if (from && target?.id === from.id) throw new HostError("bad_request", "不能发给你自己");
    let matter = input.matter ?? null;
    // Between a 主控 and a session it started, a message without a 事项 is one of their 委派事项 (the user 11-24: 执行
    // 中途要问主控的，发进同一件事项).
    if (!matter && from && target && input.to.kind === "session") matter = this.delegateOf(from.id, target.id) ?? this.delegateOf(target.id, from.id) ?? null;
    if (!matter) {
      const scopeId = from ? this.scopeOf(from) : target ? this.scopeOf(target) : input.to.kind === "task" ? input.to.taskId : input.to.kind === "topic" ? input.to.topicId : this.scopeOf(this.requireSession(input.to.sessionId));
      matter = this.open({
        scopeId,
        kind: input.open?.kind ?? "work",
        title: input.open?.title ?? titleFrom(text, LOCAL_VIA_LABEL[input.via]),
        owner: author,
        waitingOn: input.open?.waitingOn ?? [],
        sessions: target && from ? [target.id] : [],
        tasks: input.to.kind === "task" ? [input.to.taskId] : [],
      });
    } else if (matter.status === "closed") {
      matter = this.update(matter.id, { status: "doing", note: "有新消息" }, author);
    }
    const mode: PostMode = input.mode ?? this.modeFor(from, input.to, target);
    const now = Date.now();
    const receipt: Receipt = { party, state: "queued", queuedAt: now, deliveredAt: null, seenAt: null, handledAt: null };
    let mail: MailMessage = {
      id: newId("mail"),
      fromSessionId: from?.id ?? null,
      fromTaskId: from?.taskId ?? null,
      fromTopicId: from?.topicId ?? null,
      to: input.to,
      text,
      state: mode === "ask" || mode === "background" ? "unread" : mode === "none" && !input.delivered ? "unread" : "forwarded",
      createdAt: ts(),
      handledAt: null,
      seq: this.store.nextMailSeq(),
      matter: matter.id,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      via: input.via,
      receipts: [input.delivered ? advanceReceipt(receipt, "delivered", now) : receipt],
      ...(mode === "ask" ? { ask: true } : {}),
      ...(input.delivered?.itemId ? { itemId: input.delivered.itemId } : {}),
    };
    this.store.putMail(mail);
    // Answering, or writing again in the 事项: what it was sent there before is 处理了 for it.
    if (from) this.handledBy(author, matter.id, input.replyTo);
    if (input.delivered) this.noteUnseen(input.delivered.sessionId, mail.id);
    // Nowhere to put it in (a task with no session yet): the person sends it in, or starts one.
    if (mode === "auto" && !target) mail = this.saveMail({ ...mail, state: "unread", ask: true });
    else this.publish({ type: "mail.upserted", mail });
    this.touch(matter.id);
    return { mail: this.store.getMail(mail.id) ?? mail, mode, target };
  }

  /** Into the session's inbox (送到 when it goes in): the person's 送进会话, or mode auto. */
  async putIn(mail: MailMessage, sessionId: Id, origin?: MessageOrigin): Promise<MailMessage> {
    const party = sessionParty(sessionId);
    const receipts = (mail.receipts ?? []).map((r) => (r.party.startsWith("agent:task:") || r.party.startsWith("agent:topic:") ? { ...r, party } : r));
    const r = await this.f.sessions.inbox.put(sessionId, this.modelText(mail), origin ?? this.originOf(mail));
    let next: MailMessage = { ...mail, receipts, state: "forwarded", handledAt: ts(), ...(r.itemId ? { itemId: r.itemId } : {}) };
    delete next.ask;
    if (r.delivered) {
      next = { ...next, receipts: next.receipts!.map((x) => (x.party === party ? advanceReceipt(x, "delivered", Date.now()) : x)) };
      this.noteUnseen(sessionId, mail.id);
    } else if (r.itemId) this.byRow.set(r.itemId, mail.id);
    const saved = this.saveMail(next);
    if (r.delivered) this.recheck(sessionId);
    return saved;
  }

  /** The message was the first one of a session started for it (传话 to a task without a session): 送到 there. */
  startedWith(mail: MailMessage, sessionId: Id): MailMessage {
    const party = sessionParty(sessionId);
    const now = Date.now();
    // Its row is the session's first message.
    const [first] = this.store.findItems(sessionId, "user", {}, { limit: 1 });
    const next: MailMessage = { ...mail, state: "forwarded", handledAt: ts(), receipts: (mail.receipts ?? []).map((r) => advanceReceipt({ ...r, party }, "delivered", now)), ...(first ? { itemId: first.id } : {}) };
    delete next.ask;
    this.noteUnseen(sessionId, mail.id);
    const saved = this.saveMail(next);
    this.recheck(sessionId);
    return saved;
  }

  /** A quick turn may have ended before what follows it was noted (看过, a 传话 to report): look once now. */
  private recheck(sessionId: Id): void {
    const s = this.store.getSession(sessionId);
    if (!s || inTurn(s.status)) return;
    this.sessionFree(s);
    this.checkRelayReport(s);
  }

  /** The text the receiving model reads: who, which 事项 and message, the words, and how to answer. */
  modelText(mail: MailMessage): string {
    const matter = mail.matter ? this.store.getMatter(mail.matter) : undefined;
    const from = this.fromLabel(mail);
    const where = matter ? `事项 ${matter.no}「${matter.title}」` : "";
    const head = `【${LOCAL_VIA_LABEL[mail.via ?? "mail"]} #${mail.seq ?? "?"}${where ? ` · ${where}` : ""}】来自${from}${mail.replyTo ? `，回复 #${mail.replyTo}` : ""}：`;
    const tail = !mail.fromSessionId
      ? ""
      : mail.via === "relay"
        ? matter?.kind === "notice"
          ? `（这是主控的通知：知道就行，不用回。要回话也可以：mailbox_send 带 replyTo: ${mail.seq}。）`
          : `（这是主控委派的事：你这一轮做完后，最后的回复会自动交回主控，不用另外留言；中途要问它，用 mailbox_send 带 replyTo: ${mail.seq}。）`
        : mail.via === "report"
          ? `（要它接着做，用 session_send 给会话 ${mail.fromSessionId}；不用再做什么的，用 mailbox_read 带 handled: ["#${mail.seq}"] 标成处理了。）`
          : `（要回话：mailbox_send 带 replyTo: ${mail.seq}，会回到${from}那里。）`;
    return [head, "", mail.text, ...(tail ? ["", tail] : [])].join("\n");
  }

  private fromLabel(mail: MailMessage): string {
    if (!mail.fromSessionId) return "我（人）";
    const s = this.store.getSession(mail.fromSessionId);
    // A session not named yet is titled by its first message: its first line only.
    const name = (s?.title || "会话").split("\n").find((l) => l.trim() && !/^【.*】$/.test(l.trim()))?.trim() ?? "会话";
    const title = `会话「${oneLine(name, 40)}」（${mail.fromSessionId}）`;
    if (mail.fromTaskId) {
      const task = this.store.getTask(mail.fromTaskId);
      return `任务「${task?.title || "未命名任务"}」的${title}`;
    }
    if (mail.fromTopicId) return `专题「${this.store.getTopic(mail.fromTopicId)?.title || "未命名专题"}」的${title}`;
    return title;
  }

  originOf(mail: MailMessage): MessageOrigin {
    const s = mail.fromSessionId ? this.store.getSession(mail.fromSessionId) : undefined;
    const fromName = mail.fromSessionId ? s?.title || "会话" : "我";
    const kind: MessageOrigin["kind"] = mail.via === "send" ? "send" : mail.via === "relay" ? "relay" : mail.via === "report" ? "report" : mail.via === "start" ? "start" : "mail";
    return { kind, from: kind === "mail" && mail.fromSessionId ? `会话「${fromName}」` : fromName, ...(mail.fromSessionId ? { sessionId: mail.fromSessionId } : {}) };
  }

  /** Where a message to `to` goes in: the session itself, a task's latest main session, a topic's own latest session. */
  targetSession(to: MailRecipient): Session | null {
    if (to.kind === "session") {
      const s = this.requireSession(to.sessionId);
      return s;
    }
    if (to.kind === "task") return latestMain(this.store.listSessions({ taskId: to.taskId })) ?? null;
    return latestMain(this.store.listSessions({ topicId: to.topicId }).filter((s) => !s.taskId)) ?? null;
  }

  /** The distance rule (deliveryMode) for a message from `from` to `to`. */
  modeFor(from: Session | null, to: MailRecipient, target: Session | null): "auto" | "ask" {
    if (!from) return "auto";
    const fromTask = from.taskId ? (this.store.getTask(from.taskId) ?? null) : null;
    const fromTopicId = fromTask ? fromTask.topicId : from.topicId;
    const toTaskId = to.kind === "task" ? to.taskId : target?.taskId ?? null;
    const toTask: Task | null = toTaskId ? (this.store.getTask(toTaskId) ?? null) : null;
    const toTopicId = to.kind === "topic" ? to.topicId : !toTask ? (target?.topicId ?? null) : null;
    return deliveryMode({ fromTask, fromTopicId: fromTopicId ?? null, toTask, toTopicId });
  }

  bySeq(ref: unknown): MailMessage {
    const seq = messageRef(ref);
    if (!seq) throw new HostError("bad_request", "写消息的编号，如 #12 或 12");
    const m = this.store.getMailBySeq(seq);
    if (!m) throw new HostError("not_found", `没有 #${seq} 这条消息`);
    return m;
  }

  private saveMail(m: MailMessage): MailMessage {
    this.store.putMail(m);
    this.publish({ type: "mail.upserted", mail: m });
    return m;
  }

  /** Move every receipt (or only `party`'s) forward; handled ones of an agent leave the unseen index. */
  setReceipts(mail: MailMessage, state: ReceiptState, party?: Party, byClose = false): MailMessage {
    if (!mail.receipts?.length) return mail;
    const now = Date.now();
    let changed = false;
    const receipts = mail.receipts.map((r) => {
      if (party && r.party !== party) return r;
      const n = advanceReceipt(r, state, now, byClose);
      if (n !== r) changed = true;
      return n;
    });
    if (!changed) return mail;
    return this.saveMail({ ...mail, receipts });
  }

  /** `party` wrote in 事项 `matterId` (answering #replyTo, if given): what was sent to it there before is 处理了. */
  private handledBy(party: Party, matterId: Id, replyTo?: number): void {
    if (replyTo) {
      const answered = this.store.getMailBySeq(replyTo);
      if (answered) this.setReceipts(answered, "handled", party);
    }
    for (const m of this.store.listMailInMatter(matterId)) {
      const r = m.receipts?.find((x) => x.party === party);
      if (r && r.state !== "handled" && r.state !== "queued") this.setReceipts(m, "handled", party);
    }
  }

  /** A 事项 all of whose messages are 处理了 and that waits on nobody closes by itself; its change time follows. */
  private touch(matterId: Id): void {
    const m = this.store.getMatter(matterId);
    if (!m || m.status === "closed") return;
    const mails = this.store.listMailInMatter(matterId).filter((x) => x.withdrawnAt === undefined && x.state !== "dismissed");
    const done = mails.length > 0 && mails.every((x) => (x.receipts ?? []).every((r) => r.state === "handled"));
    if (done && !m.waitingOn.length) this.update(matterId, { status: "closed", note: "都处理了" }, m.owner);
    else this.save({ ...m, updatedAt: Date.now() });
  }

  // ---- receipts from the sessions

  /** Listens to the inbox and to sessions getting free (看过), and fills the indexes from what is stored. */
  watch(): void {
    this.migrate();
    for (const m of this.store.listMatters({ open: true })) {
      for (const mail of this.store.listMailInMatter(m.id)) {
        for (const r of mail.receipts ?? []) {
          const sid = r.party.slice(6);
          if (r.state === "queued" && mail.itemId) this.byRow.set(mail.itemId, mail.id);
          if (r.state === "delivered" && r.party.startsWith("agent:")) this.noteUnseen(sid, mail.id);
        }
      }
    }
    this.f.sessions.inbox.sent.add((sessionId, itemId) => this.rowSent(sessionId, itemId));
    this.host.on("event", (e) => {
      // A queued row went in: the runtime takes it out of 「held」 as it sends it (its resend may return only later).
      if (e.type === "item.updated" && e.item.type === "user" && this.byRow.has(e.item.id) && e.item.delivery !== "held" && e.item.delivery !== "unsent" && e.item.delivery !== "withdrawn") {
        this.rowSent(e.item.sessionId, e.item.id);
        return;
      }
      if (e.type !== "session.upserted") return;
      if (!inTurn(e.session.status)) {
        this.sessionFree(e.session);
        this.checkRelayReport(e.session);
      }
      if (e.session.archivedAt) this.sessionArchived(e.session);
    });
  }

  private rowSent(sessionId: Id, itemId: Id): void {
    const mailId = this.byRow.get(itemId);
    if (!mailId) return;
    this.byRow.delete(itemId);
    const mail = this.store.getMail(mailId);
    if (!mail) return;
    this.setReceipts(mail, "delivered", sessionParty(sessionId));
    this.noteUnseen(sessionId, mailId);
  }

  private noteUnseen(sessionId: Id, mailId: Id): void {
    const set = this.unseen.get(sessionId) ?? new Set<Id>();
    set.add(mailId);
    this.unseen.set(sessionId, set);
  }

  /** The session's turn is over: what went in before it is 看过. */
  private sessionFree(s: Session): void {
    const ids = this.unseen.get(s.id);
    if (!ids?.size) return;
    // Only once a turn has run after it went in (a message delivered into a free session starts one).
    const [turn] = this.store.findItems(s.id, "turn", {}, { newest: true, limit: 1 });
    if (!turn || turn.type !== "turn" || turn.state === "running") return;
    for (const id of [...ids]) {
      const mail = this.store.getMail(id);
      const row = mail?.itemId ? this.store.getItem(mail.itemId) : undefined;
      if (mail && row && !this.readAfter(s.id, row.seq)) continue;
      ids.delete(id);
      if (!mail) continue;
      this.setReceipts(mail, "seen", sessionParty(s.id));
      const m = mail.matter ? this.store.getMatter(mail.matter) : undefined;
      // A 通知 needs no answer: read, it is done.
      if (m?.kind === "notice" && mail.via === "relay") this.setReceipts(this.store.getMail(id)!, "handled", sessionParty(s.id));
      if (m) this.touch(m.id);
    }
  }

  /**
   * The model went on after the row at `seq`: a reply or a turn came after it. (A turn's own row can come before the
   * message that started it, so the turn's place says nothing; what the model wrote after it does.)
   */
  private readAfter(sessionId: Id, seq: number): boolean {
    return this.store.listItems(sessionId, seq).some((i) => i.type === "agent" || (i.type === "turn" && i.state !== "running"));
  }

  /** A worker archived: its 委派事项 is done. */
  private sessionArchived(s: Session): void {
    for (const m of this.store.listMatters({ open: true })) {
      if (m.kind !== "delegate" || !m.bindings.sessions.includes(s.id)) continue;
      const live = m.bindings.sessions.some((id) => id !== s.id && !this.store.getSession(id)?.archivedAt);
      if (!live) this.close(m.id, LOCAL_PERSON, "执行会话已归档");
    }
  }

  // ---- 传话 reported back (委派)

  /** After the 传话 `mail` went into `sessionId`: the turn that reads it reports back to the 主控. */
  expectRelayReport(sessionId: Id, mailId: Id, leadId: Id): void {
    const list = this.relayReports(sessionId);
    list.push({ mail: mailId, lead: leadId });
    this.store.setKv(RELAY_REPORT_KEY + sessionId, JSON.stringify(list));
    this.recheck(sessionId);
  }

  private relayReports(sessionId: Id): Array<{ mail: Id; lead: Id }> {
    try {
      const v = JSON.parse(this.store.getKv(RELAY_REPORT_KEY + sessionId)?.value || "[]") as unknown;
      return Array.isArray(v) ? (v as Array<{ mail: Id; lead: Id }>) : [];
    } catch {
      return [];
    }
  }

  private checkRelayReport(s: Session): void {
    const list = this.relayReports(s.id);
    if (!list.length) return;
    const [turn] = this.store.findItems(s.id, "turn", {}, { newest: true, limit: 1 });
    if (!turn || turn.type !== "turn" || turn.state === "running") return;
    const left: typeof list = [];
    for (const r of list) {
      const mail = this.store.getMail(r.mail);
      const row = mail?.itemId ? this.store.getItem(mail.itemId) : undefined;
      // Not in yet (held), or no turn ran after it: later.
      if (!mail || mail.withdrawnAt !== undefined) continue;
      if (!row || (row.type === "user" && row.delivery === "held") || !this.readAfter(s.id, row.seq)) {
        if (row || mail.state !== "forwarded") left.push(r);
        continue;
      }
      void this.reportTurn(s, turn.id, mail, r.lead).catch((err: unknown) => this.log(`matters: report of ${s.id} to ${r.lead}: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.store.setKv(RELAY_REPORT_KEY + s.id, left.length ? JSON.stringify(left) : "");
  }

  /** The turn's result as a message of the 委派事项 to the 主控 (「内容同上」 when it wrote there itself in that turn). */
  private async reportTurn(s: Session, turnId: Id, relayMail: MailMessage, leadId: Id): Promise<void> {
    const lead = this.store.getSession(leadId);
    if (!lead || lead.archivedAt) return;
    const turn = this.store.getItem(turnId);
    if (turn?.type !== "turn") return;
    const matter = relayMail.matter ? this.store.getMatter(relayMail.matter) : undefined;
    const text = this.turnResult(s, turn, leadId, matter?.id);
    await this.post({ from: s, to: { kind: "session", sessionId: leadId }, text, via: "report", matter: matter ?? null, replyTo: relayMail.seq, mode: "auto", origin: { kind: "report", from: s.title || "会话", sessionId: s.id, state: turn.state === "interrupted" ? "stopped" : turn.state === "failed" ? "failed" : "done" } });
  }

  /**
   * What a turn of `s` came to, for the session it reports to: its last reply (cut at REPORT_MAX), that the person
   * stopped it, its error — or 「内容同上」 when it already sent `to` a message in that 事项 during the turn.
   */
  turnResult(s: Session, turn: Extract<import("@amo-studio/protocol").SessionItem, { type: "turn" }>, to: Id, matterId?: Id): string {
    if (turn.state === "interrupted") return "被人停下了，还没有结论。它接着做完后，结果会再转给你。";
    if (turn.state === "failed") return `出错停下了：${turn.error ?? "（没有错误信息）"}`;
    const sent = this.store.listMailFrom(s.id, turn.startedAt).filter((m) => m.to.kind === "session" && m.to.sessionId === to && m.via !== "report" && (!matterId || !m.matter || m.matter === matterId));
    if (sent.length) return `这一轮做完了。内容同上：它这一轮已经发给你 ${sent.map((m) => `#${m.seq}`).join("、")}。`;
    const [last] = this.store.findItems(s.id, "agent", {}, { newest: true, limit: 1 });
    const reply = last && last.type === "agent" && last.createdAt >= turn.startedAt ? last.markdown.trim() : "";
    const excerpt = reply.length > REPORT_MAX ? `${reply.slice(0, REPORT_MAX)}…（后面省略；完整的用 session_tree 或打开会话看）` : reply;
    return excerpt ? ["这一轮做完了：", "", excerpt].join("\n") : "这一轮做完了（它没有回复文字）。";
  }

  // ---- what the sender can do with its queue

  /** A session's messages still queued (排队), oldest first. */
  queuedFrom(sessionId: Id): MailMessage[] {
    return this.store.listMailFrom(sessionId).filter((m) => isQueued(m));
  }

  /** 撤回 a queued message (its sender, or the person). */
  withdraw(ref: unknown, by: Session | null): MailMessage {
    const mail = this.bySeq(ref);
    this.ownQueued(mail, by);
    const sid = mail.receipts?.[0]?.party.slice(6);
    if (mail.itemId && sid && !this.f.sessions.inbox.withdraw(sid, mail.itemId)) throw new HostError("conflict", `#${mail.seq} 已经送进去了，撤不回：要改口就再发一条，说明取代 #${mail.seq}。`);
    if (mail.itemId) this.byRow.delete(mail.itemId);
    const next = this.saveMail({ ...mail, withdrawnAt: Date.now(), state: "dismissed", handledAt: ts() });
    if (mail.via === "relay") this.dropRelay(mail.id);
    if (mail.matter) this.touch(mail.matter);
    return next;
  }

  /** 改写 a queued message. */
  rewrite(ref: unknown, textIn: unknown, by: Session | null): MailMessage {
    const mail = this.bySeq(ref);
    this.ownQueued(mail, by);
    const text = typeof textIn === "string" ? textIn.trim() : "";
    if (!text) throw new HostError("bad_request", "text is required");
    const next: MailMessage = { ...mail, text, editedAt: Date.now() };
    const sid = mail.receipts?.[0]?.party.slice(6);
    if (mail.itemId && sid && !this.f.sessions.inbox.rewrite(sid, mail.itemId, this.modelText(next))) throw new HostError("conflict", `#${mail.seq} 已经送进去了，改不了：要改口就再发一条，说明取代 #${mail.seq}。`);
    if (mail.via === "relay") {
      const relay = this.store.listRelays().find((r) => r.mailId === mail.id);
      if (relay && relay.state === "pending") {
        const r = { ...relay, text };
        this.store.putRelay(r);
        this.publish({ type: "relay.upserted", relay: r });
      }
    }
    return this.saveMail(next);
  }

  private ownQueued(mail: MailMessage, by: Session | null): void {
    if (by && mail.fromSessionId !== by.id) throw new HostError("bad_request", `#${mail.seq} 不是你发的`);
    if (!isQueued(mail)) throw new HostError("conflict", mail.withdrawnAt !== undefined ? `#${mail.seq} 已经撤回了` : `#${mail.seq} 已经送到了（${mail.receipts?.map((r) => r.state).join("、") || "没有回执"}），撤不回、改不了：要改口就再发一条，说明取代 #${mail.seq}。`);
  }

  private dropRelay(mailId: Id): void {
    const relay = this.store.listRelays().find((r) => r.mailId === mailId);
    if (!relay || relay.state !== "pending") return;
    const r = { ...relay, state: "dismissed" as const, decidedAt: ts() };
    this.store.putRelay(r);
    this.publish({ type: "relay.upserted", relay: r });
  }

  // ---- 背景更新 (a session opened forPerson)

  /** The session that opened `sessionId` for the person, if any. */
  openedForPersonBy(sessionId: Id): Id | null {
    return this.store.getKv(FOR_PERSON_KEY + sessionId)?.value || null;
  }

  /** The 背景更新 waiting for the person's next message in `sessionId`, as lines for it; `told()` once they went in. */
  backgroundHint(sessionId: Id): { lines: string[]; told: () => void } | null {
    const waiting = this.store.listMail({ sessionId, states: ["unread"] }).filter((m) => m.via === "background" && isQueued(m));
    if (!waiting.length) return null;
    const lines = waiting.map((m) => {
      const s = m.fromSessionId ? this.store.getSession(m.fromSessionId) : undefined;
      const at = new Date(m.createdAt);
      const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      return `背景更新（#${m.seq}，来自开这个会话的「${s?.title || "会话"}」，${hhmm}；是补充的情况，不是人的话）：${m.text.replace(/\s*\n\s*/g, " ")}`;
    });
    return {
      lines,
      told: () => {
        for (const m of waiting) {
          const cur = this.store.getMail(m.id);
          if (!cur) continue;
          this.saveMail({ ...this.setReceipts(cur, "delivered"), state: "forwarded", handledAt: ts() });
          this.noteUnseen(sessionId, m.id);
        }
      },
    };
  }

  // ---- 待我处理

  /** A session's 待我处理 (an agent's): messages to it not 处理了, 事项 waiting on it. */
  pendingOf(sessionId: Id): PendingItem[] {
    const party = sessionParty(sessionId);
    const out: PendingItem[] = [];
    const byScope = new Map<Id, Matter[]>();
    for (const m of this.store.listMatters({ open: true })) byScope.set(m.scopeId, [...(byScope.get(m.scopeId) ?? []), m]);
    for (const [scopeId, matters] of byScope) {
      const messages = matters.flatMap((m) => this.store.listMailInMatter(m.id)).map(asPending);
      out.push(...pendingFor(party, "task", scopeId, matters, messages));
    }
    return out.sort((a, b) => b.since - a.since);
  }

  /** The person's 待我处理 page, the Host's part; `taskId`: only what concerns that task. */
  pendingView(taskId?: Id): LocalPendingView {
    const sessionsOf = taskId ? new Set(this.store.listSessions({ taskId }).map((s) => s.id)) : null;
    const concerns = (mail: MailMessage) =>
      !sessionsOf ||
      mail.fromTaskId === taskId ||
      (mail.to.kind === "task" && mail.to.taskId === taskId) ||
      (mail.to.kind === "session" && sessionsOf.has(mail.to.sessionId)) ||
      (mail.fromSessionId !== null && sessionsOf.has(mail.fromSessionId));
    // 先问 ones, and an agent's message that did not go in by itself and was not read yet (a note to a 主控, mail from
    // before): the page sends it in or drops it, as the old 留言 panel did. The person's own (a decision's answer) are not.
    // Nor, while its recipient is archived or gone, one with nowhere to go in (2026-11-25): the message is left as it is.
    const asks = this.store
      .listMail({ states: ["unread"] })
      .filter((m) => (m.ask || m.fromSessionId !== null) && m.withdrawnAt === undefined && m.via !== "background" && concerns(m) && !this.recipientGone(m.to));
    const threads: LocalThread[] = [];
    for (const m of this.store.listMatters({ open: true })) {
      const messages = this.store.listMailInMatter(m.id);
      if (taskId && m.scopeId !== taskId && !m.bindings.tasks.includes(taskId) && !messages.some(concerns)) continue;
      threads.push({ matter: m, messages });
    }
    const pending: PendingItem[] = asks.map((m) => {
      const matter = m.matter ? this.store.getMatter(m.matter) : undefined;
      const since = Date.parse(m.createdAt);
      const by = m.fromSessionId ? sessionParty(m.fromSessionId) : null;
      return { kind: "message", scope: "task", scopeId: m.fromTaskId ?? m.fromTopicId ?? "", matter: m.matter ?? null, matterNo: matter?.no ?? null, matterTitle: matter?.title ?? null, matterStatus: matter?.status ?? null, seq: m.seq ?? null, seqs: m.seq ? [m.seq] : [], since, why: { by, at: since, reason: "message", text: m.ask ? "等你放行" : "没送进对话" }, text: `#${m.seq} ${m.ask ? "等你放行" : "没送进对话"}：${oneLine(m.text)}` };
    });
    for (const t of threads) if (t.matter) pending.push(...pendingFor(LOCAL_PERSON, "task", t.matter.scopeId, [t.matter], t.messages.map(asPending)));
    return { asks, threads, pending: pending.sort((a, b) => b.since - a.since) };
  }

  /** The task, session or topic a message is for is archived or not there. */
  private recipientGone(to: MailRecipient): boolean {
    const r = to.kind === "task" ? this.store.getTask(to.taskId) : to.kind === "session" ? this.store.getSession(to.sessionId) : this.store.getTopic(to.topicId);
    return !r || !!r.archivedAt;
  }

  /** The person marks messages 看过 / 处理了 (their receipts all move). */
  markByPerson(ids: unknown, mark: unknown): MailMessage[] {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new HostError("bad_request", "ids must be a list of mail ids");
    if (mark !== "seen" && mark !== "handled") throw new HostError("bad_request", "mark must be seen or handled");
    const out: MailMessage[] = [];
    const touched = new Set<Id>();
    for (const id of ids as string[]) {
      const mail = this.store.getMail(id);
      if (!mail) continue;
      out.push(this.setReceipts(mail, mark));
      if (mail.matter) touched.add(mail.matter);
    }
    for (const m of touched) this.touch(m);
    return out;
  }

  /** An agent marks messages it got 处理了 (mailbox_read's `handled`). */
  markHandledBy(session: Session, refs: unknown): number[] {
    if (!Array.isArray(refs)) throw new HostError("bad_request", "handled: 写消息编号的列表，如 [\"#12\", 13]");
    const party = sessionParty(session.id);
    const done: number[] = [];
    for (const ref of refs) {
      const mail = this.bySeq(ref);
      if (!mail.receipts?.some((r) => r.party === party)) throw new HostError("bad_request", `#${mail.seq} 不是发给你的`);
      this.setReceipts(mail, "handled", party);
      if (mail.matter) this.touch(mail.matter);
      done.push(mail.seq!);
    }
    return done;
  }

  // ---- mail from before (2026-11-25)

  /** Mail without a 「#seq」 gets one and a receipt for its recipient: unread → 排队 (still for the person or the agent to take), the rest 处理了. */
  private migrate(): void {
    const old = this.store.listMailWithoutSeq();
    if (!old.length) return;
    let seq = this.store.nextMailSeq();
    this.store.transaction(() => {
      for (const m of old) {
        const at = Date.parse(m.createdAt) || Date.now();
        const party: Party = m.to.kind === "session" ? sessionParty(m.to.sessionId) : recipientParty(m.to);
        const base: Receipt = { party, state: "queued", queuedAt: at, deliveredAt: null, seenAt: null, handledAt: null };
        const done = m.handledAt ? Date.parse(m.handledAt) || at : at;
        const receipt = m.state === "unread" ? base : advanceReceipt(base, "handled", done);
        this.store.putMail({ ...m, seq: seq++, via: m.fromSessionId ? "mail" : "answer", receipts: [receipt], ...(m.state === "unread" ? { ask: true } : {}) });
      }
    });
    this.log(`matters: ${old.length} 留言 from before got their #seq`);
  }
}

/** How much of a reply a report carries. */
const REPORT_MAX = 4000;

const oneLine = (t: string, max = 80) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** A task or topic, standing for the session it will go into (a 留言 to a task waits for the person to pick one). */
function recipientParty(to: MailRecipient): Party {
  return to.kind === "session" ? sessionParty(to.sessionId) : to.kind === "task" ? `agent:task:${to.taskId}` : `agent:topic:${to.topicId}`;
}

function asPending(m: MailMessage): PendingMessage {
  return { seq: m.seq ?? 0, author: m.fromSessionId ? sessionParty(m.fromSessionId) : LOCAL_PERSON, body: m.text, createdAt: Date.parse(m.createdAt), matter: m.matter ?? null, ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.receipts ? { receipts: m.receipts } : {}), ...(m.withdrawnAt !== undefined ? { withdrawnAt: m.withdrawnAt } : {}) };
}

/** The task's main session it was last working in (not archived, not handed to a terminal). */
export function latestMain(sessions: readonly Session[]): Session | undefined {
  return sessions
    .filter((s) => s.kind === "main" && !s.archivedAt && s.writer !== "archived" && s.writer !== "terminal-handoff")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
