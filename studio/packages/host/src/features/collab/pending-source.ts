import { LOCAL_PERSON, MATTER_STATUS_LABEL, inTurn, pendingItemKey, sessionParty, type Id, type MailMessage, type MessageOrigin, type PendingEntry, type PendingGroup, type PendingItem, type Session } from "@amo-studio/protocol";
import { roleFacts } from "../../core/role.js";
import type { PendingFeature, PendingSource, PendingWhy } from "../pending/service.js";
import type { LocalMatters } from "./matters.js";
import type { SessionInbox } from "../sessions/inbox.js";

// 待我处理 from this computer (2026-11-25, plans/collab-framework.md「Studio 里「待我处理」的接口」, source "local"): the
// person's own group — messages waiting to be let in (先问, or an agent's that did not go in by itself) and what pendingFor
// finds for `person:me` in the Host's 事项 — and one group per 主控 session here (任务主控 or a topic's own session):
// messages to it not 处理了, 事项 waiting on it. Messages that already went into a session's conversation (auto by
// distance) are marked told at once, so the patrol wakes a 主控 only for what it has not seen in its conversation: a 事项
// that started waiting on it, a message still waiting for the person to let it in.

export const LOCAL_SOURCE = "local";
const PERSON_GROUP = `${LOCAL_SOURCE}:me`;
const sessionGroup = (sessionId: Id) => `${LOCAL_SOURCE}:session:${sessionId}`;

/** What a key stands for, to mark it. */
type Target = { mail?: MailMessage; matter?: Id; ask?: boolean };

