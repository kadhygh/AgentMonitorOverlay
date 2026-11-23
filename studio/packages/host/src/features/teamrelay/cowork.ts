import { inTurn, refId, sessionRefText, type CoworkChoice, type CoworkHandoff, type CoworkJoin, type Id, type MessageOrigin, type Session } from "@amo-studio/protocol";
import { AGENT_REPORT_MS, BOARD_AI_MAX_CARDS, filesAsText, threadAsText, type AgentReport, type BoardItem, type BoardOp, type Cowork, type CoworkDelivery, type CoworkInbox, type CoworkInboxItem, type Message, type RelayClient, type RelayFile, type Thread, type Via } from "@amo-studio/relay/light";
import { Feature, type FeatureHost } from "../../core/feature.js";
import { HostError, isRemoteCopy } from "../../core/shared.js";
import { coworkHint, coworkTold, resetCoworkTold, setCoworkTell } from "../../core/cowork.js";
import { beforeText, boardOpsText, boardText, concludedText, COWORK_BRIEF, coworkOverview, type CoworkFiles, deliveryFrom, deliveryText, deliveryWhere, joinedLine, messagesSection, oneMessageText, postResultText, sessionText } from "./cowork-text.js";
import type { TeamRelayFeature } from "./service.js";
import { findRelayClient, relayClientLaunch, relayTarget, startRelayClient, type RelayClientFound, type RelayClientLaunch } from "./relay-client.js";

// 协作 (cowork, 2026-11-23, plans/cowork.md 第 4 步): Studio's end of a 协作 on AMO 中转 (relay/src/cowork-protocol.ts tells
// how the service runs it). The person brings a session in (拉进协作); from then on its agent may speak there as their
// AI — that is the authority, nothing it posts waits for the person here (the service keeps an @ or a new 子会话 as a
// draft while 「AI 发起 @ 和提问」 is off, and the person decides those in 中转). This Host:
// - reports every such agent's state to the service at least every AGENT_REPORT_MS (and when it changes): 处理中 while
//   its session runs, 等主人 while it waits on the person (an approval, a question, a draft, words in its composer), else
//   待命; gone or archived: 不在线, and it leaves.
// - takes what is for its agents (they were @-ed, or someone answered a 子会话 they started) from /api/cowork-inbox and
//   puts it into the session's inbox only once the session is 待命 — never into a running turn or under the person's
//   hands (交流框架 rule 5); then acks it (已送达). Folded in the conversation as one row (origin `cowork`).
// - gives the agent cowork_read / post / ask / board / note (cowork-mcp.ts), with its session's mark as `via.conv`.
// - takes 转到我的会话 from the 中转 client on this computer: a 子会话 handed to a session here (or a new one).
// The teamrelay scan (service.ts) leaves 子会话 alone (request.coworkId): what comes back in them comes only this way.

const JOINED_KEY = "teamrelay.cowork.joined";
const HANDOFFS_KEY = "teamrelay.cowork.handoffs";
/** Per agent (`<coworkId> <mark>`), the last seq cowork_read showed it. */
const READ_KEY = "teamrelay.cowork.read";
const VIA_CLIENT = "AMO Studio";
/** Words in a composer count this long after the workbench last said so (it says so every minute while they are there). */
export const COMPOSER_FRESH_MS = 3 * 60_000;
/** A handoff not taken is put away after this long. */
const HANDOFF_KEEP_MS = 3600_000;
/** cowork_read lists the files of the 群聊 and of the latest this many 子会话. */
const FILE_SESSIONS = 20;
/** The service's pages: GET …/feed gives at most this many messages, a thread's GET …/messages this many (relay server.ts). */
const FEED_PAGE = 500;
const THREAD_PAGE = 200;
/** Reading back (cowork_read before, an @'s 前文): at most this many messages, and this many calls to the service. */
const BACK_MAX = 80;
const BACK_CALLS = 12;

export class TeamCowork extends Feature<"config" | "sessions" | "attachments" | "tasks"> {
  constructor(
    host: FeatureHost<"config" | "sessions" | "attachments" | "tasks">,
    /** The feature this is part of: its 中转 client as the person, and its sends waiting for the person. */
    private readonly team: TeamRelayFeature,
  ) {
    super(host);
  }

  private running = false;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Wakes the inbox loop's pause early: a session got free, a composer emptied. */
  private wake: (() => void) | null = null;
  private reportSoon: ReturnType<typeof setTimeout> | null = null;
  /** Sessions whose composer has words, and when the workbench last said so. In memory: after a restart nobody types. */
  private readonly composer = new Map<Id, number>();
  /** Deliveries put into their session whose ack did not go through yet: acked again, never put in twice. */
  private readonly unacked = new Set<string>();
  /** Per agent (`<coworkId> <mark>`): the cards' text versions it last read (cowork_board fills `base` from it). */
  private readonly boardSeen = new Map<string, Map<string, number>>();
  /** What was last reported per mark (a change reports at once; the same is said again every AGENT_REPORT_MS). */
  private readonly lastState = new Map<string, CoworkJoin["state"]>();
  /** Tests: shorter pauses. */
  pauseMs = { signedOut: 10_000, failed: 30_000, wait: 25_000, held: 15_000, report: AGENT_REPORT_MS };

  // ---- who and where

  private relay(): { client: RelayClient; me: string; prefix: string } {
    return this.team.relayLogin();
  }

  private via(mark: string): Via {
    return { kind: "ai", client: VIA_CLIENT, conv: mark };
  }

  private call<T>(run: () => Promise<T>): Promise<T> {
    return this.team.relayCall(run);
  }

  // ---- the sessions in 协作

  joined(): CoworkJoin[] {
    try {
      return JSON.parse(this.store.getKv(JOINED_KEY)?.value ?? "[]") as CoworkJoin[];
    } catch {
      return [];
    }
  }

