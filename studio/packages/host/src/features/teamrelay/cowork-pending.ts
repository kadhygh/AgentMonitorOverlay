import type { Id, PendingEntry, PendingGroup } from "@amo-studio/protocol";
import { pendingItemKey, type Cowork, type PendingItem, type RelayClient } from "@amo-studio/relay/light";
import type { PendingFeature, PendingSource, PendingWhy } from "../pending/service.js";
import { partyName } from "./cowork-matters-text.js";
import { pendingGroupId, type TeamCowork } from "./cowork.js";

// 待我处理 from the 协作 (2026-11-24, plans/collab-framework.md「11-24」第 5 步): a source of features/pending. The service
// keeps each participant's list (GET /api/cowork/pending, protocol/matters.ts pendingFor); this reads the person's own (one
// group per 协作, long-polled so the Focus row and the page move as it changes) and each 主控 session's here (read on the
// patrol's tick: the patrol wakes it with what is new, in the wake message of plans/collab-agent-spec.md §2). 执行会话 are
// not patrolled: what is for them comes as deliveries (an @ in their 事项). An older service (no 事项) gives no groups.

/** The person's list waits this long for a change per poll (the service holds it at most COWORK_INBOX_MAX_WAIT). */
const PERSON_WAIT_MS = 25_000;

export class CoworkPendingSource implements PendingSource {
  readonly source = "cowork";
  /** coworkId → my own items. */
  private person = new Map<string, PendingItem[]>();
  /** `<coworkId> <mark>` → that agent's items, with its session. */
  private agents = new Map<string, { coworkId: string; mark: string; sessionId: Id; items: PendingItem[] }>();
  /** coworkId → the 协作 as last read (titles, 事项, agents' names). */
  private coworks = new Map<string, Cowork>();
  private problemText: string | null = null;
  private version = -1;
  private running = false;
  private abort: AbortController | null = null;
  /** Tests: shorter waits. */
  waitMs = { person: PERSON_WAIT_MS, failed: 30_000 };

  constructor(
    private readonly cowork: TeamCowork,
    private readonly pending: PendingFeature,
  ) {}

  problem(): string | null {
    return this.problemText;
  }

  groups(): PendingGroup[] {
    const out: PendingGroup[] = [];
    for (const [coworkId, items] of this.person) {
      const c = this.coworks.get(coworkId);
      if (!c || !items.length) continue;
      out.push({ source: this.source, id: pendingGroupId(coworkId, "me"), title: `协作「${c.title}」`, for: { kind: "person" }, items: items.map((i) => this.entry(c, i, null)), canMark: true });
    }
    for (const a of this.agents.values()) {
      const c = this.coworks.get(a.coworkId);
      if (!c) continue;
      const name = c.agents.find((x) => x.mark === a.mark)?.name ?? a.mark;
      out.push({ source: this.source, id: pendingGroupId(a.coworkId, a.mark), title: `协作「${c.title}」`, note: `${name} 的待处理`, for: { kind: "session", sessionId: a.sessionId }, items: a.items.map((i) => this.entry(c, i, a.sessionId)), canMark: true });
    }
    return out;
  }

  private entry(c: Cowork, i: PendingItem, sessionId: Id | null): PendingEntry {
    const m = i.matter ? c.matters?.find((x) => x.id === i.matter) : undefined;
    const target = m ? `thread:${m.id}` : `cowork:${c.id}`;
    const session = sessionId ? this.cowork.store.getSession(sessionId) : undefined;
    return {
      key: pendingItemKey(i),
      kind: i.kind,
      text: i.text,
      since: i.since,
      matter: m ? { id: m.id, no: m.no, title: m.title, status: m.status } : null,
      seq: i.seq,
      ...(m && i.kind === "waiting" && m.history.length ? { from: partyName(m.history[m.history.length - 1]!.by, c) } : {}),
      open: sessionId && session ? { kind: "session", sessionId, taskId: session.taskId } : { kind: "relay", target },
    };
  }

  // ---- reading