const hm = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export class LocalPendingSource implements PendingSource {
  readonly source = LOCAL_SOURCE;
  /** group id → key → what it is (filled by groups()). */
  private targets = new Map<string, Map<string, Target>>();
  private scheduled = false;

  constructor(
    private readonly matters: LocalMatters,
    private readonly pending: PendingFeature,
    private readonly deps: { inbox: Pick<SessionInbox, "put">; dropAsk(mail: MailMessage): void },
  ) {}

  async refresh(): Promise<void> {
    this.noteDelivered(this.groups());
  }

  /** Something moved (a message, a 事项, a session): the snapshot is made again once this tick is over. */
  poke(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pending.changed();
      this.noteDelivered(this.pending.snapshot().groups);
    });
  }

  groups(): PendingGroup[] {
    this.targets = new Map();
    const out: PendingGroup[] = [];
    const view = this.matters.pendingView();
    const person = new Map<string, Target>();
    const items: PendingEntry[] = [];
    for (const m of view.asks) {
      const key = `ask:${m.id}`;
      person.set(key, { mail: m, ask: true });
      const matter = m.matter ? this.matters.get(m.matter) : undefined;
      items.push({ key, kind: "message", text: `#${m.seq} ${m.ask ? "等你放行" : "没送进对话"}：${oneLine(m.text)}`, since: Date.parse(m.createdAt), matter: matter ? { id: matter.id, no: matter.no, title: matter.title, status: matter.status } : null, seq: m.seq ?? null, from: this.fromName(m), open: { kind: "here" } });
    }
    for (const i of view.pending) {
      if (i.seq !== null && view.asks.some((a) => a.seq === i.seq)) continue;
      const key = pendingItemKey(i);
      person.set(key, this.targetOf(i));
      items.push(this.entry(i, { kind: "here" }));
    }
    this.targets.set(PERSON_GROUP, person);
    if (items.length) out.push({ source: this.source, id: PERSON_GROUP, title: "本机", note: "会话之间的留言、传话、派活和结果", for: { kind: "person" }, items: items.sort((a, b) => b.since - a.since), canMark: true });

    for (const s of this.leads()) {
      const list = this.matters.pendingOf(s.id);
      if (!list.length) continue;
      const id = sessionGroup(s.id);
      const map = new Map<string, Target>();
      for (const i of list) map.set(pendingItemKey(i), this.targetOf(i));
      this.targets.set(id, map);
      out.push({ source: this.source, id, title: `会话「${firstLine(s.title)}」`, note: "本机的主控", for: { kind: "session", sessionId: s.id }, items: list.map((i) => this.entry(i, { kind: "session", sessionId: s.id, taskId: s.taskId })), canMark: true });
    }
    return out;
  }

  /**
   * The sessions patrolled here: 任务主控 and topics' own sessions that take part in an open 事项. Their messages already in
   * their conversation are told (the patrol does not wake them for those again).
   */
  private leads(): Session[] {
    const ids = new Set<Id>();
    for (const m of this.matters.store.listMatters({ open: true })) {
      for (const p of [m.owner, ...m.waitingOn]) if (p.startsWith("agent:")) ids.add(p.slice(6));
      for (const sid of m.bindings.sessions) ids.add(sid);
      for (const mail of this.matters.store.listMailInMatter(m.id)) for (const r of mail.receipts ?? []) if (r.party.startsWith("agent:")) ids.add(r.party.slice(6));
    }
    const out: Session[] = [];
    for (const id of ids) {
      const s = this.matters.store.getSession(id);
      if (!s || s.archivedAt || s.kind !== "main") continue;
      try {
        const f = roleFacts(this.matters, id);
        if (f.taskLead || f.role === "topic") out.push(s);
      } catch {
        // A session gone meanwhile.
      }
    }
    return out;
  }

  /** After the snapshot changed: what already went into each 主控's conversation is told. */
  private noteDelivered(groups: readonly PendingGroup[]): void {
    for (const g of groups) {
      if (g.source !== this.source || g.for.kind !== "session") continue;
      const party = sessionParty(g.for.sessionId);
      const map = this.targets.get(g.id);
      const inside = g.items.filter((i) => {
        const mail = map?.get(i.key)?.mail;
        const r = mail?.receipts?.find((x) => x.party === party);
        return !!r && r.state !== "queued";
      });
      if (inside.length) this.pending.told(g.for.sessionId, g.id, inside.map((i) => i.key));
    }
  }

  private targetOf(i: PendingItem): Target {
    if (i.seq === null) return { ...(i.matter ? { matter: i.matter } : {}) };
    try {
      return { mail: this.matters.bySeq(i.seq), ...(i.matter ? { matter: i.matter } : {}) };
    } catch {
      return {};
    }
  }

  private entry(i: PendingItem, open: PendingEntry["open"]): PendingEntry {
    const m = i.matter ? this.matters.get(i.matter) : undefined;
    const mail = i.seq !== null ? this.safeSeq(i.seq) : undefined;
    return { key: pendingItemKey(i), kind: i.kind, text: i.text, since: i.since, matter: m ? { id: m.id, no: m.no, title: m.title, status: m.status } : null, seq: i.seq, ...(mail ? { from: this.fromName(mail) } : i.why.by ? { from: this.partyName(i.why.by) } : {}), open };
  }

  private safeSeq(seq: number): MailMessage | undefined {
    try {
      return this.matters.bySeq(seq);
    } catch {
      return undefined;
    }
  }

  private fromName(m: MailMessage): string {
    if (!m.fromSessionId) return "我";
    return this.partyName(sessionParty(m.fromSessionId));
  }

  private partyName(p: string): string {
    if (p === LOCAL_PERSON || p.startsWith("person:")) return "我";
    const s = this.matters.store.getSession(p.slice(6));
    if (!s) return "会话";
    const task = s.taskId ? this.matters.store.getTask(s.taskId) : undefined;
    return task ? `${firstLine(task.title)} · ${firstLine(s.title)}` : firstLine(s.title);
  }

  async mark(group: PendingGroup, keys: string[], mark: "seen" | "handled"): Promise<void> {
    const map = this.targets.get(group.id);
    const session = group.for.kind === "session" ? this.matters.store.getSession(group.for.sessionId) : undefined;
    const party = session ? sessionParty(session.id) : LOCAL_PERSON;
    for (const key of keys) {
      const t = map?.get(key);
      if (!t) continue;
      if (t.mail) {
        // A message waiting to be let in: 处理了 here is 「不送」.
        if (t.ask) {
          if (mark === "handled") this.deps.dropAsk(t.mail);
          continue;
        }
        if (session) {
          if (mark === "handled") this.matters.markHandledBy(session, [t.mail.seq]);
        } else this.matters.markByPerson([t.mail.id], mark);
      } else if (t.matter && mark === "handled") {
        // A 事项 waiting on them: they are done with it (it no longer waits on them).
        const m = this.matters.get(t.matter);
        if (m) this.matters.update(m.id, { waitingOn: m.waitingOn.filter((p) => p !== party) }, party);
      }
    }
    this.poke();
  }

  /** The patrol (or 「现在看一遍」): what waits on a 主控 here, as one message (plans/collab-agent-spec.md §2's shape). */
  async wake(sessionId: Id, _group: PendingGroup, items: PendingEntry[], why: PendingWhy): Promise<boolean> {
    const s = this.matters.store.getSession(sessionId);
    if (!s || s.archivedAt || inTurn(s.status)) return false;
    const lines = [
      `【本机 · 待你处理】`,
      `为什么现在叫你：${why.kind === "patrol" ? `巡检 ${hm(why.at)} 发现有变化` : "人让你现在看一遍"}`,
      `待你处理（${items.length}）：`,
      ...items.map((i) =>
        i.seq === null && i.matter
          ? `- 事项 ${i.matter.no}「${i.matter.title}」· ${MATTER_STATUS_LABEL[i.matter.status]} · 在等你${i.from ? `（${i.from}）` : ""}`
          : `- #${i.seq}${i.from ? ` ${i.from}` : ""}${i.matter ? `（事项 ${i.matter.no}）` : ""}：${i.text.replace(/^#\d+\s*/, "")}`,
      ),
      "这一轮结束前：回过的（mailbox_send 带 replyTo）会自动标成处理了；没回但已经处理的用 mailbox_read 带 handled 标；只是「收到」的不要回，标处理了就行。",
    ];
    const origin: MessageOrigin = { kind: "mail", from: why.kind === "patrol" ? "巡检" : "我" };
    await this.deps.inbox.put(sessionId, lines.join("\n"), origin);
    return true;
  }
}

function firstLine(title: string | null | undefined): string {
  const line = (title || "").split("\n").map((l) => l.trim()).find((l) => l && !/^【.*】$/.test(l)) ?? "";
  if (!line) return "未命名";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

function oneLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
