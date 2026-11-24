import { inTurn, refId, sessionRefText, type CoworkChoice, type CoworkHandoff, type CoworkJoin, type CoworkRoleChoices, type Id, type MessageOrigin, type Session } from "@amo-studio/protocol";
import { AGENT_REPORT_MS, AGENT_STATE_LABEL, agentParty, basisText, personParty, BOARD_AI_MAX_CARDS, COWORK_MATTERS_VERSION, filesAsText, GATE_LABEL, MATTER_STATUS_LABEL, pendingItemKey, RelayClientError, seenByAgents, threadAsText, type AgentReport, type AgentRole, type BoardItem, type BoardOp, type Cowork, type CoworkDelivery, type CoworkInbox, type CoworkInboxItem, type GateKind, type Matter, type MatterKind, type MatterPatch, type Message, type MessageBasis, type Party, type PendingItem, type RelayClient, type RelayFile, type Thread, type Via } from "@amo-studio/relay/light";
import { Feature, type FeatureHost } from "../../core/feature.js";
import { noteCoworkKnown } from "../../core/role.js";
import { HostError, isRemoteCopy } from "../../core/shared.js";
import { compactionKnown, coworkHint, coworkTold, resetCoworkTold, setCoworkTell, writeCoworkCards, type CoworkCard } from "../../core/cowork.js";
import { authorOf, beforeText, boardOpsText, boardText, concludedText, COWORK_BRIEF, coworkOverview, type CoworkFiles, type CoworkOverviewV2, deliveryFrom, deliveryText, deliveryWhere, joinedLine, messagesSection, oneMessageText, postResultText, sessionText } from "./cowork-text.js";
import type { TeamRelayFeature } from "./service.js";
import { findRelayClient, relayClientLaunch, relayTarget, startRelayClient, type RelayClientFound, type RelayClientLaunch } from "./relay-client.js";
import { leadCard, matterCardsText, mattersSection, membersSection, partyName, pendingSection, roleLabel, unassignedCard, wakeText, workerCard, type WakeItem, type WakeWhy } from "./cowork-matters-text.js";
import { agentRef, matterRef, partyRef, personRef, seqRef, seqsRef, statusRef, threadRef } from "./cowork-refs.js";

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
/**
 * What the new tools answer while the team server's 中转 is still the old one (health cowork < 2, no 事项): nothing was
 * done, and what to do instead (2026-11-25, 中转迭代讨论: 明白话，不报错).
 */
export const OLD_SERVICE = {
  matter: "没有做任何改动：对方（团队服务器上）的 AMO 中转服务还是旧版，没有事项。照旧的做法：要问人用 cowork_ask 开子会话，商量定了用 cowork_conclude 定结论，进度在群聊里用 cowork_post 说。中转更新后再用 cowork_matter。",
  mark: "没有标：对方（团队服务器上）的 AMO 中转服务还是旧版，没有「处理了」的标记，也不需要标。回复照常用 cowork_post（带 replyTo）。",
  retract: "没有撤回：对方（团队服务器上）的 AMO 中转服务还是旧版，发出去的消息不能撤回或改写。要更正就用 cowork_post 再发一条说明。",
} as const;
/** A handoff that asks for this side's 主控 (2026-11-24): `lead:<coworkId>` in place of a 子会话. */
const LEAD_ASK = "lead:";
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