  private saveJoined(next: CoworkJoin[]): void {
    const value = JSON.stringify(next);
    if (value === (this.store.getKv(JOINED_KEY)?.value ?? "[]")) return;
    this.store.setKv(JOINED_KEY, value);
    this.publish({ type: "cowork.joined.changed", joined: next });
  }

  /** The 协作 the person is in, for 拉进协作. */
  async coworks(): Promise<{ me: string; coworks: CoworkChoice[] }> {
    const { client, me } = this.relay();
    const list = await this.call(() => client.coworks());
    return { me, coworks: list.map((c) => ({ id: c.id, title: c.title, goal: c.goal, repo: c.repo, branch: c.branch, members: c.members, agents: c.agents.map((a) => a.name), ended: c.endedAt !== null, updatedAt: c.updatedAt })) };
  }

  /** A session that can be in a 协作: one of this Host's own, a main session or a branch, not archived. */
  private joinable(sessionId: Id): Session {
    const s = this.store.getSession(sessionId);
    if (!s) throw new HostError("not_found", `没有会话 ${sessionId}`);
    if (s.archivedAt || s.writer === "archived") throw new HostError("read_only", "这个会话已归档，不能拉进协作");
    if (s.kind === "sub") throw new HostError("bad_request", "子 agent 不能单独拉进协作");
    if (isRemoteCopy(s)) throw new HostError("bad_request", "这是另一台电脑上的会话：在那台电脑的 Studio 里拉进协作");
    return s;
  }

  private sessionName(s: Session): string {
    return (s.title?.trim() || (s.taskId ? this.store.getTask(s.taskId)?.title : "") || "会话").slice(0, 60);
  }

  /** 拉进协作: the session joins the 协作 as its owner's AI; told so with the next message it gets. */
  async join(sessionIdValue: unknown, coworkIdValue: unknown, labelValue?: unknown): Promise<CoworkJoin> {
    const s = this.joinable(text(sessionIdValue, "sessionId"));
    const coworkId = text(coworkIdValue, "coworkId");
    const label = (typeof labelValue === "string" && labelValue.trim() ? labelValue.trim() : this.sessionName(s)).slice(0, 60);
    const { client, me, prefix } = this.relay();
    const mark = `${prefix}${s.id}`;
    const out = await this.call(() => client.joinCoworkAgent(coworkId, mark, label));
    setCoworkTell(this.store, s.id, `joined:${coworkId}`, joinedLine(out.cowork, out.agent.name, me));
    await this.refresh().catch(() => undefined);
    this.scheduleReport();
    const found = this.joined().find((j) => j.sessionId === s.id && j.coworkId === coworkId);
    return found ?? this.joinOf(out.cowork, out.agent.mark, prefix, 0);
  }

  /** 退出协作. */
  async leave(sessionIdValue: unknown, coworkIdValue: unknown): Promise<{ ok: true }> {
    const sessionId = text(sessionIdValue, "sessionId");
    const coworkId = text(coworkIdValue, "coworkId");
    const { client, prefix } = this.relay();
    await this.call(() => client.leaveCoworkAgent(coworkId, `${prefix}${sessionId}`));
    setCoworkTell(this.store, sessionId, `joined:${coworkId}`, null);
    setCoworkTell(this.store, sessionId, `unread:${coworkId}`, null);
    this.saveJoined(this.joined().filter((j) => !(j.sessionId === sessionId && j.coworkId === coworkId)));
    return { ok: true };
  }

  private joinOf(c: Cowork, mark: string, prefix: string, drafts: number): CoworkJoin {
    const a = c.agents.find((x) => x.mark === mark)!;
    const sessionId = mark.slice(prefix.length);
    return { coworkId: c.id, coworkTitle: c.title, sessionId, mark, label: a.label, name: a.name, state: this.lastState.get(mark) ?? this.stateOf(sessionId, mark, drafts), queued: a.queued, drafts, ended: c.endedAt !== null, joinedAt: a.joinedAt };
  }

  /** Reads which of this computer's sessions are in which 协作 again, from the service. */
  async refresh(): Promise<CoworkJoin[]> {
    const { client, me, prefix } = this.relay();
    const list = await client.coworks();
    const next: CoworkJoin[] = [];
    for (const c of list) {
      const mine = c.agents.filter((a) => a.owner === me && a.mark.startsWith(prefix));
      if (!mine.length) continue;
      const drafts = await client.coworkDrafts(c.id).catch(() => []);
      for (const a of mine) {
        const s = this.store.getSession(a.mark.slice(prefix.length));
        // Gone or archived: it cannot hear any more, so it leaves (what waits for it there is dropped).
        if (!s || s.archivedAt || s.writer === "archived") {
          await client.leaveCoworkAgent(c.id, a.mark).catch(() => undefined);
          continue;
        }
        next.push(this.joinOf(c, a.mark, prefix, drafts.filter((d) => d.agent === a.mark && d.state === "pending").length));
      }
    }
    this.saveJoined(next);
    return next;
  }

  // ---- state

  /** The workbench says whether the session's composer has words in it (POST /api/sessions/:id/composer). */
  composerSaid(sessionId: Id, hasText: boolean): void {
    const had = this.composer.has(sessionId);
    if (hasText) this.composer.set(sessionId, Date.now());
    else this.composer.delete(sessionId);
    if (had !== hasText && this.joined().some((j) => j.sessionId === sessionId)) {
      this.scheduleReport();
      if (!hasText) this.wake?.();
    }
  }

  private typing(sessionId: Id): boolean {
    const at = this.composer.get(sessionId);
    if (at === undefined) return false;
    if (Date.now() - at < COMPOSER_FRESH_MS) return true;
    this.composer.delete(sessionId);
    return false;
  }

