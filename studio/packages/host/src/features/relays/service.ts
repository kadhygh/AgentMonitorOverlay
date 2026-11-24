import { LOCAL_PERSON, RELAY_TEXT_MAX, sessionParty, titleFrom, type Id, type Relay } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { refTopics, roleFacts } from "../../core/role.js";
import { latestMain } from "../collab/matters.js";

/** How long a decided relay stays listed. */
const DECIDED_SHOWN_MS = 24 * 3600_000;

/**
 * 传话 (stage 16, from the stage 15 design): a 主控 (or a topic's own session) asks Studio to say something in another
 * task's session of its topic (or of its project when it is in none). It goes into the task's latest main session
 * (queued while a turn runs), or a new one with the 主控's model when it has none.
 *
 * Since 2026-11-25 (本机的事项, plans/collab-framework.md「留言和主控的来往」) it opens a 委派 or 通知 事项 and is its first
 * message: the answer comes back to the 主控 by itself (mailbox_send with replyTo, in the same 事项), and a 委派's turn
 * that read it reports its reply back as well. By distance (localmail.ts deliveryMode, the user 11-15: 默认自动，可配置):
 * to a task of the same topic it goes at once unless the task says 先问 (relayAuto false); to one that is only on the
 * topic's canvas as a reference card, or in a project without topic, the person confirms it first in the main window,
 * Focus or 待我处理, unless the task takes relays without asking (relayAuto true). The 主控 hears of it only when it
 * did not go in (dismissed, failed).
 */
export class RelaysFeature extends Feature<"collab" | "sessions" | "tasks"> {
  list(): Relay[] {
    const since = Date.now() - DECIDED_SHOWN_MS;
    return this.store.listRelays().filter((r) => r.state === "pending" || Date.parse(r.decidedAt ?? r.createdAt) > since);
  }

  private requireRelay(id: Id): Relay {
    const relay = this.store.getRelay(id);
    if (!relay) throw new HostError("not_found", `relay ${id} not found`);
    return relay;
  }

  private save(relay: Relay): Relay {
    this.store.putRelay(relay);
    this.publish({ type: "relay.upserted", relay });
    return relay;
  }

  /** A 主控's relay (MCP task_message): waits for the person, or goes at once to a task that takes relays. */
  send(fromSessionId: Id, input: { taskId?: unknown; text?: unknown; kind?: unknown }): Relay {
    const facts = roleFacts(this.host, fromSessionId);
    if (facts.role !== "lead" && facts.role !== "topic") throw new HostError("bad_request", "只有主控（或专题会话）能传话：要找别的任务，用 mailbox_send 留言。");
    const target = this.store.getTask(String(input.taskId ?? ""));
    if (!target || target.archivedAt) throw new HostError("bad_request", `task ${String(input.taskId)} not found`);
    if (target.id === facts.task?.id) throw new HostError("bad_request", "传话是给别的任务的");
    // A task of the topic, or one its canvas shows as a reference card (2026-10-17).
    const inScope = facts.topic
      ? target.topicId === facts.topic.id || refTopics(this.host, target).some((t) => t.id === facts.topic!.id)
      : target.workspaceId === facts.task?.workspaceId && !target.topicId;
    if (!inScope) throw new HostError("bad_request", facts.topic ? `任务 ${target.id} 不在你的专题里（也没有引用在专题的画布上）` : `任务 ${target.id} 不在你的项目里（或在某个专题里）`);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new HostError("bad_request", "text is required");
    if (text.length > RELAY_TEXT_MAX) throw new HostError("bad_request", `text is limited to ${RELAY_TEXT_MAX} characters`);
    if (input.kind !== undefined && input.kind !== "delegate" && input.kind !== "notice") throw new HostError("bad_request", "kind must be delegate (委派, the default) or notice (通知)");
    const kind = input.kind === "notice" ? "notice" : "delegate";
    const from = this.requireSession(fromSessionId);
    const matters = this.f.collab.matters;
    const matter = matters.open({ scopeId: matters.scopeOf(from), kind, title: titleFrom(text, kind === "notice" ? "通知" : "委派"), owner: sessionParty(from.id), tasks: [target.id] });
    const auto = matters.modeFor(from, { kind: "task", taskId: target.id }, null) === "auto";
    const id = newId("relay");
    const { mail } = matters.record({ from, to: { kind: "task", taskId: target.id }, text, via: "relay", matter, mode: "none" });
    const relay = this.save({ id, fromSessionId, fromTaskId: facts.task?.id ?? null, toTaskId: target.id, text, state: "pending", createdAt: new Date().toISOString(), decidedAt: null, mailId: mail.id, kind });
    this.store.putMail({ ...mail, relayId: id, ...(auto ? {} : { ask: true }) });
    this.publish({ type: "mail.upserted", mail: this.store.getMail(mail.id)! });
    if (auto) void this.deliver(relay.id).catch(() => undefined);
    return relay;
  }