export class TeamCowork extends Feature<"config" | "sessions" | "attachments" | "tasks" | "pending"> {
  constructor(
    host: FeatureHost<"config" | "sessions" | "attachments" | "tasks" | "pending">,
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
  /** Per server: its /api/health `cowork` and when it was read (2026-11-25: a new Studio meets an old service and back). */
  private readonly versions = new Map<string, { at: number; v: number }>();
  /** Per agent (`<coworkId> <mark>`): items in its 待我处理 as last read (cowork-pending.ts writes it). */
  readonly pendingCounts = new Map<string, number>();

  // ---- what the service can do

  /** The service's 协作 version (0 when unknown: signed out or unreachable), read again every 5 minutes. */
  async version(): Promise<number> {
    const login = this.teamLink.login();
    if (!login) return 0;
    const server = login.account.server;
    const was = this.versions.get(server);
    if (was && Date.now() - was.at < 5 * 60_000) return was.v;
    const { client } = this.relay();
    const v = await client
      .health()
      .then((h) => h.cowork ?? 1)
      .catch(() => was?.v ?? 0);
    this.versions.set(server, { at: Date.now(), v });
    return v;
  }

  /** 事项, roles, receipts and 待我处理 (health `cowork` ≥ COWORK_MATTERS_VERSION): the new tools and flow; else the old way. */
  async hasMatters(): Promise<boolean> {
    return (await this.version()) >= COWORK_MATTERS_VERSION;
  }

  /** The same from what was last read (no call): for lists made in a hurry. */
  private mattersKnown(): boolean {
    const login = this.teamLink.login();
    return !!login && (this.versions.get(login.account.server)?.v ?? 0) >= COWORK_MATTERS_VERSION;
  }

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

  /**
   * 拉进协作: the session joins the 协作 as its owner's AI; told so (its role card, 2026-11-24 plans/collab-agent-spec.md §1)
   * with the next message it gets. `as`: its role on a service with 事项 — this side's 主控 (the default; one per side, a
   * second is refused saying who holds it) or 执行 of one 事项 (「事项 3」 or its id). `tell` false: the caller puts the card
   * into the session itself (session_start with matter: in its first message).
   */
  async join(sessionIdValue: unknown, coworkIdValue: unknown, labelValue?: unknown, as?: { role?: unknown; matter?: unknown }, tell = true): Promise<CoworkJoin> {
    const s = this.joinable(text(sessionIdValue, "sessionId"));
    const coworkId = refId(text(coworkIdValue, "coworkId"), "cowork");
    const label = (typeof labelValue === "string" && labelValue.trim() ? labelValue.trim() : this.sessionName(s)).slice(0, 60);
    const { client, me, prefix } = this.relay();
    const mark = `${prefix}${s.id}`;
    const matters = await this.hasMatters();
    const role = matters ? await this.roleWanted(client, coworkId, as) : undefined;
    const out = await this.call(() => client.joinCoworkAgent(coworkId, mark, label, role));
    compactionKnown(this.store, s.id);
    // Its card is told with its next message by the role update (core/role.ts, 2026-11-25), from the cards refresh writes.
    await this.refresh().catch(() => undefined);
    if (!tell) noteCoworkKnown({ store: this.store }, s.id);
    this.scheduleReport();
    const found = this.joined().find((j) => j.sessionId === s.id && j.coworkId === coworkId);
    return found ?? this.joinOf(out.cowork, out.agent.mark, prefix, 0);
  }

  /** The role asked for, checked: an 执行's 事项 by 「事项 N」 or id. */
  private async roleWanted(client: RelayClient, coworkId: string, as?: { role?: unknown; matter?: unknown }): Promise<{ role: AgentRole; matter?: string }> {
    const role: AgentRole = as?.role === "worker" ? "worker" : "lead";
    if (role === "lead") return { role };
    const { cowork } = await this.call(() => client.cowork(coworkId));
    const m = matterRef(cowork, as?.matter);
    if (!m) throw new HostError("bad_request", `执行要绑定一件事项：协作「${cowork.title}」里没有「${String(as?.matter ?? "")}」。开着的事项：${(cowork.matters ?? []).filter((x) => x.status !== "closed").map((x) => `事项 ${x.no}「${x.title}」`).join("、") || "（没有）"}`);
    return { role, matter: m.id };
  }

  /** What a session is told when it joins or its role changes: its role card (a service with 事项), else the old line. */
  cardFor(c: Cowork, mark: string, me: string, matters: boolean): string {
    const a = c.agents.find((x) => x.mark === mark);
    const name = a?.name ?? `${me} 的 AI`;
    if (!matters) return joinedLine(c, name, me);
    const head = `【协作「${c.title}」· 你的角色：${roleLabel(a?.role ?? null, c.matters?.find((m) => m.id === a?.matter))}】`;
    const goal = c.goal.trim() ? `\n\n目标：${c.goal.trim().replace(/\s+/g, " ").slice(0, 300)}${c.goal.trim().length > 300 ? "…" : ""}` : "";
    const repo = c.repo ? `\n仓库 ${c.repo}${c.branch ? ` · 分支 ${c.branch}` : ""}` : "";
    if (a?.role === "worker") {
      const m = c.matters?.find((x) => x.id === a.matter);
      const lead = c.agents.find((x) => x.role === "lead" && x.owner === a.owner);
      if (m) return `${head}\n\n${workerCard(c, lead?.name ?? `${me} 这一方的主控`, m)}${goal}${repo}`;
    }
    if (a?.role === "lead") return `${head}\n\n${leadCard(c, me)}${goal}${repo}\n\n工具：cowork_read（看全局：角色、开着的事项、已定的事、待你处理）、cowork_post、cowork_matter（开、改、关事项）、cowork_ask（要人拍板）、cowork_mark（标处理了）、cowork_retract、cowork_board、cowork_note；派执行用 session_start 带 matter。`;
    return `${head}\n\n${unassignedCard(c, me)}${goal}${repo}`;
  }

  /**
   * session_start with `matter` (2026-11-24, plans/collab-agent-spec.md §3「派执行会话做一件事项」): the 主控 in a 协作 opens an
   * 执行 of one of its 事项. Checked before the session starts; its first message carries the 执行's card.
   */
  async workerPlan(fromSessionId: Id, matterValue: unknown, coworkIdValue?: unknown): Promise<{ coworkId: string; matter: Matter; card: string }> {
    const { coworkId, mark } = this.mine(fromSessionId, coworkIdValue);
    const { client } = this.relay();
    const { cowork: c } = await this.call(() => client.cowork(coworkId));
    if (!c.matters) throw new HostError("conflict", "团队服务器上的 AMO 中转还是旧版本，没有事项：开会话时不带 matter。");
    const me = c.agents.find((a) => a.mark === mark);
    if (me?.role === "worker") throw new HostError("bad_request", "你是执行会话：派活是主控的事。要分出去的，写进这一轮最后的回复交回给主控。");
    const m = matterRef(c, matterValue);
    if (!m) throw new HostError("bad_request", `协作「${c.title}」里没有「${String(matterValue)}」。开着的事项：${(c.matters ?? []).filter((x) => x.status !== "closed").map((x) => `事项 ${x.no}「${x.title}」`).join("、") || "（没有：先用 cowork_matter open 开一件）"}`);
    if (m.status === "closed") throw new HostError("bad_request", `事项 ${m.no}「${m.title}」已经关了。`);
    const card = `【协作「${c.title}」· 你的角色：执行（事项 ${m.no}）】\n\n${workerCard(c, me?.name ?? "主控", m)}`;
    return { coworkId, matter: m, card };
  }

  /** 改角色 of a session already in a 协作 (the person): told its new card with the next message. */
  async setRole(input: { sessionId?: unknown; coworkId?: unknown; role?: unknown; matter?: unknown }): Promise<CoworkJoin> {
    const sessionId = text(input.sessionId, "sessionId");
    const coworkId = refId(text(input.coworkId, "coworkId"), "cowork");
    const { client, me, prefix } = this.relay();
    if (!(await this.hasMatters())) throw new HostError("conflict", "团队服务器上的 AMO 中转还是旧版本，没有主控和执行的角色：等它更新后再分角色。");
    const mark = `${prefix}${sessionId}`;
    const role = await this.roleWanted(client, coworkId, { role: input.role, matter: input.matter });
    const out = await this.call(() => client.setCoworkAgentRole(coworkId, mark, role.role, role.matter ?? null));
    // The new card goes with its next message (the role update compares its 协作 roles, core/role.ts).
    await this.refresh().catch(() => undefined);
    const found = this.joined().find((j) => j.sessionId === sessionId && j.coworkId === coworkId);
    return found ?? this.joinOf(out.cowork, mark, prefix, 0);
  }

  /** 拉进协作's role choice: this side's 主控 now, and the 事项 an 执行 may take. */
  async roles(coworkIdValue: unknown): Promise<CoworkRoleChoices> {
    const coworkId = refId(text(coworkIdValue, "coworkId"), "cowork");
    const { client, me, prefix } = this.relay();
    const matters = await this.hasMatters();
    if (!matters) return { coworkId, matters: false, lead: null, openMatters: [] };
    const { cowork } = await this.call(() => client.cowork(coworkId));
    const lead = cowork.agents.find((a) => a.owner === me && a.role === "lead");
    return {
      coworkId,
      matters: true,
      lead: lead ? { name: lead.name, mark: lead.mark, sessionId: lead.mark.startsWith(prefix) ? lead.mark.slice(prefix.length) : null } : null,
      openMatters: (cowork.matters ?? [])
        .filter((m) => m.status !== "closed")
        .sort((a, b) => b.no - a.no)
        .map((m) => ({ id: m.id, no: m.no, title: m.title, status: MATTER_STATUS_LABEL[m.status], side: m.side })),
    };
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
    // Its cards again (its next message says it is out of that 协作).
    await this.refresh().catch(() => undefined);
    return { ok: true };
  }

  private joinOf(c: Cowork, mark: string, prefix: string, drafts: number): CoworkJoin {
    const a = c.agents.find((x) => x.mark === mark)!;
    const sessionId = mark.slice(prefix.length);
    const matters = c.matters !== undefined;
    const m = a.role === "worker" ? c.matters?.find((x) => x.id === a.matter) : null;
    return {
      coworkId: c.id,
      coworkTitle: c.title,
      sessionId,
      mark,
      label: a.label,
      name: a.name,
      state: this.lastState.get(mark) ?? this.stateOf(sessionId, mark, drafts),
      queued: a.queued,
      drafts,
      ended: c.endedAt !== null,
      joinedAt: a.joinedAt,
      matters,
      // 未分角色 (the service's unassigned, or before roles) is null here: the UI offers 选角色.
      role: matters && (a.role === "lead" || a.role === "worker") ? a.role : null,
      matter: m ? { id: m.id, no: m.no, title: m.title } : null,
      pending: this.pendingCounts.get(`${c.id} ${mark}`) ?? 0,
    };
  }

  /** Reads which of this computer's sessions are in which 协作 again, from the service. */
  async refresh(): Promise<CoworkJoin[]> {
    const { client, me, prefix } = this.relay();
    await this.version();
    const list = await client.coworks();
    const next: CoworkJoin[] = [];
    const cards: Record<Id, CoworkCard[]> = {};
    for (const c of list) {
      const mine = c.agents.filter((a) => a.owner === me && a.mark.startsWith(prefix));
      if (!mine.length) continue;
      // Drafts are gone on a service with 事项 (2026-11-24).
      const drafts = c.matters !== undefined ? [] : await client.coworkDrafts(c.id).catch(() => []);
      for (const a of mine) {
        const s = this.store.getSession(a.mark.slice(prefix.length));
        // Gone or archived: it cannot hear any more, so it leaves (what waits for it there is dropped).
        if (!s || s.archivedAt || s.writer === "archived") {
          await client.leaveCoworkAgent(c.id, a.mark).catch(() => undefined);
          continue;
        }
        next.push(this.joinOf(c, a.mark, prefix, drafts.filter((d) => d.agent === a.mark && d.state === "pending").length));
        const j = next[next.length - 1]!;
        (cards[j.sessionId] ??= []).push({ coworkId: c.id, title: c.title, role: roleLabel(j.role ?? null, j.matter), card: this.cardFor(c, a.mark, me, c.matters !== undefined), pending: j.pending ?? 0 });
      }
    }
    this.saveJoined(next);
    writeCoworkCards(this.store, cards);
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
    // The list as it is now, not as it was before the await (2026-11-24): a leave or a join meanwhile stays; only the state
    // and queue of those still in it change.
    this.saveJoined(this.joined().map((j) => ({ ...j, state: byMark.get(j.mark) ?? j.state, queued: queued.get(`${j.coworkId} ${j.mark}`) ?? j.queued })));
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
      // A service with 事项 (2026-11-24): the wake message of plans/collab-agent-spec.md §2; else the old delivery.
      const matters = cowork.matters !== undefined;
      const wake = matters ? this.deliveryItems(cowork, fresh) : [];
      const body = matters
        ? [...(hint?.lines ?? []), wakeText({ cowork, mark, why: this.deliveryWhy(cowork, fresh), items: wake, unread, context })].join("\n\n")
        : deliveryText({ items: fresh, cowork, me, myName: agent?.name ?? `${me} 的 AI`, mark, unread, lines: hint?.lines ?? [], context });
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
      // The patrol does not wake it for these again (they are in its 待我处理 until it handles them).
      if (wake.length) this.f.pending.told(sessionId, pendingGroupId(coworkId, mark), wake.map((w) => pendingItemKey(w.item)));
      for (const i of fresh) this.unacked.add(i.delivery.id);
      await this.ack(client, fresh.map((i) => i.delivery.id));
    }
    return left;
  }

