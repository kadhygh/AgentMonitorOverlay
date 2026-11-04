import { BUSY_STATUSES, inTurn, type Id, type Session, type SessionItem } from "@amo-studio/protocol";
import { newId, type SessionItemInput } from "../../store/store.js";
import { Feature } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";

// 会话收件箱 (2026-11-04, plans/message-delivery.md): messages from agents and from Studio itself — a 中转 reply, 值守
// going on in a session, 传话 (task_message), a forwarded mail, session_send, session_start's report — go into the
// conversation at once as a row `delivery: "held"` (「等这一轮结束后送进去」) and are sent once the session is free: not in
// a turn, not waiting on the person, not handed to a terminal. Before, each place called sendMessage as the person's
// messages do: steered into a Codex turn mid-step, queued in memory only for DSH (and lost on an error), and a 中转
// reply that could not go in was lost after the relay had marked it taken. Only session_send waited, in its own kv.
//
// The row is the message (the store keeps it); kv `sessions.inbox` lists the sessions that have some, so a Host
// restart goes on sending. One that cannot go in becomes 没送到 with a line saying why (重新发送 tries again); an
// archived session's become 没送到 too. A copy of a remote session is not held here: its rows are the other computer's.

const INBOX_KEY = "sessions.inbox";
/** session_send's queue before the inbox (2026-11-01..11-04): session id → texts. Moved into the inbox at start. */
const PEER_QUEUE_KEY = "sessions.peer-queue";
/** How long the next held message waits for the turn the first one started to show (see deliver). */
const TURN_SEEN_MS = 3000;

export class SessionInbox extends Feature {
  private known: Set<Id> | null = null;
  /** One delivery at a time per session; `again`: something came meanwhile, look once more after it. */
  private readonly flushing = new Map<Id, Promise<void>>();
  private readonly again = new Set<Id>();