  /**
   * What the session's agent is to the 协作 now: 处理中 while its turn runs; 等主人 while the turn waits on the person (an
   * approval, a question, a plan to review), it is in a terminal, it has a draft or a 中转 send waiting for the person, the
   * person stopped it, or their composer has words; else 待命. Gone or archived: 不在线.
   */
  stateOf(sessionId: Id, mark: string, drafts?: number): CoworkJoin["state"] {
    const s = this.store.getSession(sessionId);
    if (!s || s.archivedAt || s.writer === "archived") return "offline";
    if (s.status === "running") return "busy";
    if (inTurn(s.status) || s.status === "awaiting-review") return "owner";
    if (s.writer !== "workbench" && s.writer !== "terminal-shared") return "owner";
    const pendingDrafts = drafts ?? this.joined().filter((j) => j.mark === mark).reduce((n, j) => n + j.drafts, 0);
    if (pendingDrafts > 0) return "owner";
    if (this.team.sends().some((x) => x.sessionId === sessionId && x.state === "pending")) return "owner";
    if (this.f.sessions.inbox.isPaused(sessionId)) return "owner";
    if (this.typing(sessionId)) return "owner";
    return "idle";
  }

  /** Reports every agent's state (all of them: the service counts one unheard of for 90 s as 不在线). */
  async report(): Promise<void> {
    if (!this.teamLink.login()) return;
    const list = this.joined();
    if (!list.length) return;
    const { client } = this.relay();
    const byMark = new Map<string, CoworkJoin["state"]>();
    for (const j of list) byMark.set(j.mark, this.stateOf(j.sessionId, j.mark));
    const agents: AgentReport[] = [...byMark].map(([mark, state]) => ({ mark, state }));
    const back = await client.reportCoworkAgents(agents);
    for (const [mark, state] of byMark) this.lastState.set(mark, state);
    const queued = new Map(back.map((b) => [`${b.coworkId} ${b.agent.mark}`, b.agent.queued]));
    this.saveJoined(list.map((j) => ({ ...j, state: byMark.get(j.mark) ?? j.state, queued: queued.get(`${j.coworkId} ${j.mark}`) ?? j.queued })));
  }

  /** A state may have changed: report once things settle (a turn starting moves several fields at once). */
  private scheduleReport(): void {
    if (!this.running) return;
    if (this.reportSoon) clearTimeout(this.reportSoon);
    this.reportSoon = setTimeout(() => {
      this.reportSoon = null;
      void this.report().catch(() => undefined);
    }, 300);
    this.reportSoon.unref?.();
  }

  // ---- what comes for the agents