  // ---- 待我处理 (cowork-pending.ts) and the patrol's wake

  signedIn(): boolean {
    return !!this.teamLink.login();
  }

  relayLogin(): { client: RelayClient; me: string; prefix: string } {
    return this.relay();
  }

  viaOf(mark: string): Via {
    return this.via(mark);
  }

  /** The 主控' 待我处理 counts as the patrol read them: shown on each session's 协作 line. */
  notePending(counts: Map<string, number>): void {
    let changed = false;
    for (const [k, n] of counts) {
      if (this.pendingCounts.get(k) === n) continue;
      this.pendingCounts.set(k, n);
      changed = true;
    }
    for (const k of [...this.pendingCounts.keys()]) {
      if (counts.has(k)) continue;
      this.pendingCounts.delete(k);
      changed = true;
    }
    if (changed) this.saveJoined(this.joined().map((j) => ({ ...j, pending: this.pendingCounts.get(`${j.coworkId} ${j.mark}`) ?? 0 })));
  }

  /**
   * The patrol wakes a 主控 (plans/collab-agent-spec.md §2) with these items of its 待我处理: only when it is 待命 (false
   * otherwise: woken once it is). What a delivery will bring anyway (an @ still queued for it) is left to the delivery.
   */
  async wakeFor(sessionId: Id, coworkId: string, mark: string, items: PendingItem[], why: { kind: "patrol" | "manual"; at: number }): Promise<boolean> {
    if (this.stateOf(sessionId, mark) !== "idle") return false;
    const { client, me } = this.relay();
    const detail = await this.call(() => client.cowork(coworkId));
    const c = detail.cowork;
    const queued = new Set(detail.deliveries.filter((d) => d.agent === mark && d.state === "queued").map((d) => d.seq));
    const left = items.filter((i) => !(i.seq && queued.has(i.seq)));
    if (!left.length) return true;
    const wake: WakeItem[] = [];
    for (const item of left) {
      const matter = item.matter ? (c.matters?.find((m) => m.id === item.matter) ?? null) : null;
      const message = item.seq ? await this.messageAt(client, coworkId, item.seq).catch(() => null) : null;
      const answered = message?.replyTo ? await this.messageAt(client, coworkId, message.replyTo).catch(() => null) : null;
      wake.push({ item, message, matter, repliesToMe: !!answered && answered.via.kind === "ai" && answered.via.conv === mark });
    }
    const hint = coworkHint(this.store, sessionId);
    const w: WakeWhy = why.kind === "patrol" ? { kind: "patrol", at: why.at } : { kind: "manual", at: why.at, by: me };
    const body = [...(hint?.lines ?? []), wakeText({ cowork: c, mark, why: w, items: wake, unread: 0 })].join("\n\n");
    const origin: MessageOrigin = { kind: "cowork", from: why.kind === "patrol" ? "巡检" : me, threadIds: [...new Set(wake.map((x) => x.matter?.id ?? c.id))], cowork: { id: c.id, title: c.title, where: why.kind === "patrol" ? "发现待你处理有变化" : "让你现在看一遍待你处理" } };
    await this.f.sessions.inbox.put(sessionId, body, origin);
    hint?.told();
    return true;
  }