  /** Whether a relay to `taskId` from `fromSessionId` goes in without the person (the distance rule). */
  goesAtOnce(fromSessionId: Id, taskId: Id): boolean {
    const from = this.store.getSession(fromSessionId);
    return !!from && this.f.collab.matters.modeFor(from, { kind: "task", taskId }, null) === "auto";
  }

  /** Relays on their way in (the person's 送进去 while the automatic one runs is refused, not sent twice). */
  private readonly delivering = new Set<Id>();

  /** The person said yes (or it goes at once): into the task's session. */
  async deliver(id: Id): Promise<Relay> {
    const relay = this.requireRelay(id);
    if (relay.state !== "pending" || this.delivering.has(id)) throw new HostError("conflict", "this relay was decided already");
    this.delivering.add(id);
    try {
      return await this.deliverNow(relay);
    } finally {
      this.delivering.delete(id);
    }
  }

  private async deliverNow(relay: Relay): Promise<Relay> {
    const id = relay.id;
    const target = this.store.getTask(relay.toTaskId);
    const from = this.store.getSession(relay.fromSessionId);
    const lead = relay.fromTaskId ? this.store.getTask(relay.fromTaskId) : undefined;
    const matters = this.f.collab.matters;
    const mail = relay.mailId ? this.store.getMail(relay.mailId) : undefined;
    // A relay from before 2026-11-25 has no message of its own: it reads as it always did.
    const message = mail
      ? matters.modelText(mail)
      : [`【主控「${lead?.title || "主控"}」传话】`, relay.text, "", `（这是主控通过 AMO Studio 传来的。要回复主控，用 mailbox_send 给${relay.fromTaskId ? `任务 ${relay.fromTaskId}` : `会话 ${relay.fromSessionId}`}。）`].join("\n");
    const origin = { kind: "relay" as const, from: lead?.title || "主控", sessionId: relay.fromSessionId };
    try {
      if (!target || target.archivedAt) throw new HostError("bad_request", "the task is gone or archived");
      if (mail?.withdrawnAt !== undefined) throw new HostError("conflict", "主控已经撤回了这条传话");
      const session = latestMain(this.store.listSessions({ taskId: target.id }));
      let sessionId: Id;
      if (session) {
        // The session's inbox (2026-11-04): it goes in once the session's turn is over, not into the running one.
        sessionId = session.id;
        if (mail) await matters.putIn(mail, session.id, origin);
        else await this.f.sessions.inbox.put(session.id, message, origin);
      } else {
        const workspace = this.requireWorkspace(target.workspaceId);
        const profileId = from?.profileId ?? this.profiles[0]!.id;
        sessionId = (await this.f.tasks.startSession({ taskId: target.id, topicId: null }, workspace, { profileId, text: message })).id;
        if (mail) matters.startedWith(mail, sessionId);
      }
      if (mail) {
        const cur = this.store.getMail(mail.id);
        if (cur) this.publish({ type: "mail.upserted", mail: cur });
        if (mail.matter) matters.update(mail.matter, { bindSession: sessionId, ...(relay.kind !== "notice" ? { waitingOn: [sessionParty(sessionId)] } : {}) }, sessionParty(relay.fromSessionId));
        // 委派: the turn that reads it reports its reply back to the 主控 (a 通知 needs no answer).
        if (relay.kind !== "notice") matters.expectRelayReport(sessionId, mail.id, relay.fromSessionId);
      }
      return this.save({ ...this.requireRelay(id), state: "delivered", decidedAt: new Date().toISOString(), sessionId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failed = this.save({ ...this.requireRelay(id), state: "failed", decidedAt: new Date().toISOString(), error });
      this.tellLead(relay, `传话没能送到「${target?.title || relay.toTaskId}」：${error}`);
      return failed;
    }
  }

  dismiss(id: Id): Relay {
    const relay = this.requireRelay(id);
    if (relay.state !== "pending") throw new HostError("conflict", "this relay was decided already");
    const dismissed = this.save({ ...relay, state: "dismissed", decidedAt: new Date().toISOString() });
    const target = this.store.getTask(relay.toTaskId);
    const mail = relay.mailId ? this.store.getMail(relay.mailId) : undefined;
    if (mail) {
      const matters = this.f.collab.matters;
      const done = matters.setReceipts({ ...mail, state: "dismissed", ask: false, handledAt: new Date().toISOString() }, "handled", undefined, true);
      this.store.putMail({ ...done, state: "dismissed", ask: false });
      this.publish({ type: "mail.upserted", mail: this.store.getMail(mail.id)! });
      if (mail.matter) matters.close(mail.matter, LOCAL_PERSON, "人没让它送");
    }
    this.tellLead(relay, `人没有让你的传话送到「${target?.title || relay.toTaskId}」。`);
    return dismissed;
  }

  private tellLead(relay: Relay, text: string): void {
    try {
      this.f.collab.sendMail(null, { kind: "session", sessionId: relay.fromSessionId }, text, { via: "note", ...(relay.mailId ? { matter: this.store.getMail(relay.mailId)?.matter } : {}) });
    } catch {
      // The 主控's session is gone: the relay still records what happened.
    }
  }
}