  start(): void {
    if (this.running) return;
    this.running = true;
    this.host.on("event", (e) => {
      if (!this.running || e.type !== "session.upserted") return;
      const mine = this.joined().some((j) => j.sessionId === e.session.id);
      if (!mine) return;
      const state = this.stateOf(e.session.id, this.joined().find((j) => j.sessionId === e.session.id)!.mark);
      const was = this.lastState.get(this.joined().find((j) => j.sessionId === e.session.id)!.mark);
      if (state !== was) this.scheduleReport();
      if (state === "idle") this.wake?.();
    });
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.pauseMs.report);
    this.timer.unref?.();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.reportSoon) clearTimeout(this.reportSoon);
    this.timer = null;
    this.abort?.abort();
    this.wake?.();
  }

  /** Every AGENT_REPORT_MS: who is in which 协作 (drafts too), then their states. */
  private async tick(): Promise<void> {
    if (!this.teamLink.login()) return;
    await this.refresh();
    await this.report();
  }

  private async loop(): Promise<void> {
    let first = true;
    while (this.running) {
      try {
        if (!this.teamLink.login()) {
          await this.pause(this.pauseMs.signedOut);
          continue;
        }
        if (first) {
          first = false;
          await this.tick().catch(() => undefined);
        }
        const { client, prefix } = this.relay();
        this.abort = new AbortController();
        const box = await client.coworkInbox(prefix, { waitMs: this.pauseMs.wait, signal: this.abort.signal });
        const left = await this.take(box);
        // Some wait for their session to get free: look again when one does, or in a while.
        if (left) await this.pause(this.pauseMs.held);
      } catch {
        if (this.running) await this.pause(this.pauseMs.failed);
      }
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.wake = done;
    });
  }

  /** One look at the inbox: puts what can go in now into its session; returns how many still wait. */
  async take(box: CoworkInbox): Promise<number> {
    const { client, me, prefix } = this.relay();
    this.noteUnread(box, prefix);
    const groups = new Map<string, CoworkInboxItem[]>();
    for (const it of box.items) {
      if (!it.delivery.agent.startsWith(prefix)) continue;
      const key = `${it.delivery.agent}\n${it.delivery.coworkId}`;
      groups.set(key, [...(groups.get(key) ?? []), it]);
    }
    let left = 0;
    for (const [key, items] of groups) {
      const [mark, coworkId] = key.split("\n") as [string, string];
      const sessionId = mark.slice(prefix.length);
      // Put in before, the ack lost: only the ack again.
      const again = items.filter((i) => this.unacked.has(i.delivery.id));
      if (again.length) await this.ack(client, again.map((i) => i.delivery.id));
      const fresh = items.filter((i) => !this.unacked.has(i.delivery.id) && !again.includes(i));
      if (!fresh.length) continue;
      const s = this.store.getSession(sessionId);
      if (!s || s.archivedAt || s.writer === "archived") {
        await client.leaveCoworkAgent(coworkId, mark).catch(() => undefined);
        continue;
      }
      if (this.stateOf(sessionId, mark) !== "idle") {
        left += fresh.length;
        continue;
      }
      const { cowork } = await this.call(() => client.cowork(coworkId));
      const agent = cowork.agents.find((a) => a.mark === mark);
      const unread = box.unread.find((u) => u.coworkId === coworkId && u.agent === mark)?.count ?? 0;
      // What it was to be told with the person's next message (brought in, N 条新的) goes with this instead.
      const hint = coworkHint(this.store, sessionId);
      const context = await this.context(client, coworkId, fresh).catch(() => [] as Message[]);
      const body = deliveryText({ items: fresh, cowork, me, myName: agent?.name ?? `${me} 的 AI`, mark, unread, lines: hint?.lines ?? [], context });
      const origin: MessageOrigin = { kind: "cowork", from: deliveryFrom(fresh, cowork), threadIds: [...new Set(fresh.map((i) => i.thread.id))], cowork: { id: cowork.id, title: cowork.title, where: deliveryWhere(fresh) } };
      try {
        await this.f.sessions.inbox.put(sessionId, body, origin);
      } catch (err) {
        this.log(`cowork: could not put into ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        left += fresh.length;
        continue;
      }
      hint?.told();
      if (unread) setCoworkTell(this.store, sessionId, `unread:${coworkId}`, null);
      for (const i of fresh) this.unacked.add(i.delivery.id);
      await this.ack(client, fresh.map((i) => i.delivery.id));
    }
    return left;
  }

  private async ack(client: RelayClient, ids: string[]): Promise<void> {
    try {
      await client.ackCowork(ids);
      for (const id of ids) this.unacked.delete(id);
    } catch {
      // Acked again with the next look (the long poll returns them while they are queued).
    }
  }

  /** 「协作里有 N 条新的」: said with the person's next message when the count went up since it was last said. */
  private noteUnread(box: CoworkInbox, prefix: string): void {
    const counts = new Map(box.unread.map((u) => [`${u.coworkId} ${u.agent}`, u]));
    for (const j of this.joined()) {
      if (!j.mark.startsWith(prefix)) continue;
      const key = `unread:${j.coworkId}`;
      const n = counts.get(`${j.coworkId} ${j.mark}`)?.count ?? 0;
      const told = coworkTold(this.store, j.sessionId, key);
      if (n === 0) {
        if (told) resetCoworkTold(this.store, j.sessionId, key);
        setCoworkTell(this.store, j.sessionId, key, null);
      } else if (n > told) {
        setCoworkTell(this.store, j.sessionId, key, `【协作】「${j.coworkTitle}」里有 ${n} 条新消息（没 @ 你，不用回）：和手上的事有关就用 cowork_read（coworkId ${j.coworkId}）看。`, n);
      }
    }
  }

  // ---- the agent's tools (cowork-mcp.ts)

  /** The caller's mark in the 协作 it names, or the only one it is in. */
  private mine(sessionId: Id, coworkIdValue: unknown): { coworkId: string; mark: string; join: CoworkJoin } {
    const { prefix } = this.relay();
    const mark = `${prefix}${sessionId}`;
    const list = this.joined().filter((j) => j.mark === mark);
    // A reference the person copied in the 中转 client (`cowork:<id>`, or the whole line) names it too (2026-11-23, 复制引用).
    const asked = typeof coworkIdValue === "string" && coworkIdValue.trim() ? refId(coworkIdValue, "cowork") : null;
    if (asked) {
      const j = list.find((x) => x.coworkId === asked);
      if (!j) throw new HostError("bad_request", `这个会话不在协作 ${asked} 里：cowork_* 只能读写这个会话被拉进的协作，要用它就请人先在 Studio 里把这个会话「拉进协作」（会话的「更多」菜单）${list.length ? `。它现在在：${list.map((x) => `「${x.coworkTitle}」（${x.coworkId}）`).join("、")}` : ""}。`);
      return { coworkId: j.coworkId, mark, join: j };
    }
    if (!list.length) throw new HostError("bad_request", "这个会话不在任何协作里：人要先在 Studio 里把它「拉进协作」（会话的「更多」菜单）。");
    if (list.length > 1) throw new HostError("bad_request", `这个会话在 ${list.length} 个协作里，要写 coworkId：${list.map((x) => `「${x.coworkTitle}」（${x.coworkId}）`).join("、")}`);
    return { coworkId: list[0]!.coworkId, mark, join: list[0]! };
  }

  private readAt(coworkId: string, mark: string): number {
    try {
      return Number((JSON.parse(this.store.getKv(READ_KEY)?.value ?? "{}") as Record<string, number>)[`${coworkId} ${mark}`]) || 0;
    } catch {
      return 0;
    }
  }

  private setReadAt(coworkId: string, mark: string, seq: number): void {
    let all: Record<string, number> = {};
    try {
      all = JSON.parse(this.store.getKv(READ_KEY)?.value ?? "{}") as Record<string, number>;
    } catch {
      // start again
    }
    all[`${coworkId} ${mark}`] = seq;
    this.store.setKv(READ_KEY, JSON.stringify(all));
  }

  /**
   * cowork_read: the 协作 and what is new since the agent last read; or one 子会话 (threadId); or one message in full (seq);
   * or the messages before a seq (before; with threadId, of that 子会话). Within COWORK_BRIEF's budgets (cowork-text.ts).
   */
  async read(sessionId: Id, input: { coworkId?: unknown; threadId?: unknown; after?: unknown; seq?: unknown; before?: unknown }): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client } = this.relay();
    const detail = await this.call(() => client.cowork(coworkId));
    const c = detail.cowork;
    const threadId = typeof input.threadId === "string" && input.threadId.trim() ? refId(input.threadId, "thread") : null;
    const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
    const forMe = this.forMe(detail.deliveries, mark);
    const seq = num(input.seq);
    if (seq) {
      const m = await this.messageAt(client, coworkId, seq);
      if (!m) throw new HostError("bad_request", `协作「${c.title}」里没有 #${seq}（#序号 见 cowork_read 列出的消息）。`);
      const seen = await this.seenQueued(client, detail.deliveries, mark, [m]);
      return [oneMessageText(m, c), seen].filter(Boolean).join("\n\n");
    }
    if (threadId && threadId !== coworkId && !c.sessions.some((s) => s.id === threadId)) throw new HostError("bad_request", `${threadId} 不是协作「${c.title}」的子会话。开着的子会话在不带 threadId 的 cowork_read 里。`);
    const before = num(input.before);
    if (before) {
      const sub = threadId && threadId !== coworkId ? threadId : null;
      const back = sub ? await this.threadBefore(client, sub, before) : await this.feedBefore(client, coworkId, before, BACK_MAX, threadId ?? undefined);
      const section = messagesSection(back.messages, c, forMe(back.messages));
      const seen = await this.seenQueued(client, detail.deliveries, mark, section.full);
      return [beforeText(section, c, before, back.messages.length, back.more, threadId ?? undefined), seen].filter(Boolean).join("\n\n");
    }
    if (threadId && threadId !== coworkId) {
      const { thread, messages } = await this.threadAll(client, threadId);
      const files = await client.files({ threadId }).catch(() => [] as RelayFile[]);
      const list = filesAsText(files, { download: "team_file_get（threadId, fileId）" });
      const out = sessionText(thread, messages, c, mark, forMe(messages));
      const seen = await this.seenQueued(client, detail.deliveries, mark, out.seen);
      return [out.text, list, seen].filter(Boolean).join("\n\n");
    }
    const after = typeof input.after === "number" && input.after >= 0 ? input.after : this.readAt(coworkId, mark);
    const feed = await this.feedAll(client, coworkId, after, mark);
    this.setReadAt(coworkId, mark, Math.max(after, feed.lastSeq));
    resetCoworkTold(this.store, sessionId, `unread:${coworkId}`);
    setCoworkTell(this.store, sessionId, `unread:${coworkId}`, null);
    const section = messagesSection(feed.messages, c, forMe(feed.messages));
    const overview = coworkOverview({ cowork: c, events: detail.events, drafts: detail.drafts, mark, section, count: feed.messages.length, after, lastSeq: Math.max(after, feed.lastSeq), files: await this.coworkFiles(client, c) });
    const seen = await this.seenQueued(client, detail.deliveries, mark, section.full);
    return seen ? `${overview}\n\n${seen}` : overview;
  }

  /**
   * Which messages are for this agent, so shown whole: those it was sent (an @, a reply in a 子会话 it started), those
   * @-ing it, and those answering one of its own (among `messages`).
   */
  private forMe(deliveries: CoworkDelivery[], mark: string): (messages: Message[]) => (m: Message) => boolean {
    const sent = new Set(deliveries.filter((d) => d.agent === mark).map((d) => d.messageId));
    return (messages) => {
      const mine = new Set(messages.filter((m) => m.via.kind === "ai" && m.via.conv === mark).map((m) => m.seq));
      return (m) => sent.has(m.id) || !!m.agentMentions?.includes(mark) || (m.replyTo !== undefined && mine.has(m.replyTo));
    };
  }

  /** The feed after `after`, past the service's page (a long absence), at most BACK_CALLS pages. */
  private async feedAll(client: RelayClient, coworkId: string, after: number, mark?: string): Promise<{ messages: Message[]; lastSeq: number }> {
    const messages: Message[] = [];
    let cursor = after;
    for (let i = 0; i < BACK_CALLS; i++) {
      const page = await this.call(() => client.coworkFeed(coworkId, cursor, mark));
      messages.push(...page.messages);
      cursor = Math.max(cursor, page.lastSeq);
      if (page.messages.length < FEED_PAGE) break;
    }
    return { messages, lastSeq: cursor };
  }

  /** One message of the 协作 by its seq (the feed after seq − 1 starts with it when it is the 协作's). */
  private async messageAt(client: RelayClient, coworkId: string, seq: number): Promise<Message | null> {
    const page = await this.call(() => client.coworkFeed(coworkId, seq - 1));
    return page.messages[0]?.seq === seq ? page.messages[0] : null;
  }

  /**
   * The latest `need` messages of the 协作 (of one thread: threadId) before `before`, oldest first. The service's feed only
   * reads forward, and seqs count every message on the service, so this reads windows back from there, each 4× the last,
   * at most BACK_CALLS calls. `more`: older ones may be left.
   */
  private async feedBefore(client: RelayClient, coworkId: string, before: number, need: number, threadId?: string): Promise<{ messages: Message[]; more: boolean }> {
    const got: Message[] = [];
    let hi = before;
    let span = 200;
    let calls = 0;
    while (hi > 0 && got.length < need && calls < BACK_CALLS) {
      const lo = Math.max(0, hi - span);
      const chunk: Message[] = [];
      for (let cursor = lo; calls < BACK_CALLS; ) {
        calls++;
        const page = await this.call(() => client.coworkFeed(coworkId, cursor));
        const under = page.messages.filter((m) => m.seq < hi);
        chunk.push(...under);
        if (page.messages.length < FEED_PAGE || under.length < page.messages.length) break;
        cursor = page.messages[page.messages.length - 1]!.seq;
      }
      got.unshift(...chunk.filter((m) => !threadId || m.threadId === threadId));
      hi = lo;
      span *= 4;
    }
    return { messages: got.slice(-need), more: got.length > need || hi > 0 };
  }

  /** A 子会话's messages, past the service's page. */
  private async threadAll(client: RelayClient, threadId: string): Promise<{ thread: Thread; messages: Message[] }> {
    let out = await this.call(() => client.messages(threadId, 0));
    const messages = [...out.messages];
    for (let i = 1; i < BACK_CALLS && out.messages.length >= THREAD_PAGE; i++) {
      const cursor = messages[messages.length - 1]!.seq;
      out = await this.call(() => client.messages(threadId, cursor));
      messages.push(...out.messages);
    }
    return { thread: out.thread, messages };
  }

  /** A 子会话's messages before `before` (the latest BACK_MAX of them). */
  private async threadBefore(client: RelayClient, threadId: string, before: number): Promise<{ messages: Message[]; more: boolean }> {
    const all = (await this.threadAll(client, threadId)).messages.filter((m) => m.seq < before);
    return { messages: all.slice(-BACK_MAX), more: all.length > BACK_MAX };
  }

  /**
   * An @'s 前文 (COWORK_BRIEF): the message each one answers, and the contextBefore messages before the first in each place.
   * Best effort: without it the @s still go in.
   */
  private async context(client: RelayClient, coworkId: string, items: CoworkInboxItem[]): Promise<Message[]> {
    const out = new Map<string, Message>();
    const given = new Set(items.map((i) => i.message.id));
    const first = new Map<string, number>();
    for (const i of items) first.set(i.thread.id, Math.min(first.get(i.thread.id) ?? Infinity, i.message.seq));
    for (const [threadId, seq] of first) {
      for (const m of (await this.feedBefore(client, coworkId, seq, COWORK_BRIEF.contextBefore, threadId)).messages) out.set(m.id, m);
    }
    const seqs = new Set([...out.values()].map((m) => m.seq));
    for (const i of items) {
      const r = i.message.replyTo;
      if (!r || seqs.has(r) || items.some((x) => x.message.seq === r)) continue;
      const m = await this.messageAt(client, coworkId, r);
      if (m) {
        out.set(m.id, m);
        seqs.add(r);
      }
    }
    return [...out.values()].filter((m) => !given.has(m.id)).sort((a, b) => a.seq - b.seq);
  }

  /**
   * The @s and 子会话 replies waiting for this agent (排队中) that cowork_read just showed it: acked now as 送达, so they
   * are not put into the conversation again once its turn ends (2026-11-23, the real-model run: DeepSeek read #13 and
   * #14 with cowork_read mid-turn, did what they asked, and was woken for them afterwards only to say it already had).
   */
  private async seenQueued(client: RelayClient, deliveries: CoworkDelivery[], mark: string, shown: Message[]): Promise<string> {
    const ids = new Set(shown.map((m) => m.id));
    const seen = deliveries.filter((d) => d.agent === mark && d.state === "queued" && ids.has(d.messageId));
    if (!seen.length) return "";
    await this.ack(client, seen.map((d) => d.id));
    return `（上面有 ${seen.length} 条是给你的（${seen.map((d) => `#${d.seq}`).join("、")}）：算你已经收到，不会再单独送进这个对话。要回的现在用 cowork_post 回。）`;
  }

  /** The files of the 群聊 and of every 子会话 (the latest FILE_SESSIONS of them), for cowork_read. */
  private async coworkFiles(client: RelayClient, cowork: Cowork): Promise<CoworkFiles> {
    const threads = [cowork.id, ...[...cowork.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, FILE_SESSIONS).map((s) => s.id)];
    return Promise.all(threads.map(async (threadId) => ({ threadId, files: await client.files({ threadId }).catch(() => [] as RelayFile[]) })));
  }

  /**
   * cowork_conclude (2026-11-23, 中转迭代讨论): 定下结论 of a 子会话 — as the service lets only its asker or the person asked
   * (an agent as its owner), said here before the call so the AI is told who may instead of a bare 403.
   */
  async conclude(sessionId: Id, input: { coworkId?: unknown; threadId?: unknown; conclusion?: unknown }): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client, me } = this.relay();
    const threadId = refId(text(input.threadId, "threadId"), "thread");
    const conclusion = text(input.conclusion, "conclusion");
    const detail = await this.call(() => client.cowork(coworkId));
    const s = detail.cowork.sessions.find((x) => x.id === threadId);
    if (!s) throw new HostError("bad_request", `${threadId} 不是协作「${detail.cowork.title}」的子会话${threadId === coworkId ? "（群聊没有结论：定下的事在子会话里定）" : ""}。子会话在 cowork_read 的「开着的子会话」里。`);
    if (s.state === "done") throw new HostError("bad_request", `子会话「${s.title}」已经结束了${s.conclusion ? `，结论是：${s.conclusion}` : ""}。要改，在群聊里说，或者开一个新的子会话。`);
    if (me !== s.from && me !== s.to) throw new HostError("bad_request", `子会话「${s.title}」是 ${s.from} 问 ${s.to} 的，结论只有他们两边（和他们的 AI）能定。你有意见就用 cowork_post 带 threadId ${s.id} 在里面说。`);
    await this.call(() => client.concludeCowork(coworkId, threadId, conclusion, this.via(mark)));
    return concludedText(s.title, conclusion);
  }

  /** cowork_post: says something in the 群聊 or in a 子会话 (threadId), as the owner's AI. */
  async post(sessionId: Id, input: { coworkId?: unknown; threadId?: unknown; body?: unknown; mentions?: unknown; agentMentions?: unknown; replyTo?: unknown }): Promise<string> {
    const { coworkId, mark, join } = this.mine(sessionId, input.coworkId);
    const { client, me } = this.relay();
    const body = text(input.body, "body");
    const threadId = typeof input.threadId === "string" && input.threadId.trim() ? refId(input.threadId, "thread") : undefined;
    const out = await this.call(() =>
      client.postCowork(coworkId, {
        kind: "text",
        body,
        ...(threadId && threadId !== coworkId ? { threadId } : {}),
        ...(names(input.mentions).length ? { mentions: names(input.mentions) } : {}),
        ...(names(input.agentMentions).length ? { agentMentions: names(input.agentMentions) } : {}),
        ...(typeof input.replyTo === "number" ? { replyTo: input.replyTo } : {}),
        via: this.via(mark),
      }),
    );
    if (out.draft) this.draftMade(join);
    return postResultText(out, me, "post");
  }

  /** cowork_ask: a new 子会话, asking a person in the 协作. */
  async ask(sessionId: Id, input: { coworkId?: unknown; to?: unknown; title?: unknown; body?: unknown; questions?: unknown }): Promise<string> {
    const { coworkId, mark, join } = this.mine(sessionId, input.coworkId);
    const { client, me } = this.relay();
    const to = text(input.to, "to");
    if (to === me) throw new HostError("bad_request", `你用的就是 ${me} 的身份：要问 ${me} 本人，直接在这个对话里问。`);
    const questions = Array.isArray(input.questions) ? (input.questions as Array<{ text?: unknown; options?: unknown }>).filter((q) => typeof q?.text === "string" && q.text.trim()).map((q) => ({ text: String(q.text).trim(), ...(Array.isArray(q.options) ? { options: q.options.filter((o): o is string => typeof o === "string" && !!o.trim()) } : {}) })) : [];
    const out = await this.call(() => client.askCowork(coworkId, { to, title: text(input.title, "title").slice(0, 200), body: text(input.body, "body"), ...(questions.length ? { questions } : {}), via: this.via(mark) }));
    if (out.draft) this.draftMade(join);
    return postResultText(out, me, "ask");
  }

  /** A draft waits for the owner: 等主人 now, not at the next tick. */
  private draftMade(join: CoworkJoin): void {
    this.saveJoined(this.joined().map((j) => (j.coworkId === join.coworkId && j.mark === join.mark ? { ...j, drafts: j.drafts + 1 } : j)));
    this.scheduleReport();
  }

  /** cowork_board: without ops, the board; with ops (at most BOARD_AI_MAX_CARDS cards), changes it. */
  async board(sessionId: Id, input: { coworkId?: unknown; ops?: unknown }): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client } = this.relay();
    const seenKey = `${coworkId} ${mark}`;
    if (input.ops === undefined || input.ops === null || (Array.isArray(input.ops) && !input.ops.length)) {
      const [snap, detail] = await Promise.all([this.call(() => client.coworkBoard(coworkId, 0)), this.call(() => client.cowork(coworkId))]);
      const items: BoardItem[] = snap.items ?? [];
      this.boardSeen.set(seenKey, new Map(items.map((it) => [it.id, it.textVersion])));
      return boardText(items, snap.locks, snap.seq, detail.cowork);
    }
    if (!Array.isArray(input.ops)) throw new HostError("bad_request", "ops 要是一个列表");
    const ops = input.ops as BoardOp[];
    const cards = new Set<string>();
    for (const o of ops) {
      if (o && typeof o === "object" && "id" in o && typeof o.id === "string") cards.add(o.id);
      else if (o?.op === "add") cards.add(`new:${cards.size}`);
    }
    if (cards.size > BOARD_AI_MAX_CARDS) throw new HostError("bad_request", `一次最多改 ${BOARD_AI_MAX_CARDS} 张卡（这次 ${cards.size} 张）。分几次做；要大改整块白板，先在协作里说一声，请人点头再分批改。`);
    // A text change carries the version the agent read (so one changed since is refused, not overwritten).
    const seen = this.boardSeen.get(seenKey);
    const withBase = ops.map((o) => (o?.op === "set" && o.base === undefined && o.fields && "text" in o.fields && seen?.has(o.id) ? { ...o, base: seen.get(o.id)! } : o));
    const out = await this.call(() => client.coworkBoardOps(coworkId, withBase, this.via(mark)));
    const now = seen ?? new Map<string, number>();
    for (const r of out.applied) for (const it of r.items) now.set(it.id, it.textVersion);
    this.boardSeen.set(seenKey, now);
    return boardOpsText(out);
  }

  /** cowork_note: a commit pushed (with its files: board cards citing an older commit of them go 已过时) or a note. */
  async note(sessionId: Id, input: { coworkId?: unknown; kind?: unknown; text?: unknown; commit?: unknown; files?: unknown }): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client } = this.relay();
    const kind = input.kind === "commit" ? "commit" : "note";
    const commit = typeof input.commit === "string" && input.commit.trim() ? input.commit.trim() : undefined;
    if (kind === "commit" && !commit) throw new HostError("bad_request", "kind commit 要带 commit（提交号）");
    const files = names(input.files);
    const out = await this.call(() => client.addCoworkEvent(coworkId, { kind, text: text(input.text, "text"), ...(commit ? { commit } : {}), ...(files.length ? { files } : {}), via: this.via(mark) }));
    const stale = out.board?.applied.length ?? 0;
    return `已记下（事件 ${out.event.id}）。${stale ? `白板上 ${stale} 张引用了这些文件旧提交的卡标成了已过时。` : ""}事件只记不叫醒别人，别的 AI 下次读协作时会看到。`;
  }

  // ---- 转到我的会话

  handoffs(): CoworkHandoff[] {
    try {
      const list = JSON.parse(this.store.getKv(HANDOFFS_KEY)?.value ?? "[]") as CoworkHandoff[];
      const since = Date.now() - HANDOFF_KEEP_MS;
      return list.filter((h) => Date.parse(h.at) > since);
    } catch {
      return [];
    }
  }

  private saveHandoffs(next: CoworkHandoff[], added?: string): void {
    this.store.setKv(HANDOFFS_KEY, JSON.stringify(next));
    this.publish({ type: "cowork.handoffs.changed", handoffs: next, ...(added ? { added } : {}) });
  }

  /** The 中转 client hands a 子会话 to Studio here: the workbench asks the person which session takes it. */
  async handoff(threadIdValue: unknown): Promise<CoworkHandoff> {
    const threadId = text(threadIdValue, "threadId");
    const { client, me } = this.relay();
    const { thread } = await this.call(() => client.messages(threadId, Number.MAX_SAFE_INTEGER));
    const coworkId = thread.request?.coworkId;
    if (!coworkId) throw new HostError("bad_request", `中转会话 ${threadId} 不是协作里的子会话`);
    if (!thread.members.includes(me)) throw new HostError("bad_request", `${me} 不在这个子会话的协作里`);
    const { cowork } = await this.call(() => client.cowork(coworkId));
    const h: CoworkHandoff = { threadId, coworkId, coworkTitle: cowork.title, title: thread.title, from: thread.request!.from, to: thread.request!.to, at: new Date().toISOString() };
    this.saveHandoffs([...this.handoffs().filter((x) => x.threadId !== threadId), h], threadId);
    return h;
  }

  dismissHandoff(threadIdValue: unknown): { ok: true } {
    const threadId = text(threadIdValue, "threadId");
    this.saveHandoffs(this.handoffs().filter((h) => h.threadId !== threadId));
    return { ok: true };
  }

  /** Takes a handoff: the session (or a new task's) joins the 协作 and gets the 子会话 in full; the workbench goes there. */
  async acceptHandoff(input: { threadId?: unknown; sessionId?: unknown; newTask?: { workspaceId?: unknown; profileId?: unknown } }): Promise<{ taskId: Id; sessionId: Id }> {
    const threadId = text(input.threadId, "threadId");
    const h = this.handoffs().find((x) => x.threadId === threadId) ?? (await this.handoff(threadId));
    const { client, me } = this.relay();
    const { thread, messages } = await this.call(() => client.messages(threadId, 0));
    const files = await client.files({ threadId }).catch(() => [] as RelayFile[]);
    let target: Session;
    if (input.newTask) {
      const workspaceId = text(input.newTask.workspaceId, "newTask.workspaceId");
      const profileId = text(input.newTask.profileId, "newTask.profileId");
      const made = await this.f.tasks.createTask({ title: `协作：${h.title}`.slice(0, 200), workspaceId, firstSession: { profileId, title: h.title.slice(0, 100) } });
      if (!made.session) throw new HostError("runtime_error", "新任务没开出会话");
      target = made.session;
    } else target = this.joinable(text(input.sessionId, "sessionId"));
    const already = this.joined().find((j) => j.sessionId === target.id && j.coworkId === h.coworkId);
    const join = already ?? (await this.join(target.id, h.coworkId, input.newTask ? h.title : undefined));
    const hint = coworkHint(this.store, target.id);
    const list = filesAsText(files, { download: "team_file_get（threadId, fileId）" });
    const body = [
      `【协作「${h.coworkTitle}」· ${me} 把子会话「${h.title}」转给你】`,
      ...(hint?.lines ?? []),
      `${me} 在 AMO 中转里把协作「${h.coworkTitle}」的子会话「${h.title}」（${h.from} 问 ${h.to}）转到了这个会话，全文在下面。先和 ${me} 在这个对话里商量；${me} 让你回时，用 cowork_post（threadId ${threadId}）替 ${me} 回在子会话里（显示「${join.name}」），也可能 ${me} 看完自己去回。之后这个子会话里有人回复你，会再送进这个对话。`,
      threadAsText(thread, messages),
      ...(list ? [list] : []),
    ].join("\n\n");
    await this.f.sessions.inbox.put(target.id, body, { kind: "cowork", from: me, threadIds: [threadId], cowork: { id: h.coworkId, title: h.coworkTitle, where: `把子会话「${h.title}」转给你` } });
    hint?.told();
    this.saveHandoffs(this.handoffs().filter((x) => x.threadId !== threadId));
    const taskId = target.taskId ?? "";
    this.publish({ type: "ui.open", taskId, sessionId: target.id, at: new Date().toISOString() });
    return { taskId, sessionId: target.id };
  }

  // ---- 复制引用 and 从 Studio 打开中转客户端 (2026-11-23, 中转迭代讨论; protocol/src/refs.ts, relay-client.ts)

  /** Test runs (AMO_STUDIO_TEST=1) only record the client's starts. */
  readonly relayLaunches: RelayClientLaunch[] = [];

  /** 复制会话引用: `Studio 会话「名」 studio:<设备号>:<会话id>（任务 …）` — the session's mark in a 协作 is the same. */
  sessionRef(sessionIdValue: unknown): { text: string } {
    const s = this.store.getSession(text(sessionIdValue, "sessionId"));
    if (!s) throw new HostError("not_found", "没有这个会话");
    const device = this.teamLink.device;
    if (!device) throw new HostError("conflict", "这台电脑还没有设备号（AMO 平台或 Studio 第一次连团队服务器时生成），会话引用要带它");
    return { text: sessionRefText(this.sessionName(s), device.id, s.id, s.taskId) };
  }

  /** The 协作 line: the 中转 client opens `cowork:<id>` (or `thread:<id>`); started when it is not open. */
  openInRelay(targetValue: unknown): { exe: string; from: RelayClientFound["from"]; args: string[]; dryRun: boolean } {
    const target = relayTarget(targetValue);
    if (!target) throw new HostError("bad_request", "要打开的应当是 cowork:<id> 或 thread:<id>");
    const found = findRelayClient(process.env);
    if (!found) throw new HostError("not_found", "没找到 AMO 中转客户端，在 AMO 平台里装一下");
    const launch = relayClientLaunch(found, target, process.env);
    const dryRun = process.env.AMO_STUDIO_TEST === "1";
    if (dryRun) this.relayLaunches.push(launch);
    else startRelayClient(launch);
    return { exe: found.exe, from: found.from, args: launch.args, dryRun };
  }
}

function text(value: unknown, name: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new HostError("bad_request", `${name} is required`);
  return v;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()))] : [];
}