  /** The deliveries as 待我处理 items (an @ of it, or a message to it in a 事项: a reply in one it started). */
  private deliveryItems(cowork: Cowork, items: CoworkInboxItem[]): WakeItem[] {
    return items.map((i) => {
      const matter = cowork.matters?.find((m) => m.id === (i.message.matter ?? i.thread.id)) ?? null;
      const kind = i.delivery.reason === "mention" ? "mention" : i.delivery.reason === "reply" ? "reply" : "message";
      const item: PendingItem = {
        kind,
        scope: "cowork",
        scopeId: cowork.id,
        matter: matter?.id ?? null,
        matterNo: matter?.no ?? null,
        matterTitle: matter?.title ?? null,
        matterStatus: matter?.status ?? null,
        seq: i.message.seq,
        seqs: [i.message.seq],
        since: i.message.createdAt,
        why: { by: i.message.via.kind === "ai" && i.message.via.conv ? agentParty(i.message.via.conv) : personParty(i.message.author), at: i.message.createdAt, reason: kind, text: kind === "mention" ? "@ 了你" : kind === "reply" ? "回了你" : "发给你" },
        text: `#${i.message.seq} ${i.message.body.replace(/\s+/g, " ").slice(0, 80)}`,
      };
      return { item, message: i.message, matter, repliesToMe: i.delivery.reason === "reply" };
    });
  }

