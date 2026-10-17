import { RELAY_TEXT_MAX, type Id, type Relay, type Session } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { refTopics, roleFacts } from "../guide/role.js";

/** How long a decided relay stays listed. */
const DECIDED_SHOWN_MS = 24 * 3600_000;

/**
 * 传话 (stage 16, from the stage 15 design): a 主控 (or a topic's own session) asks Studio to say something in another
 * task's session of its topic (or of its project when it is in none). The person confirms it in the main window or
 * Focus, unless the task takes relays without asking (relayAuto); then it goes into the task's latest main session
 * (queued while a turn runs), or a new one with the 主控's model when it has none. The 主控 hears how it went by mail.
 */
export class RelaysFeature extends Feature {
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

  /** A 主控's relay (MCP relay_send): waits for the person, or goes at once to a task that takes relays. */
  send(fromSessionId: Id, input: { taskId?: unknown; text?: unknown }): Relay {
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
    const relay = this.save({ id: newId("relay"), fromSessionId, fromTaskId: facts.task?.id ?? null, toTaskId: target.id, text, state: "pending", createdAt: new Date().toISOString(), decidedAt: null });
    if (target.relayAuto) void this.deliver(relay.id).catch(() => undefined);
    return relay;
  }

  /** The person said yes (or the task takes relays): into the task's session. */
  async deliver(id: Id): Promise<Relay> {
    const relay = this.requireRelay(id);
    if (relay.state !== "pending") throw new HostError("conflict", "this relay was decided already");
    const target = this.store.getTask(relay.toTaskId);
    const from = this.store.getSession(relay.fromSessionId);
    const lead = relay.fromTaskId ? this.store.getTask(relay.fromTaskId) : undefined;
    const message = [
      `【主控「${lead?.title || "主控"}」传话】`,
      relay.text,
      "",
      `（这是主控通过 AMO Studio 传来的。要回复主控，用 mailbox_send 给${relay.fromTaskId ? `任务 ${relay.fromTaskId}` : `会话 ${relay.fromSessionId}`}。）`,
    ].join("\n");
    try {
      if (!target || target.archivedAt) throw new HostError("bad_request", "the task is gone or archived");
      const session = latestMain(this.store.listSessions({ taskId: target.id }));
      let sessionId: Id;
      if (session) {
        await this.f.sessions.sendMessage(session.id, message);
        sessionId = session.id;
      } else {
        const workspace = this.requireWorkspace(target.workspaceId);
        const profileId = from?.profileId ?? this.profiles[0]!.id;
        sessionId = (await this.f.tasks.startSession({ taskId: target.id, topicId: null }, workspace, { profileId, text: message })).id;
      }
      const delivered = this.save({ ...this.requireRelay(id), state: "delivered", decidedAt: new Date().toISOString(), sessionId });
      this.tellLead(relay, `传话已送到「${target.title || "未命名任务"}」。`);
      return delivered;
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
    this.tellLead(relay, `人没有让你的传话送到「${target?.title || relay.toTaskId}」。`);
    return dismissed;
  }

  private tellLead(relay: Relay, text: string): void {
    try {
      this.f.collab.sendMail(null, { kind: "session", sessionId: relay.fromSessionId }, text);
    } catch {
      // The 主控's session is gone: the relay still records what happened.
    }
  }
}

/** The task's main session it was last working in (not archived, not handed to a terminal). */
function latestMain(sessions: readonly Session[]): Session | undefined {
  return sessions
    .filter((s) => s.kind === "main" && !s.archivedAt && s.writer !== "archived" && s.writer !== "terminal-handoff")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