  /** The person's list (all 协作) and each 主控 session's here, once. */
  async refresh(): Promise<void> {
    if (!this.cowork.signedIn()) {
      this.problemText = null;
      this.clear();
      return;
    }
    if (!(await this.cowork.hasMatters())) {
      // An older service: no 待我处理 there (the 协作 still works the old way).
      this.problemText = null;
      this.clear();
      return;
    }
    const { client } = this.cowork.relayLogin();
    try {
      const mine = await client.coworkPending({});
      this.takePerson(mine.lists, mine.version);
      await this.readCoworks(client, [...new Set([...mine.lists.map((l) => l.coworkId), ...this.cowork.joined().map((j) => j.coworkId)])]);
      const next = new Map<string, { coworkId: string; mark: string; sessionId: Id; items: PendingItem[] }>();
      // 主控 and 未分角色 (they work as before: as a 主控); not 执行.
      for (const j of this.cowork.joined()) {
        if (j.ended || j.role === "worker") continue;
        const items = await this.cowork.agentPending(client, j.coworkId, j.mark).catch(() => null);
        if (items === null) continue;
        next.set(`${j.coworkId} ${j.mark}`, { coworkId: j.coworkId, mark: j.mark, sessionId: j.sessionId, items });
      }
      this.agents = next;
      this.cowork.notePending(new Map([...next].map(([k, v]) => [k, v.items.length])));
      this.problemText = null;
    } catch (err) {
      this.problemText = `读不到协作的待我处理：${err instanceof Error ? err.message : String(err)}`;
    }
    this.pending.changed();
  }

  private clear(): void {
    this.person.clear();
    this.agents.clear();
    this.pending.changed();
  }

  private takePerson(lists: Array<{ coworkId: string; items: PendingItem[] }>, version: number): void {
    this.person = new Map(lists.map((l) => [l.coworkId, l.items]));
    this.version = version;
  }

  private async readCoworks(client: RelayClient, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const list = await client.coworks();
    for (const c of list) if (ids.includes(c.id)) this.coworks.set(c.id, c);
  }

  /** The person's list, long-polled (a change shows on the page and in Focus at once, not at the next patrol). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.cowork.signedIn() || !(await this.cowork.hasMatters())) {
          await sleep(this.waitMs.failed);
          continue;
        }
        const { client } = this.cowork.relayLogin();
        this.abort = new AbortController();
        const out = await client.coworkPending({ since: this.version, wait: this.waitMs.person }, { signal: this.abort.signal });
        if (out.version !== this.version) {
          this.takePerson(out.lists, out.version);
          await this.readCoworks(client, out.lists.map((l) => l.coworkId)).catch(() => undefined);
          this.pending.changed();
        }
      } catch {
        if (this.running) await sleep(this.waitMs.failed);
      }
    }
  }

  // ---- marking and waking

  async mark(group: PendingGroup, keys: string[], mark: "seen" | "handled"): Promise<void> {
    const items = group.items.filter((i) => keys.includes(i.key));
    const coworkId = group.id.split(":")[1]!;
    const party = group.id.slice(`cowork:${coworkId}:`.length);
    const seqs = items.flatMap((i) => (i.seq ? [i.seq] : []));
    const { client } = this.cowork.relayLogin();
    const via = party === "me" ? undefined : this.cowork.viaOf(party);
    if (seqs.length) await client.markCowork(coworkId, { mark, seqs, ...(via ? { via } : {}) });
    // A 事项 waiting on someone is theirs until its 主控 changes it: marking its messages is all that can be done here.
    for (const i of items.filter((x) => !x.seq && x.matter)) await client.markCowork(coworkId, { mark, matter: i.matter!.id, ...(via ? { via } : {}) });
  }

  async wake(sessionId: Id, group: PendingGroup, entries: PendingEntry[], why: PendingWhy): Promise<boolean> {
    const coworkId = group.id.split(":")[1]!;
    const a = [...this.agents.values()].find((x) => x.coworkId === coworkId && x.sessionId === sessionId);
    if (!a) return true;
    const keys = new Set(entries.map((e) => e.key));
    const items = a.items.filter((i) => keys.has(pendingItemKey(i)));
    if (!items.length) return true;
    return this.cowork.wakeFor(sessionId, coworkId, a.mark, items, why);
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