  private deliveryWhy(cowork: Cowork, items: CoworkInboxItem[]): WakeWhy {
    const first = items.find((i) => i.delivery.reason === "mention") ?? items[0]!;
    const who = authorOf(first.message, cowork);
    return first.delivery.reason === "mention" ? { kind: "mention", who, seq: first.message.seq } : { kind: "reply", who, seq: first.message.seq };
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
        // 2026-11-24 (plans/collab-agent-spec.md §2): said as progress, not as 「不用回」 — it went with the person's message and
        // with an @ in the same turn, and the model took the @ as not to answer too.
        setCoworkTell(this.store, j.sessionId, key, `【协作「${j.coworkTitle}」】另有 ${n} 条群聊新消息没 @ 你，只是进度；要看用 cowork_read（coworkId ${j.coworkId}）。`, n);
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
    const me = c.agents.find((a) => a.mark === mark);
    // An 执行 sees its own 事项 only (the service filters its feed and board the same way).
    const own = me?.role === "worker" ? (me.matter ?? null) : null;
    const threadId = input.threadId === undefined || input.threadId === null || input.threadId === "" ? null : this.threadOf(c, input.threadId).threadId;
    if (own && threadId && threadId !== own) throw new HostError("bad_request", `你是事项 ${c.matters?.find((m) => m.id === own)?.no ?? ""} 的执行会话，只能看这件事项（threadId 写「事项 ${c.matters?.find((m) => m.id === own)?.no ?? ""}」）；别的事项和群聊由主控看。`);
    const forMe = this.forMe(detail.deliveries, mark);
    const seq = seqRef(input.seq);
    if (seq) {
      const m = await this.messageAt(client, coworkId, seq);
      if (!m || (own && m.threadId !== own)) throw new HostError("bad_request", `协作「${c.title}」里${own ? "你的事项里" : ""}没有 #${seq}（#序号 见 cowork_read 列出的消息）。`);
      const seen = await this.seenQueued(client, detail.deliveries, mark, [m]);
      return [oneMessageText(m, c), seen].filter(Boolean).join("\n\n");
    }
    if (threadId && threadId !== coworkId && !c.sessions.some((s) => s.id === threadId) && !c.matters?.some((m) => m.id === threadId)) throw new HostError("bad_request", `${threadId} 不是协作「${c.title}」的${c.matters ? "事项" : "子会话"}。开着的${c.matters ? "事项" : "子会话"}在不带 threadId 的 cowork_read 里。`);
    const before = seqRef(input.before);
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
      const matter = c.matters?.find((m) => m.id === threadId);
      const seen = await this.seenQueued(client, detail.deliveries, mark, out.seen);
      // Read in a 事项: 看过 for this agent (the service records it for the feed by itself, not for a thread read).
      if (matter && messages.length) await client.markCowork(coworkId, { mark: "seen", matter: matter.id, upTo: messages[messages.length - 1]!.seq, via: this.via(mark) }).catch(() => undefined);
      return [matter ? mattersSection({ agents: c.agents, matters: [matter] }, mark, null).replace("## 开着的事项", "## 这件事项") : "", out.text, list, seen].filter(Boolean).join("\n\n");
    }
    const after = typeof input.after === "number" && input.after >= 0 ? input.after : this.readAt(coworkId, mark);
    const feed = await this.feedAll(client, coworkId, after, mark);
    this.setReadAt(coworkId, mark, Math.max(after, feed.lastSeq));
    resetCoworkTold(this.store, sessionId, `unread:${coworkId}`);
    setCoworkTell(this.store, sessionId, `unread:${coworkId}`, null);
    const section = messagesSection(feed.messages, c, forMe(feed.messages));
    const v2 = c.matters ? await this.overviewV2(client, c, mark, own) : undefined;
    const overview = coworkOverview({ cowork: c, events: detail.events, drafts: detail.drafts, mark, section, count: feed.messages.length, after, lastSeq: Math.max(after, feed.lastSeq), files: await this.coworkFiles(client, c), ...(v2 ? { v2 } : {}) });
    const seen = await this.seenQueued(client, detail.deliveries, mark, section.full);
    return seen ? `${overview}\n\n${seen}` : overview;
  }

  /** A thread named the ways plans/collab-agent-spec.md §3 allows (「事项 3」, 群聊, a copied line), as a HostError when wrong. */
  private threadOf(c: Cowork, value: unknown): { threadId: string; matter: Matter | null } {
    try {
      return threadRef(c, value);
    } catch (err) {
      throw new HostError("bad_request", err instanceof Error ? err.message : String(err));
    }
  }

  /** The agent's 待我处理 on the service (its 主控's list; an 执行's too). */
  async agentPending(client: RelayClient, coworkId: string, mark: string): Promise<PendingItem[]> {
    const out = await client.coworkPending({ coworkId, party: agentParty(mark) });
    return out.lists.find((l) => l.coworkId === coworkId)?.items ?? [];
  }

  /** cowork_read's parts on a service with 事项: the role, the members with theirs, 开着的事项, 待你处理. */
  private async overviewV2(client: RelayClient, c: Cowork, mark: string, own: string | null): Promise<CoworkOverviewV2> {
    const a = c.agents.find((x) => x.mark === mark);
    const items = await this.agentPending(client, c.id, mark).catch(() => [] as PendingItem[]);
    const wake: WakeItem[] = items.map((item) => ({ item, matter: item.matter ? (c.matters?.find((m) => m.id === item.matter) ?? null) : null }));
    const role = roleLabel(a?.role ?? null, c.matters?.find((m) => m.id === a?.matter));
    const duty = a?.role === "worker" ? "（只在你的事项里贴技术事实；状态、结论、群聊、@ 人是主控的事）" : a?.role === "lead" ? "（理流程、派活、和人沟通、补判断：待核对的核对后标已验、卡在哪、结论）" : "（未分角色：权限照旧，人可以在 Studio 里给你选主控或执行）";
    return { role: `${role}${duty}`, members: membersSection(c, mark, (x) => `${AGENT_STATE_LABEL[x.state]}${x.queued ? `，排队 ${x.queued} 条` : ""}`), sections: [mattersSection(c, mark, own), pendingSection(wake, c, mark)] };
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
   * (an agent as its owner), said here before the call so the AI is told who may instead of a bare 403. On a service with
   * 事项 (2026-11-24) it is the old name of cowork_matter close: the 事项 closes with the conclusion.
   */
  async conclude(sessionId: Id, input: { coworkId?: unknown; threadId?: unknown; conclusion?: unknown }): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client, me } = this.relay();
    const conclusion = text(input.conclusion, "conclusion");
    const detail = await this.call(() => client.cowork(coworkId));
    if (detail.cowork.matters) {
      if (typeof input.threadId === "string" && refId(refId(input.threadId, "thread"), "cowork") === coworkId) throw new HostError("bad_request", "群聊没有结论：定下的事在事项里定（cowork_matter close 带 matter「事项 N」）。");
      return this.matter(sessionId, { coworkId, action: "close", matter: input.threadId, conclusion });
    }
    const threadId = refId(text(input.threadId, "threadId"), "thread");
    const s = detail.cowork.sessions.find((x) => x.id === threadId);
    if (!s) throw new HostError("bad_request", `${threadId} 不是协作「${detail.cowork.title}」的子会话${threadId === coworkId ? "（群聊没有结论：定下的事在子会话里定）" : ""}。子会话在 cowork_read 的「开着的子会话」里。`);
    if (s.state === "done") throw new HostError("bad_request", `子会话「${s.title}」已经结束了${s.conclusion ? `，结论是：${s.conclusion}` : ""}。要改，在群聊里说，或者开一个新的子会话。`);
    if (me !== s.from && me !== s.to) throw new HostError("bad_request", `子会话「${s.title}」是 ${s.from} 问 ${s.to} 的，结论只有他们两边（和他们的 AI）能定。你有意见就用 cowork_post 带 threadId ${s.id} 在里面说。`);
    await this.call(() => client.concludeCowork(coworkId, threadId, conclusion, this.via(mark)));
    return concludedText(s.title, conclusion);
  }

  /** People and AIs named the ways the spec allows (names, 「X 的主控」, marks), each checked; unknown ones refused with who is there. */
  private mentionsOf(c: Cowork, people: unknown, agents: unknown): { mentions: string[]; agentMentions: string[] } {
    const mentions: string[] = [];
    const agentMentions: string[] = [];
    const unknown: string[] = [];
    for (const n of names(people)) {
      const p = personRef(c, n);
      if (p) mentions.push(p);
      else {
        // An AI's name put among the people still reaches it.
        const a = agentRef(c, n);
        if (a) agentMentions.push(a.mark);
        else unknown.push(n);
      }
    }
    for (const n of names(agents)) {
      const a = agentRef(c, n);
      if (a) agentMentions.push(a.mark);
      else unknown.push(n);
    }
    if (unknown.length) throw new HostError("bad_request", `协作「${c.title}」里找不到${unknown.map((u) => `「${u}」`).join("、")}。人：${c.members.join("、")}；AI：${c.agents.map((a) => a.name).join("、") || "没有"}（写名字、「X 的主控」或 mark 都行）。`);
    return { mentions: [...new Set(mentions)], agentMentions: [...new Set(agentMentions)] };
  }

  /**
   * cowork_post: says something in the 群聊 or in a 事项 / 子会话 (threadId: 「事项 3」 too), as the owner's AI. On a service
   * with 事项: `handled` marks what it answers 处理了 (replyTo always is), `supersedes` replaces an earlier message of its own
   * (the AIs that had seen that one are @-ed so they hear of it), `basis` says whether a fact it gives was checked.
   */
  async post(sessionId: Id, input: { coworkId?: unknown; threadId?: unknown; body?: unknown; mentions?: unknown; agentMentions?: unknown; replyTo?: unknown; handled?: unknown; supersedes?: unknown; basis?: unknown; decision?: unknown; notice?: unknown; commits?: unknown; verify?: unknown }): Promise<string> {
    const { coworkId, mark, join } = this.mine(sessionId, input.coworkId);
    const { client, me } = this.relay();
    const { cowork: c } = await this.call(() => client.cowork(coworkId));
    const matters = c.matters !== undefined;
    // 回答的来源 (2026-11-25, protocol/matters.ts MessageBasis): confirmed with my person (which of 已定的事, when given) or my
    // own judgement; the service keeps it on the message and the client marks it. An old service: said at the top instead.
    const decision = typeof input.decision === "number" && Number.isInteger(input.decision) && input.decision > 0 ? input.decision : undefined;
    // Confirmed needs when or which: the 已定的事 named, else the person's last message in this session (what they said here).
    const saidAt = input.basis === "confirmed" && !decision ? this.personSaidAt(sessionId) : null;
    if (input.basis === "confirmed" && !decision && !saidAt) throw new HostError("bad_request", `basis confirmed 要说明是哪次确认的：写 decision（已定的事第几条），或者是 ${me} 在这个会话里说的——这个会话里还没有 ${me} 的话。没确认过就写 basis inferred。`);
    const basis: MessageBasis | undefined = input.basis === "confirmed" ? { kind: "confirmed", person: me, ...(decision ? { decision } : { at: saidAt! }) } : input.basis === "inferred" ? { kind: "inferred", person: me } : undefined;
    const said0 = text(input.body, "body");
    const body = basis && !matters ? `〔${basisText(basis)}〕 ${said0}` : said0;
    // 知会 (people asked to look, no answer wanted), commits pushed (→ 已推送), a verification (→ 待核对, or back to 在做).
    const notice = names(input.notice).map((n) => personRef(c, n) ?? (() => { throw new HostError("bad_request", `知会 notice 写协作里的人（${c.members.join("、")}），「${n}」不在里面。`); })());
    const commits = names(input.commits);
    const verify = input.verify && typeof input.verify === "object" && typeof (input.verify as { passed?: unknown }).passed === "boolean" ? { passed: (input.verify as { passed: boolean }).passed, ...(typeof (input.verify as { how?: unknown }).how === "string" && (input.verify as { how: string }).how.trim() ? { how: (input.verify as { how: string }).how.trim() } : {}) } : undefined;
    const { threadId, matter } = this.threadOf(c, input.threadId);
    const mentioned = this.mentionsOf(c, input.mentions, input.agentMentions);
    const replyTo = seqRef(input.replyTo);
    const supersedes = matters ? seqRef(input.supersedes) : null;
    if (supersedes) {
      // Those who saw the old one hear of the new (SupersedeResult.seenByAgents names them only afterwards).
      const old = await this.messageAt(client, coworkId, supersedes);
      if (!old) throw new HostError("bad_request", `协作「${c.title}」里没有 #${supersedes}。`);
      if (!(old.via.kind === "ai" && old.via.conv === mark)) throw new HostError("bad_request", `#${supersedes} 不是你发的：只能取代自己的消息。`);
      for (const a of seenByAgents(old.receipts ?? [])) if (a !== mark && c.agents.some((x) => x.mark === a)) mentioned.agentMentions.push(a);
    }
    const handled = !matters ? undefined : input.handled === true || input.handled === "all" ? (true as const) : seqsRef(input.handled);
    const out = await this.call(() =>
      client.postCowork(coworkId, {
        kind: "text",
        body,
        ...(threadId !== coworkId ? { threadId } : {}),
        ...(mentioned.mentions.length ? { mentions: mentioned.mentions } : {}),
        ...(mentioned.agentMentions.length ? { agentMentions: [...new Set(mentioned.agentMentions)] } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(supersedes ? { supersedes } : {}),
        ...(handled === true || (Array.isArray(handled) && handled.length) ? { handled } : {}),
        ...(matters && basis ? { basis } : {}),
        ...(matters && notice.length ? { notice } : {}),
        ...(matters && commits.length ? { commits } : {}),
        ...(matters && verify ? { verify } : {}),
        via: this.via(mark),
      }),
    );
    if (out.draft) this.draftMade(join);
    const said = postResultText(out, me, "post");
    if (!matters || out.draft) return said;
    const where = matter ? `事项 ${matter.no}` : threadId === coworkId ? "群聊" : "子会话";
    const extra = [
      `（在${where}）`,
      replyTo ? `#${replyTo} 标成了处理了。` : "",
      notice.length ? `知会了 ${notice.join("、")}。` : "",
      commits.length && matter ? `事项 ${matter.no} 记下了提交 ${commits.join("、")}。` : "",
      verify && matter ? `事项 ${matter.no} 记下了验证${verify.passed ? "通过（待核对）" : "没通过（回到在做）"}。` : "",
      out.superseded ? `#${out.superseded.seq} 标成了「被 #${out.superseded.supersededBy} 取代」${out.superseded.seenByAgents.length ? `，看过它的 AI 收到了新的这条` : ""}。` : "",
      !matter && threadId === coworkId && !mentioned.agentMentions.length && !mentioned.mentions.length ? "群聊只发进度和 @：具体问题进事项（cowork_matter open，或带 threadId 写在已有的事项里）。" : "",
    ].filter(Boolean);
    return `${said}${extra.join("")}`;
  }

  /** When the person last wrote in the session themselves (not a message from an agent or Studio), or null. */
  private personSaidAt(sessionId: Id): number | null {
    const mine = this.store.findItems(sessionId, "user", {}, { newest: true, limit: 50 }).find((i) => i.type === "user" && !i.origin);
    return mine ? Date.parse(mine.createdAt) : null;
  }

  /**
   * cowork_matter (2026-11-24, plans/collab-agent-spec.md §3): open a 事项 (title, body, who carries it, whom it waits on),
   * change one (status, waiting on, blocker, bindings, depends, gate) or close it with its conclusion. A 主控 or a person; the
   * service refuses an 执行 (403) — said here first. `base`: the version read, filled in from the 事项 as read now.
   */
  async matter(sessionId: Id, input: Record<string, unknown>): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client } = this.relay();
    const { cowork: c } = await this.call(() => client.cowork(coworkId));
    // An old service (health cowork < 2): said plainly, not as an error — the AI goes on the old way (2026-11-25).
    if (!c.matters) return OLD_SERVICE.matter;
    const a = c.agents.find((x) => x.mark === mark);
    if (a?.role === "worker") throw new HostError("bad_request", "你是执行会话：不开事项、不改事项的状态和字段、不定结论（这些是主控的事）。要改什么，写进这一轮最后的回复，交回给主控。");
    const action = input.action === "open" || input.action === "close" ? input.action : "update";
    const parties = (v: unknown, what: string): Party[] | undefined => {
      if (v === undefined) return undefined;
      const list = Array.isArray(v) ? v : [v];
      const out: Party[] = [];
      for (const x of list) {
        if (typeof x === "string" && (x === "你" || x === "自己" || x === "我")) {
          out.push(agentParty(mark));
          continue;
        }
        const p = partyRef(c, x);
        if (!p) throw new HostError("bad_request", `${what}里的「${String(x)}」在协作「${c.title}」里找不到。人：${c.members.join("、")}；AI：${c.agents.map((y) => y.name).join("、") || "没有"}。`);
        out.push(p);
      }
      return out;
    };
    const status = input.status === undefined ? undefined : statusRef(input.status);
    if (input.status !== undefined && !status) throw new HostError("bad_request", `status 写 ${Object.entries(MATTER_STATUS_LABEL).map(([k, v]) => `${k}（${v}）`).join("、")} 之一`);
    const gate = typeof input.gate === "string" && input.gate in GATE_LABEL ? (input.gate as GateKind) : undefined;
    const dependsOn = (v: unknown) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map((d) => matterRef(c, d)?.id ?? (() => { throw new HostError("bad_request", `依赖里的「${String(d)}」不是这个协作的事项`); })()));
    if (action === "open") {
      const kind: MatterKind = input.kind === "confirm" || input.kind === "delegate" || input.kind === "notice" ? input.kind : "work";
      const side = typeof input.side === "string" && input.side.trim() ? (personRef(c, input.side) ?? (() => { throw new HostError("bad_request", `负责方 side 写协作里的人（${c.members.join("、")}）：哪一方的主控负责它`); })()) : undefined;
      const waitingOn = parties(input.waitingOn, "在等谁");
      const deps = dependsOn(input.dependsOn);
      if (status === "confirm") throw new HostError("bad_request", "「等人确认」只用在 cowork_ask 开的事项上：要人拍板用 cowork_ask 给那个人。");
      const out = await this.call(() =>
        client.openMatter(coworkId, {
          title: text(input.title, "title").slice(0, 200),
          body: text(input.body, "body"),
          kind,
          ...(side ? { side } : {}),
          ...(status ? { status } : {}),
          ...(waitingOn?.length ? { waitingOn } : {}),
          ...(gate ? { gate } : {}),
          ...(deps?.length ? { dependsOn: deps } : {}),
          ...(typeof input.blocker === "string" && input.blocker.trim() ? { blocker: input.blocker.trim() } : {}),
          via: this.via(mark),
        }),
      );
      const m = out.matter;
      return `开了事项 ${m.no}「${m.title}」（threadId ${m.id}，负责方 ${m.side}，${MATTER_STATUS_LABEL[m.status]}${m.waitingOn.length ? `，在等 ${m.waitingOn.map((p) => partyName(p, c)).join("、")}` : ""}）。在里面说话用 cowork_post 带 threadId「事项 ${m.no}」；派执行会话做它用 session_start 带 matter「事项 ${m.no}」。`;
    }
    const m = matterRef(c, input.matter ?? input.threadId);
    if (!m) throw new HostError("bad_request", `要写是哪件事项（matter：「事项 3」或它的 threadId）。开着的：${(c.matters ?? []).filter((x) => x.status !== "closed").map((x) => `事项 ${x.no}「${x.title}」`).join("、") || "（没有）"}`);
    const patch: MatterPatch = { base: typeof input.base === "number" ? input.base : m.version };
    if (action === "close") {
      if (m.status === "closed") throw new HostError("bad_request", `事项 ${m.no}「${m.title}」已经关了${m.conclusion ? `，结论是：${m.conclusion}` : ""}。要改，在群聊里说，或者开一件新的事项。`);
      // A conclusion is the two sides' (as 子会话 were: its asker and the one asked): this side carries it, opened it, or it
      // waits on this side. Another side's is a gate (动别人的东西).
      const meParty = `person:${this.relay().me}`;
      const mine = m.side === this.relay().me || m.owner === meParty || m.owner === agentParty(mark) || m.waitingOn.some((p) => p === meParty || p === agentParty(mark));
      if (!mine) throw new HostError("bad_request", `事项 ${m.no}「${m.title}」是 ${m.side} 这一方负责的${m.waitingOn.length ? `、在等 ${m.waitingOn.map((p) => partyName(p, c)).join("、")}` : ""}：结论只有他们两边（和他们的 AI）能定。你有意见就用 cowork_post 带 threadId「事项 ${m.no}」在里面说。`);
      patch.status = "closed";
      const conclusion = typeof input.conclusion === "string" && input.conclusion.trim() ? input.conclusion.trim() : null;
      if (conclusion) patch.conclusion = conclusion;
      if (typeof input.note === "string" && input.note.trim()) patch.note = input.note.trim();
    } else {
      if (status) patch.status = status;
      if (status === "confirm" && m.kind !== "confirm") throw new HostError("bad_request", `「等人确认」只用在 cowork_ask 开的事项上；事项 ${m.no} 在等那件事，就写 blocker「卡在 事项 N」。`);
      if (typeof input.title === "string" && input.title.trim()) patch.title = input.title.trim().slice(0, 200);
      if (typeof input.note === "string" && input.note.trim()) patch.note = input.note.trim();
      if (typeof input.side === "string" && input.side.trim()) patch.side = personRef(c, input.side) ?? input.side.trim();
      const waitingOn = parties(input.waitingOn, "在等谁");
      if (waitingOn) patch.waitingOn = waitingOn;
      if (input.blocker !== undefined) patch.blocker = typeof input.blocker === "string" && input.blocker.trim() ? input.blocker.trim() : null;
      const deps = dependsOn(input.dependsOn);
      if (deps) patch.dependsOn = deps;
      if (input.gate !== undefined) patch.gate = gate ?? null;
      if (typeof input.conclusion === "string") patch.conclusion = input.conclusion.trim() || null;
      const binding = (v: unknown) => {
        if (!v || typeof v !== "object") return undefined;
        const b = v as Record<string, unknown>;
        const list = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string" && !!y.trim()) : typeof x === "string" && x.trim() ? [x.trim()] : []);
        const out = { sessions: list(b.sessions).map((s) => agentRef(c, s)?.mark ?? s), tasks: list(b.tasks), commits: list(b.commits) };
        return out.sessions.length || out.tasks.length || out.commits.length ? out : undefined;
      };
      const bind = binding(input.bind);
      const unbind = binding(input.unbind);
      if (bind) patch.bind = bind;
      if (unbind) patch.unbind = unbind;
    }
    let after: Matter;
    try {
      after = await client.patchMatter(coworkId, m.id, { ...patch, via: this.via(mark) });
    } catch (err) {
      if (err instanceof RelayClientError && err.status === 409) throw new HostError("conflict", `事项 ${m.no} 在你读过之后被改过（${err.message}）：先 cowork_read 带 threadId「事项 ${m.no}」看现在的样子，再改。`);
      return this.call(() => Promise.reject(err));
    }
    const changed = after.status !== m.status ? `${MATTER_STATUS_LABEL[m.status]} → ${MATTER_STATUS_LABEL[after.status]}` : MATTER_STATUS_LABEL[after.status];
    return action === "close"
      ? `事项 ${after.no}「${after.title}」关掉了${after.conclusion ? `，结论「${after.conclusion}」记进了已定的事` : ""}；里面的消息都算处理了。状态有变化时在群聊发一句进度（带事项编号）。`
      : `事项 ${after.no}「${after.title}」：${changed}${after.waitingOn.length ? ` · 在等 ${after.waitingOn.map((p) => partyName(p, c)).join("、")}` : ""}${after.blocker ? ` · 卡在 ${after.blocker}` : ""}（版本 ${after.version}）。`;
  }

  /** cowork_mark: 看过 / 处理了 (default) — by #seq, or every message of a 事项 (up to a #seq). */
  async mark(sessionId: Id, input: { coworkId?: unknown; seqs?: unknown; matter?: unknown; upTo?: unknown; mark?: unknown }): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client } = this.relay();
    const { cowork: c } = await this.call(() => client.cowork(coworkId));
    if (!c.matters) return OLD_SERVICE.mark;
    const which = input.mark === "seen" ? "seen" : "handled";
    const seqs = seqsRef(input.seqs);
    const matter = input.matter !== undefined ? matterRef(c, input.matter) : null;
    if (input.matter !== undefined && !matter) throw new HostError("bad_request", `协作「${c.title}」里没有「${String(input.matter)}」这件事项。`);
    if (!seqs.length && !matter) throw new HostError("bad_request", "写要标的消息（seqs：[7, 9] 或「#7」），或一件事项（matter：「事项 3」，可带 upTo）。");
    const upTo = seqRef(input.upTo);
    const out = await this.call(() => client.markCowork(coworkId, { mark: which, ...(seqs.length ? { seqs } : {}), ...(matter ? { matter: matter.id } : {}), ...(upTo ? { upTo } : {}), via: this.via(mark) }));
    const label = which === "seen" ? "看过" : "处理了";
    return out.changed.length ? `标了 ${out.changed.length} 条${label}：${out.changed.map((x) => `#${x.seq}`).join("、")}。` : `没有要标的（已经是${label}，或不是发给你的）。`;
  }

  /**
   * cowork_retract: 撤回 (no body) or 改写 (body) a message of its own while nobody has seen it; once seen, says to post a new
   * one with supersedes.
   */
  async retract(sessionId: Id, input: { coworkId?: unknown; seq?: unknown; body?: unknown }): Promise<string> {
    const { coworkId, mark } = this.mine(sessionId, input.coworkId);
    const { client } = this.relay();
    const { cowork: c } = await this.call(() => client.cowork(coworkId));
    if (!c.matters) return OLD_SERVICE.retract;
    const seq = seqRef(input.seq);
    if (!seq) throw new HostError("bad_request", "seq 写要撤回或改写的那条（「#7」）");
    const body = typeof input.body === "string" && input.body.trim() ? input.body.trim() : null;
    try {
      if (body) await client.rewriteCoworkMessage(coworkId, seq, { body, via: this.via(mark) });
      else await client.withdrawCoworkMessage(coworkId, seq, this.via(mark));
    } catch (err) {
      if (err instanceof RelayClientError && err.status === 409) return `#${seq} 已经有人看过了，不能${body ? "改" : "撤回"}：用 cowork_post 发一条新的，带 supersedes ${seq}（旧的会标成「被取代」，看过旧的 AI 会收到新的）。`;
      if (err instanceof RelayClientError && err.status === 403) throw new HostError("bad_request", `#${seq} 不是你发的：只能撤回或改写自己的消息。`);
      return this.call(() => Promise.reject(err));
    }
    return body ? `#${seq} 改好了（显示「改过」）。` : `#${seq} 撤回了（留一行「已撤回」，没有原文）。`;
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
      const me = detail.cowork.agents.find((a) => a.mark === mark);
      const cards = matterCardsText(detail.cowork, snap.locks, mark, me?.role === "worker" ? (me.matter ?? null) : null);
      return [boardText(items, snap.locks, snap.seq, detail.cowork), cards].filter(Boolean).join("\n\n");
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

  /**
   * 在我的 Studio 里开这一方的主控 (2026-11-24): the 中转 client asks for this side's 主控 here; the workbench asks which
   * session (or a new task) takes it, as for 转到我的会话. Answers at once (the client waits 3 s).
   */
  async leadAsk(coworkIdValue: unknown): Promise<CoworkHandoff> {
    const coworkId = refId(text(coworkIdValue, "coworkId"), "cowork");
    const { client, me } = this.relay();
    const { cowork } = await this.call(() => client.cowork(coworkId));
    if (!cowork.members.includes(me)) throw new HostError("bad_request", `${me} 不在协作「${cowork.title}」里`);
    if (cowork.endedAt !== null) throw new HostError("conflict", `协作「${cowork.title}」已经结束了`);
    const threadId = `${LEAD_ASK}${coworkId}`;
    const h: CoworkHandoff = { threadId, coworkId, coworkTitle: cowork.title, title: cowork.title, from: me, to: me, at: new Date().toISOString(), lead: true };
    this.saveHandoffs([...this.handoffs().filter((x) => x.threadId !== threadId), h], threadId);
    return h;
  }

  /**
   * 让我这一方的主控现在看一遍 (2026-11-25, the 中转 client's `cowork-patrol-<coworkId>`): this side's 主控 here (or, before
   * roles, its 未分角色 sessions) get their 待处理 now — after their turn when one runs. Answers at once (the client waits
   * 3 s); the workbench goes to the 主控.
   */
  patrolSide(coworkIdValue: unknown): { taskId: Id; sessionId: Id } {
    const coworkId = refId(text(coworkIdValue, "coworkId"), "cowork");
    const mine = this.joined().filter((j) => j.coworkId === coworkId && !j.ended && j.role !== "worker");
    const leads = mine.some((j) => j.role === "lead") ? mine.filter((j) => j.role === "lead") : mine;
    if (!leads.length) throw new HostError("not_found", "这台电脑上没有这个协作里你这一方的主控会话：先在中转里点「在我的 Studio 里开这一方的主控」");
    void this.f.pending.patrol(leads.map((j) => j.sessionId)).catch((err: unknown) => this.log(`cowork: patrol of ${coworkId}: ${err instanceof Error ? err.message : String(err)}`));
    const lead = this.store.getSession(leads[0]!.sessionId);
    const taskId = lead?.taskId ?? "";
    this.publish({ type: "ui.open", taskId, sessionId: leads[0]!.sessionId, at: new Date().toISOString() });
    return { taskId, sessionId: leads[0]!.sessionId };
  }

  dismissHandoff(threadIdValue: unknown): { ok: true } {
    const threadId = text(threadIdValue, "threadId");
    this.saveHandoffs(this.handoffs().filter((h) => h.threadId !== threadId));
    return { ok: true };
  }

  /** Takes a handoff: the session (or a new task's) joins the 协作 and gets the 子会话 in full; the workbench goes there. */
  async acceptHandoff(input: { threadId?: unknown; sessionId?: unknown; newTask?: { workspaceId?: unknown; profileId?: unknown } }): Promise<{ taskId: Id; sessionId: Id }> {
    const threadId = text(input.threadId, "threadId");
    if (threadId.startsWith(LEAD_ASK)) return this.acceptLead(threadId, input);
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
    const join = already ?? (await this.join(target.id, h.coworkId, input.newTask ? h.title : undefined, { role: "worker", matter: threadId }));
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

  /** 开这一方的主控: the session (or a new task's) joins as 主控 and gets its card and the 协作 as cowork_read shows it. */
  private async acceptLead(threadId: string, input: { sessionId?: unknown; newTask?: { workspaceId?: unknown; profileId?: unknown } }): Promise<{ taskId: Id; sessionId: Id }> {
    const h = this.handoffs().find((x) => x.threadId === threadId) ?? (await this.leadAsk(threadId.slice(LEAD_ASK.length)));
    const { me } = this.relay();
    // Before a new task is made for nothing: this side may already have its 主控 (the join would refuse it too).
    const taken = (await this.roles(h.coworkId)).lead;
    if (taken && (input.newTask || taken.sessionId !== input.sessionId)) throw new HostError("conflict", `你这一方已经有主控：${taken.name}。要换，先在它的协作那一行把它改成执行，或让它退出协作。`);
    let target: Session;
    if (input.newTask) {
      const workspaceId = text(input.newTask.workspaceId, "newTask.workspaceId");
      const profileId = text(input.newTask.profileId, "newTask.profileId");
      const made = await this.f.tasks.createTask({ title: `协作：${h.coworkTitle}`.slice(0, 200), workspaceId, firstSession: { profileId, title: `${h.coworkTitle} · 主控`.slice(0, 100) } });
      if (!made.session) throw new HostError("runtime_error", "新任务没开出会话");
      target = made.session;
    } else target = this.joinable(text(input.sessionId, "sessionId"));
    const already = this.joined().find((j) => j.sessionId === target.id && j.coworkId === h.coworkId);
    if (already && already.role !== "lead") await this.setRole({ sessionId: target.id, coworkId: h.coworkId, role: "lead" });
    else if (!already) await this.join(target.id, h.coworkId, input.newTask ? "主控" : undefined, { role: "lead" });
    const hint = coworkHint(this.store, target.id);
    const overview = await this.read(target.id, { coworkId: h.coworkId });
    const body = [
      `【协作「${h.coworkTitle}」· ${me} 让你当这一方的主控】`,
      // The line the folded row shows first, then the card.
      `${me} 在 AMO 中转里让这个会话当协作「${h.coworkTitle}」里 ${me} 这一方的主控。先读下面的角色说明、目标、已定的事和事项，和 ${me} 在这个对话里对一下接下来怎么推进；之后有人 @ 你、有事项在等你时，Studio 会把待你处理的送进这个对话。`,
      ...(hint?.lines ?? []),
      overview,
    ].join("\n\n");
    await this.f.sessions.inbox.put(target.id, body, { kind: "cowork", from: me, cowork: { id: h.coworkId, title: h.coworkTitle, where: "让你当这一方的主控" } });
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

/** A session's 待我处理 group in a 协作 (PendingGroup.id): what the patrol and the deliveries name it by. */
export function pendingGroupId(coworkId: string, party: string): string {
  return `cowork:${coworkId}:${party}`;
}
