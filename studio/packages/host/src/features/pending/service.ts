import { inTurn, PATROL_MS, type Id, type PendingEntry, type PendingGroup, type PendingMarkRequest, type PendingPatrolResult, type PendingSnapshot } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";

// 待我处理 (2026-11-24, plans/collab-framework.md「11-24」第 5 步; protocol/src/pending.ts): one list gathered from sources —
// 协作 on AMO 中转 (teamrelay's cowork-pending.ts, source "cowork") and this computer's own 事项 and mail (source "local").
// A source registers here and says when its groups changed; this feature keeps the snapshot the workbench's 待我处理 page and
// the Focus row read, and runs the patrol (巡检): every PATROL_MS it has each source read again, and for each session's
// group (a 主控's list) wakes the session with only what is new since it was last told — once its turn is over when it is
// in one (原型补的第 2 条). 「让主控现在看一遍」 (patrol()) wakes with the whole list, new or not.

/** Why the session is woken: the patrol found something new, or the person asked. */
export type PendingWhy = { kind: "patrol"; at: number } | { kind: "manual"; at: number };

/** What a source gives (features register one: PendingFeature.register). */
export interface PendingSource {
  readonly source: string;
  /** Its groups as it last read them (cheap: called on every change). */
  groups(): PendingGroup[];
  /** Read again (the patrol's tick, 让主控现在看一遍). It calls PendingFeature.changed() itself when something moved. */
  refresh?(): Promise<void>;
  /** One line when it cannot read now (signed out, 中转 unreachable), else null. */
  problem?(): string | null;
  /** 看过 / 处理了 for items of one of its groups. */
  mark?(group: PendingGroup, keys: string[], mark: "seen" | "handled"): Promise<void>;
  /**
   * Put these items into the session as one message (the patrol found them new, or the person asked). false: not now
   * (the session is busy or someone is at it): the patrol tries again when the session is free.
   */
  wake?(sessionId: Id, group: PendingGroup, items: PendingEntry[], why: PendingWhy): Promise<boolean>;
}

/** Per `<sessionId> <groupId>`: the item keys the session was last told (woken with, or put in by a source's own delivery). */
const TOLD_KEY = "pending.told";

export class PendingFeature extends Feature {
  private readonly sources = new Map<string, PendingSource>();
  private snap: PendingSnapshot = { groups: [], mine: 0, version: 0, problems: [] };
  private snapKey = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Sessions to wake once their turn is over: what for. */
  private readonly due = new Map<Id, PendingWhy>();
  private ticking: Promise<void> | null = null;
  /** Tests: a shorter patrol. */
  patrolMs = PATROL_MS;

  register(source: PendingSource): void {
    this.sources.set(source.source, source);
    this.changed();
  }

  snapshot(): PendingSnapshot {
    return this.snap;
  }

  /** A source's groups changed (or may have): the snapshot is made again, and published when it differs. */
  changed(): void {
    const groups: PendingGroup[] = [];
    const problems: PendingSnapshot["problems"] = [];
    for (const s of this.sources.values()) {
      try {
        groups.push(...s.groups());
      } catch (err) {
        problems.push({ source: s.source, text: err instanceof Error ? err.message : String(err) });
      }
      const p = s.problem?.();
      if (p) problems.push({ source: s.source, text: p });
    }
    groups.sort((a, b) => (a.for.kind === b.for.kind ? 0 : a.for.kind === "person" ? -1 : 1));
    const key = JSON.stringify([groups, problems]);
    if (key === this.snapKey) return;
    this.snapKey = key;
    const mine = groups.filter((g) => g.for.kind === "person").reduce((n, g) => n + g.items.length, 0);
    this.snap = { groups, mine, version: this.snap.version + 1, problems };
    this.publish({ type: "pending.changed", snapshot: this.snap });
  }

  /** The items of the session's own groups (its 待我处理: a 主控's), for the session's 协作 line and amo_whoami. */
  forSession(sessionId: Id): PendingGroup[] {
    return this.snap.groups.filter((g) => g.for.kind === "session" && g.for.sessionId === sessionId);
  }

  async mark(req: PendingMarkRequest): Promise<PendingSnapshot> {
    const group = this.snap.groups.find((g) => g.id === req?.group);
    if (!group) throw new HostError("not_found", "待我处理里没有这一组了（可能刚处理完）");
    if (req.mark !== "seen" && req.mark !== "handled") throw new HostError("bad_request", "mark 要是 seen 或 handled");
    const keys = Array.isArray(req.keys) ? req.keys.filter((k): k is string => typeof k === "string") : [];
    if (!keys.length) throw new HostError("bad_request", "keys 不能为空");
    const source = this.sources.get(group.source);
    if (!source?.mark || !group.canMark) throw new HostError("bad_request", `「${group.title}」的事项不能在这里标`);
    await source.mark(group, keys, req.mark);
    await source.refresh?.().catch(() => undefined);
    this.changed();
    return this.snap;
  }

  // ---- what each session was told