  /**
   * A message from an agent or from Studio into `sessionId`: shown at once, sent now when the session is free, else
   * when it is. `delivered`: it went in now; `waiting`: how many of the session's are still held.
   */
  async put(sessionId: Id, text: string): Promise<{ delivered: boolean; waiting: number }> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt || s.writer === "archived") throw new HostError("read_only", "这个会话已归档，不能再往里发消息");
    if (s.kind === "sub") throw new HostError("read_only", "子 agent 不能单独接收消息");
    if (!text.trim()) throw new HostError("bad_request", "text is required");
    if (s.runtime === "remote") {
      await this.f.sessions.sendMessage(sessionId, text);
      return { delivered: true, waiting: 0 };
    }
    const role = this.f.sessions.roleUpdate(sessionId);
    const item = this.append(s, this.f.sessions.withRole(text, role.lines));
    role.told();
    this.remember(sessionId);
    await this.flush(sessionId);
    const now = this.store.getItem(item.id);
    return { delivered: !(now?.type === "user" && now.delivery === "held"), waiting: this.held(sessionId).length };
  }

  /** 立即发送 on a held row: it goes now — into the running turn as the person's would, which then gives way to it. */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId || item.delivery !== "held") return;
    const rt = this.runtime;
    if (!rt.resend) throw new HostError("bad_request", "this Host cannot send a held message");
    await this.wrap(() => rt.resend!(sessionId, itemId, [], { now: true }));
  }

  /** Watches sessions get free; sends what the last Host left held, and moves session_send's old queue in. */
  watch(): void {
    this.migratePeerQueue();
    this.f.on("event", (e) => {
      if (e.type === "session.upserted" && this.ids().has(e.session.id)) void this.flush(e.session.id).catch(() => undefined);
    });
    for (const id of this.ids()) void this.flush(id).catch(() => undefined);
  }

  /** The session's held rows, oldest first. */
  held(sessionId: Id): SessionItem[] {
    return this.store.findItems(sessionId, "user", { delivery: "held" });
  }

  flush(sessionId: Id): Promise<void> {
    const running = this.flushing.get(sessionId);
    if (running) {
      this.again.add(sessionId);
      return running;
    }
    const p = this.deliver(sessionId).finally(() => {
      this.flushing.delete(sessionId);
      if (this.again.delete(sessionId)) void this.flush(sessionId).catch(() => undefined);
    });
    this.flushing.set(sessionId, p);
    return p;
  }

  private async deliver(sessionId: Id): Promise<void> {
    const s = this.store.getSession(sessionId);
    const held = s ? this.held(sessionId) : [];
    if (!s || !held.length) return this.forget(sessionId);
    if (s.archivedAt || s.writer === "archived") {
      for (const it of held) this.mark(it.id, "unsent");
      return this.forget(sessionId);
    }
    if (!free(s)) return;
    const rt = this.runtime;
    // The first starts a turn; the others follow it at once (queued at the CLI, steered in, or DSH's next turn) — once
    // the turn is seen to run: Codex tells it (turn/started) only after its turn/start, and a second turn/start before
    // that would not be a steer.
    let first = true;
    for (const it of held) {
      const current = this.store.getItem(it.id);
      if (current?.type !== "user" || current.delivery !== "held") continue;
      if (!first) await this.turnSeen(sessionId);
      first = false;
      try {
        if (!rt.resend) throw new Error("this Host cannot send a held message");
        await rt.resend(sessionId, it.id, []);
      } catch (err) {
        this.mark(it.id, "unsent");
        const why = err instanceof Error ? err.message : String(err);
        this.publish({ type: "item.appended", item: this.store.appendItem(this.row(s, { type: "notice", level: "warning", message: `这条消息没能送进会话：${why}。可以点它下面的「重新发送」再试。` }, "inbox/failed")) });
      }
    }
    if (!this.held(sessionId).length) this.forget(sessionId);
  }

  /** Until the session is in a turn (or TURN_SEEN_MS passed: a turn that was over at once, or none started). */
  private async turnSeen(sessionId: Id): Promise<void> {
    const end = Date.now() + TURN_SEEN_MS;
    while (Date.now() < end) {
      const s = this.store.getSession(sessionId);
      if (!s || inTurn(s.status)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private append(s: Session, text: string): SessionItem {
    const item = this.store.appendItem(this.row(s, { type: "user", text, delivery: "held" }, "user/inbox"));
    this.publish({ type: "item.appended", item });
    return item;
  }

  /** A row of Studio's own in the session; in the turn running now, if one is (the transcript groups rows by turn). */
  private row(s: Session, body: Record<string, unknown>, method: string): SessionItemInput {
    const [turn] = this.store.findItems(s.id, "turn", { state: "running" }, { newest: true, limit: 1 });
    const turnId = turn?.type === "turn" ? turn.turnId : undefined;
    return { ...body, id: newId("i"), sessionId: s.id, createdAt: new Date().toISOString(), raw: { runtime: s.runtime, method, ...(turnId ? { turnId } : {}) } } as SessionItemInput;
  }

  private mark(itemId: Id, delivery: "unsent"): void {
    const it = this.store.getItem(itemId);
    if (it?.type !== "user" || it.delivery !== "held") return;
    this.publish({ type: "item.updated", item: this.store.replaceItem({ ...it, delivery }) });
  }

  private ids(): Set<Id> {
    if (!this.known) {
      try {
        const list = JSON.parse(this.store.getKv(INBOX_KEY)?.value ?? "[]") as unknown;
        this.known = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
      } catch {
        this.known = new Set();
      }
    }
    return this.known;
  }

  private remember(sessionId: Id): void {
    const ids = this.ids();
    if (ids.has(sessionId)) return;
    ids.add(sessionId);
    this.store.setKv(INBOX_KEY, JSON.stringify([...ids]));
  }

  private forget(sessionId: Id): void {
    const ids = this.ids();
    if (!ids.delete(sessionId)) return;
    this.store.setKv(INBOX_KEY, JSON.stringify([...ids]));
  }

  /** session_send's own queue (kv `sessions.peer-queue`), left by a Host before the inbox: its texts become held rows. */
  private migratePeerQueue(): void {
    const kv = this.store.getKv(PEER_QUEUE_KEY);
    if (!kv?.value) return;
    let queue: Record<Id, string[]> = {};
    try {
      queue = JSON.parse(kv.value) as Record<Id, string[]>;
    } catch {
      // Unreadable: nothing to move.
    }
    for (const [sessionId, texts] of Object.entries(queue)) {
      const s = this.store.getSession(sessionId);
      if (!s || s.archivedAt || !Array.isArray(texts)) continue;
      for (const text of texts) if (typeof text === "string" && text.trim()) this.append(s, text);
      this.remember(sessionId);
    }
    this.store.setKv(PEER_QUEUE_KEY, "");
  }
}

/** Free for a message of an agent's: not in a turn or waiting on the person, and Studio may write to it. */
function free(s: Session): boolean {
  return !BUSY_STATUSES.includes(s.status) && (s.writer === "workbench" || s.writer === "terminal-shared");
}