  private toldAll(): Record<string, string[]> {
    try {
      return JSON.parse(this.store.getKv(TOLD_KEY)?.value ?? "{}") as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  /** The session was told these items of the group (by a wake, or by its source's own delivery: an @ put in at once). */
  told(sessionId: Id, groupId: string, keys: readonly string[], replace = false): void {
    const all = this.toldAll();
    const k = `${sessionId} ${groupId}`;
    const next = replace ? [...new Set(keys)] : [...new Set([...(all[k] ?? []), ...keys])];
    if (JSON.stringify(next) === JSON.stringify(all[k] ?? [])) return;
    if (next.length) all[k] = next;
    else delete all[k];
    this.store.setKv(TOLD_KEY, JSON.stringify(all));
  }

  /** What in the group the session was not told yet. */
  fresh(sessionId: Id, group: PendingGroup): PendingEntry[] {
    const was = new Set(this.toldAll()[`${sessionId} ${group.id}`] ?? []);
    return group.items.filter((i) => !was.has(i.key));
  }

  // ---- the patrol

  start(): void {
    if (this.running) return;
    this.running = true;
    this.host.on("event", (e) => {
      if (!this.running || e.type !== "session.upserted" || !this.due.has(e.session.id)) return;
      if (!inTurn(e.session.status) && e.session.status !== "awaiting-review") void this.wakeDue(e.session.id, true);
    });
    this.timer = setInterval(() => void this.tick(), this.patrolMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One patrol: every source reads again; each session's group wakes it for what is new. */
  tick(): Promise<void> {
    this.ticking ??= this.patrolOnce().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async patrolOnce(): Promise<void> {
    for (const s of this.sources.values()) await s.refresh?.().catch((err: unknown) => this.log(`pending: ${s.source} could not read: ${err instanceof Error ? err.message : String(err)}`));
    this.changed();
    const at = Date.now();
    for (const sessionId of this.sessionsWithGroups()) {
      const groups = this.forSession(sessionId);
      // What went away (handled, the 事项 closed) leaves what it was told: told again when it comes back.
      for (const g of groups) {
        const now = new Set(g.items.map((i) => i.key));
        const was = this.toldAll()[`${sessionId} ${g.id}`] ?? [];
        if (was.some((k) => !now.has(k))) this.told(sessionId, g.id, was.filter((k) => now.has(k)), true);
      }
      if (groups.some((g) => this.fresh(sessionId, g).length)) await this.wakeOrLater(sessionId, { kind: "patrol", at }, false);
    }
    for (const sessionId of [...this.due.keys()]) await this.wakeDue(sessionId);
  }

  private sessionsWithGroups(): Id[] {
    return [...new Set(this.snap.groups.flatMap((g) => (g.for.kind === "session" ? [g.for.sessionId] : [])))];
  }

  /**
   * Wakes the session with its groups' items — only those it was not told (`all` false) or all of them (the person asked).
   * Returns whether it went in now; otherwise it is due once the session is free.
   */
  private async wakeOrLater(sessionId: Id, why: PendingWhy, all: boolean): Promise<"woke" | "later" | "empty"> {
    const groups = this.forSession(sessionId);
    let any = false;
    let later = false;
    for (const g of groups) {
      const items = all ? g.items : this.fresh(sessionId, g);
      if (!items.length) continue;
      any = true;
      const source = this.sources.get(g.source);
      if (!source?.wake) continue;
      const s = this.store.getSession(sessionId);
      if (!s || s.archivedAt) continue;
      const went = inTurn(s.status) || s.status === "awaiting-review" ? false : await source.wake(sessionId, g, items, why).catch((err: unknown) => (this.log(`pending: waking ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`), false));
      if (went) this.told(sessionId, g.id, g.items.map((i) => i.key), true);
      else later = true;
    }
    if (later) {
      this.due.set(sessionId, this.due.get(sessionId) ?? why);
      return "later";
    }
    this.due.delete(sessionId);
    return any ? "woke" : "empty";
  }

  /**
   * `reread`: the turn it was in just ended — what it handled in that turn (answered, marked) leaves its list only once
   * the sources read again; woken from the list as it was when the patrol noted it, it got items it had already dealt
   * with (the 11-25 real-model run: a 主控 replied to #13 in its turn, was woken for #13 right after, found nothing to do).
   */
  private async wakeDue(sessionId: Id, reread = false): Promise<void> {
    const why = this.due.get(sessionId);
    if (!why) return;
    this.due.delete(sessionId);
    if (reread) {
      for (const s of this.sources.values()) await s.refresh?.().catch(() => undefined);
      this.changed();
    }
    await this.wakeOrLater(sessionId, why, why.kind === "manual");
  }

  /** 让主控现在看一遍: those sessions (or every session with a group) read again and woken with their whole list. */
  async patrol(sessionIdsValue?: unknown): Promise<PendingPatrolResult> {
    const asked = Array.isArray(sessionIdsValue) ? sessionIdsValue.filter((x): x is Id => typeof x === "string") : null;
    for (const s of this.sources.values()) await s.refresh?.().catch(() => undefined);
    this.changed();
    const out: PendingPatrolResult = { woke: [], later: [], empty: [] };
    const at = Date.now();
    for (const sessionId of asked?.length ? asked : this.sessionsWithGroups()) {
      const r = await this.wakeOrLater(sessionId, { kind: "manual", at }, true);
      (r === "woke" ? out.woke : r === "later" ? out.later : out.empty).push(sessionId);
    }
    return out;
  }
}
