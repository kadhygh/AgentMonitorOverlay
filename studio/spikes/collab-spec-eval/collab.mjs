// The 协作 column of plans/collab-agent-spec.md 第 3 节, simulated: 事项, messages with per-recipient receipts
// (送到 / 看过 / 处理了), 待你处理, the executors' limits (rejected and logged), retract / supersede, notes, a board.
// State is one JSON file (state.json in the run's folder), written after every change, so the driver, the MCP server
// and the scorer read the same thing. Nothing here talks to a model.

import { writeFileSync } from "node:fs";

export const STATUSES = ["待开始", "在做", "等对方", "等人确认", "已推送", "待核对", "已验", "久没动静", "关闭"];
// 11-25 (the user, after the 11-24 notes): a 事项's status follows its events; the lead only adds judgement (已验 after
// checking, 卡在哪, the conclusion). A status set by hand wins until the next event and is recorded as 「手改」.
//   bound an executor / it started → 在做 · the last @ or reply in it points at an AI of the other side and is not
//   answered → 等对方 (waiting on it) · cowork_ask → 等人确认, the person answered → 在做 · a pushed commit named in it
//   → 已推送 · the executor posted a passing check on a pushed commit → 待核对 · the lead checked → 已验 · closed with a
//   conclusion → 关闭 · 在做 with no event for 2 hours (scaled down here: staleMs) → 久没动静, in the owner's 待我处理.
const HASH_RE = /\b[0-9a-f]{7,40}\b/g;
// A passing check as executors write it: 「npm test 12 passed、0 failed」「19 过 0 败」「全过」「通过」.
export const PASS_RE = /(\d+\s*(passed|pass|通过|过))|全过|全部通过|测试通过|通过[，,。]|\b0\s*(failed|fail)|0\s*(失败|败)/i;
const FAIL_RE = /\b[1-9]\d*\s*(failed|fail)\b|(^|[^\d])[1-9]\d*\s*(失败|败|挂|红)|未通过|没通过|不通过|挂了|挂的是/i;
const hhmm = (t = Date.now()) => new Date(t).toTimeString().slice(0, 5);

export class Collab {
  constructor(file, { title, ref, goal, decisions, people, onOrigin = () => false, staleMs = 2 * 3600_000 }) {
    this.file = file;
    this.onOrigin = onOrigin; // hash → is it in the shared repository
    this.staleMs = staleMs;
    this.s = {
      cowork: { title, ref, goal, decisions: decisions.map((text) => ({ text, src: "协作开始时", at: Date.now() })) },
      people, // { 小王: { side: "W" }, 老李: { side: "L" } }
      agents: {}, // key -> { key, name, role: lead|exec, side, person?, lead?, matter?, joinedAt }
      matters: [],
      messages: [],
      notes: [],
      board: [],
      violations: [],
      calls: [], // every tool call: { at, agent, turn, tool, input, ok, write, error }
      reminders: [], // supersede reminders: { to, oldSeq, newSeq, at, delivered }
      seq: 0,
      matterNo: 0,
      boardId: 0,
      roundsCap: [],
    };
    this.listeners = [];
    this.save();
  }

  save() {
    writeFileSync(this.file, JSON.stringify(this.s, null, 1));
  }
  on(fn) {
    this.listeners.push(fn);
  }
  emit(ev) {
    for (const fn of this.listeners) fn(ev);
  }

  // ---- who and what

  addAgent(a) {
    this.s.agents[a.key] = { joinedAt: Date.now(), ...a };
    this.save();
    return this.s.agents[a.key];
  }
  agent(key) {
    return this.s.agents[key];
  }
  leads() {
    return Object.values(this.s.agents).filter((a) => a.role === "lead");
  }
  leadOf(side) {
    return this.leads().find((a) => a.side === side);
  }
  nameOf(who) {
    return this.s.agents[who]?.name ?? who;
  }
  /** An agent by key, display name, @name, or an executor's title; or a person's name. */
  resolveWho(ref) {
    if (ref == null) return null;
    const r = String(ref).trim().replace(/^@/, "");
    if (this.s.people[r]) return r;
    if (this.s.agents[r]) return r;
    const a = Object.values(this.s.agents).find((x) => x.name === r || x.title === r || `${x.name}`.replace(/的主控$/, "") + "的主控" === r);
    if (a) return a.key;
    // 「老李的主控」 written as 「老李主控」, 「老李那边的主控」…
    const m = /^(.+?)(?:那边|这一方|一方)?的?主控$/.exec(r);
    if (m && this.s.people[m[1]]) return this.leadOf(this.s.people[m[1]].side)?.key ?? null;
    return null;
  }
  matter(ref) {
    if (ref == null || ref === "") return null;
    const m = /(\d+)/.exec(String(ref));
    if (!m) return null;
    return this.s.matters.find((x) => x.no === Number(m[1])) ?? null;
  }
  msg(ref) {
    const m = /(\d+)/.exec(String(ref ?? ""));
    return m ? this.s.messages.find((x) => x.seq === Number(m[1])) ?? null : null;
  }
  where(m) {
    return m.where === "chat" ? "群聊" : `事项 ${m.where}`;
  }
  isPerson(who) {
    return !!this.s.people[who];
  }

  // ---- matters

  openMatter({ title, owner, waiting = [], status = "待开始", by, kind = "normal", about = null, gate = null }) {
    const no = ++this.s.matterNo;
    // Opening it waiting on another AI counts as an @ of it (第 3 节: 要对方做什么，就开一件、在等谁设成对方主控).
    const aiWait = waiting.filter((w) => this.s.agents[w] && w !== by);
    const personWait = waiting.filter((w) => this.s.people[w]);
    const m = { no, title, owner, side: this.s.agents[owner]?.side ?? this.s.people[owner]?.side, status: "待开始", waiting: [], waitVersion: 1, base: "待开始", aiWait, personWait, manual: null, lastEventAt: Date.now(), blocked: "", conclusion: "", binds: { exec: [], commits: [] }, kind, about, gate, openedBy: by, openedAt: Date.now(), closedAt: null, hist: [], posters: [by], checks: [] };
    this.s.matters.push(m);
    this.recompute(m, kind === "confirm" ? "cowork_ask" : "开", by);
    this.save();
    this.emit({ kind: "matter-open", matter: m, by });
    return m;
  }
  /** The lead's judgement (已验, 卡在哪, commits, title) or a status / waiting set by hand (手改). */
  updateMatter(m, fields, by) {
    const before = { status: m.status, waiting: [...m.waiting] };
    if (fields.title) m.title = fields.title;
    if (fields.blocked !== undefined) m.blocked = fields.blocked;
    if (fields.commits) m.binds.commits = [...new Set([...m.binds.commits, ...fields.commits])];
    if (fields.conclusion !== undefined) m.conclusion = fields.conclusion;
    let cause = fields.blocked !== undefined ? (fields.blocked ? `卡在 ${fields.blocked}` : "清掉卡在哪") : fields.commits ? "绑提交" : "改字段";
    if (fields.status === "已验") {
      // 核对 is the lead's judgement, not a hand override: the events go on from it.
      m.base = "已验";
      m.manual = null;
      m.aiWait = [];
      cause = "核对";
    } else if (fields.status || fields.waiting) {
      m.manual = { status: fields.status ?? null, waiting: fields.waiting ?? null, by, at: Date.now() };
      cause = "手改";
    }
    this.recompute(m, cause, by, { force: fields.blocked !== undefined || !!fields.commits, manual: cause === "手改" });
    this.emit({ kind: "matter-update", matter: m, by, before, fields });
  }

  /** An event in a 事项 (第 0 节): it may move the base status, and it ends a hand override. */
  event(m, cause, { by = "事件", base = null, aiWait, personWait } = {}) {
    if (!m || m.closedAt) return;
    m.lastEventAt = Date.now();
    m.manual = null;
    if (base) m.base = base;
    if (aiWait) m.aiWait = aiWait;
    if (personWait) m.personWait = personWait;
    this.recompute(m, cause, by);
  }

  /** Display status and waiting from base / waits / hand override; the history records each change and its cause. */
  recompute(m, cause, by, { force = false, manual = false } = {}) {
    const before = { status: m.status, waiting: [...m.waiting] };
    let status, waiting;
    if (m.closedAt) [status, waiting] = ["关闭", []];
    else if (m.manual) [status, waiting] = [m.manual.status ?? m.status, m.manual.waiting ?? m.waiting];
    else if (m.personWait.length) [status, waiting] = ["等人确认", m.personWait];
    else if (m.aiWait.length) [status, waiting] = ["等对方", m.aiWait];
    else [status, waiting] = [m.base, []];
    m.status = status;
    if (JSON.stringify(waiting) !== JSON.stringify(m.waiting)) m.waitVersion++;
    m.waiting = [...waiting];
    if (force || !m.hist.length || status !== before.status || JSON.stringify(m.waiting) !== JSON.stringify(before.waiting))
      m.hist.push({ at: Date.now(), from: m.hist.length ? before.status : "", to: status, by, cause, manual: manual || undefined, waiting: [...m.waiting], blocked: m.blocked || undefined });
    this.save();
  }

  /** 久没动静: 在做 with no event for staleMs; computed when read, so it shows in 待我处理 without a timer. */
  isStale(m) {
    return !m.closedAt && m.status === "在做" && Date.now() - m.lastEventAt > this.staleMs;
  }
  /** An executor bound to it (session_start) or starting a turn: 在做 (第 0 节). */
  execStarted(m, key, cause) {
    if (m.base === "待开始") this.event(m, cause, { by: key, base: "在做" });
    else m.lastEventAt = Date.now();
  }
  closeMatter(m, conclusion, by) {
    const before = m.status;
    m.status = "关闭";
    m.conclusion = conclusion;
    m.waiting = [];
    m.waitVersion++;
    m.closedAt = Date.now();
    m.manual = null;
    m.hist.push({ at: Date.now(), from: before, to: "关闭", by, cause: "定结论", conclusion });
    // Closing settles everything in it, for everyone.
    for (const x of this.s.messages) if (x.where === m.no) for (const w of Object.keys(x.rc)) x.rc[w].done ??= Date.now();
    if (conclusion) this.s.cowork.decisions.push({ text: conclusion, src: `事项 ${m.no} · ${this.nameOf(by)}`, at: Date.now() });
    this.save();
    this.emit({ kind: "matter-close", matter: m, by });
  }

  /** Who a message in a 事项 goes to: its owner, whoever it waits on, its executors, the leads who wrote in it. */
  matterRecipients(m) {
    const set = new Set([m.owner, ...m.waiting, ...m.binds.exec, ...m.posters.filter((p) => this.s.agents[p]?.role === "lead")]);
    return [...set].filter(Boolean);
  }

  // ---- messages

  post({ from, where = "chat", body, replyTo = null, mentions = [], agentMentions = [], kind = "text", supersedes = null, to = null, basis = null }) {
    const seq = ++this.s.seq;
    let recipients;
    if (to) recipients = to;
    else if (where === "chat") recipients = [...Object.keys(this.s.people), ...this.leads().map((a) => a.key)];
    else {
      const m = this.matter(where);
      if (!m.posters.includes(from)) m.posters.push(from);
      recipients = this.matterRecipients(m);
    }
    recipients = [...new Set([...recipients, ...mentions, ...agentMentions])].filter((w) => w && w !== from);
    const msg = { seq, where, from, body, replyTo, mentions, agentMentions, kind, to: recipients, rc: {}, at: Date.now(), retracted: false, edits: [], supersedes, supersededBy: null, basis };
    for (const w of recipients) msg.rc[w] = { delivered: Date.now() };
    this.s.messages.push(msg);
    if (replyTo) {
      const r = this.msg(replyTo);
      if (r?.rc[from]) r.rc[from].done ??= Date.now();
    }
    if (supersedes) {
      const old = this.msg(supersedes);
      if (old) {
        old.supersededBy = seq;
        for (const [w, st] of Object.entries(old.rc)) if (st.seen && this.s.agents[w] && w !== from) this.s.reminders.push({ to: w, oldSeq: old.seq, newSeq: seq, at: Date.now(), delivered: null });
      }
    }
    this.matterEvents(msg);
    this.checkRoundsCap(msg);
    this.save();
    this.emit({ kind: "post", msg });
    return msg;
  }

  /** What a message does to its 事项's status (第 0 节 第 1 条). */
  matterEvents(msg) {
    if (msg.where === "chat") return;
    const m = this.matter(msg.where);
    if (!m || m.closedAt) return;
    const from = msg.from;
    if (this.isPerson(from)) {
      // A person answering a 等人确认 → 在做.
      if (m.personWait.includes(from)) this.event(m, `${from} 回了`, { by: from, base: m.base === "待开始" ? "在做" : m.base, personWait: m.personWait.filter((w) => w !== from) });
      return;
    }
    if (!this.s.agents[from]) return;
    // Who it points at: the AIs it @-s, or the AI whose message it answers — only AIs of the other side count.
    const replyTo = msg.replyTo ? this.msg(msg.replyTo) : null;
    const side = this.s.agents[from].side;
    const targets = [...new Set([...msg.agentMentions, ...(replyTo && this.s.agents[replyTo.from] ? [replyTo.from] : [])])].filter((w) => w !== from && this.s.agents[w] && this.s.agents[w].side !== side);
    let aiWait = m.aiWait.filter((w) => w !== from);
    if (targets.length) aiWait = targets;
    // An executor's commits: pushed → 已推送; with a passing check → 待核对.
    let base = null;
    if (this.s.agents[from].role === "exec") {
      const hashes = [...new Set(msg.body.match(HASH_RE) ?? [])].filter((h) => /\d/.test(h) && /[a-f]/.test(h));
      const pushed = hashes.filter((h) => this.onOrigin(h));
      if (pushed.length) {
        const fresh = pushed.some((h) => !m.binds.commits.some((c) => c.startsWith(h) || h.startsWith(c)));
        m.binds.commits = [...new Set([...m.binds.commits, ...pushed])];
        const pass = PASS_RE.test(msg.body) && !FAIL_RE.test(msg.body);
        msg.derived = { pushed, pass, fresh };
        // The same commits again after 已验 (a repeated report) do not undo the check.
        if (fresh || m.base !== "已验") base = pass ? "待核对" : m.base === "待核对" && !fresh ? null : "已推送";
      }
    }
    const waitChanged = JSON.stringify(aiWait) !== JSON.stringify(m.aiWait);
    if (base || waitChanged) this.event(m, base ? (base === "待核对" ? "执行贴了通过的验证" : "推送了") : targets.length ? `@ / 回 ${targets.map((w) => this.nameOf(w)).join("、")}` : "回了", { by: from, base, aiWait });
    else m.lastEventAt = Date.now();
  }
  seen(msg, who) {
    if (msg.rc[who]) msg.rc[who].seen ??= Date.now();
  }
  done(msg, who) {
    if (msg.rc[who]) {
      msg.rc[who].seen ??= Date.now();
      msg.rc[who].done ??= Date.now();
    }
  }

  /** 第 7 节: 30 AI messages in one 事项 with no person in between → 等人确认, both sides' people. */
  checkRoundsCap(msg) {
    if (msg.where === "chat") return;
    const m = this.matter(msg.where);
    if (!m || m.status === "关闭" || m.status === "等人确认") return;
    const list = this.s.messages.filter((x) => x.where === m.no && !x.retracted);
    let n = 0;
    for (let i = list.length - 1; i >= 0 && !this.isPerson(list[i].from); i--) n++;
    if (n >= 30) {
      m.personWait = Object.keys(this.s.people);
      this.recompute(m, "30 轮上限", "服务器");
      this.s.roundsCap.push({ matter: m.no, at: Date.now() });
      this.post({ from: "服务器", body: `事项 ${m.no}「${m.title}」里两个 AI 来回了 30 轮，没有人说话：标成等人确认，先不再叫醒 AI。`, kind: "event" });
    }
  }

  /** 待你处理 for an agent: @ you / reply to you / sent to you in a 事项, not 处理了; 事项 waiting on you; reminders. */
  pendingFor(who) {
    const out = [];
    for (const m of this.s.messages) {
      if (m.retracted || m.from === who || !m.rc[who] || m.rc[who].done) continue;
      const atMe = m.agentMentions.includes(who) || m.mentions.includes(who);
      const replyToMe = m.replyTo && this.msg(m.replyTo)?.from === who;
      const inMatter = m.where !== "chat";
      if (atMe || replyToMe || inMatter) out.push({ key: `msg:${m.seq}`, kind: "msg", seq: m.seq, matter: inMatter ? m.where : null, atMe, replyToMe, full: atMe || replyToMe });
    }
    for (const m of this.s.matters) {
      if (m.status === "关闭") continue;
      if (m.waiting.includes(who)) out.push({ key: `matter:${m.no}:${m.waitVersion}`, kind: "matter", matter: m.no });
      else if (m.owner === who && m.status === "待核对") out.push({ key: `verify:${m.no}:${m.hist.length}`, kind: "verify", matter: m.no });
      else if (m.owner === who && this.isStale(m)) out.push({ key: `stale:${m.no}:${m.lastEventAt}`, kind: "stale", matter: m.no });
    }
    for (const r of this.s.reminders) if (r.to === who && !r.delivered) out.push({ key: `rem:${r.oldSeq}:${r.newSeq}`, kind: "reminder", reminder: r });
    return out;
  }

  // ---- reading, for tools and wake messages

  line(m, { full = false, max = 160 } = {}) {
    const who = this.isPerson(m.from) ? m.from : this.nameOf(m.from);
    let body = m.retracted ? "（已撤回）" : m.body;
    if (!full && body.length > max) body = body.slice(0, max) + "…";
    const tags = [];
    if (m.replyTo) tags.push(`回 #${m.replyTo}`);
    const at = [...m.mentions, ...m.agentMentions.map((k) => this.nameOf(k))];
    if (at.length) tags.push(`@ ${at.join("、")}`);
    if (m.supersedes) tags.push(`取代 #${m.supersedes}`);
    if (m.supersededBy) tags.push(`已被 #${m.supersededBy} 取代`);
    if (m.edits.length) tags.push("改过");
    if (m.kind === "report") tags.push("执行会话交回的结果");
    if (m.kind === "delegate") tags.push("派活");
    if (m.basis) tags.push(m.basis.kind === "confirmed" ? `来源：已和${m.basis.person ?? "人"}确认（${m.basis.ref ?? "—"}）` : `来源：我的判断，${m.basis.person ?? "人"}没确认过`);
    return `#${m.seq} ${hhmm(m.at)} ${who}${tags.length ? `（${tags.join("，")}）` : ""}：${body}`;
  }
  matterLine(m) {
    const last = m.hist.at(-1);
    const parts = [`事项 ${m.no}「${m.title}」`, `负责 ${this.nameOf(m.owner)}`, this.isStale(m) ? "久没动静（在做，很久没有事件）" : m.status + (m.manual ? "（手改）" : "")];
    parts.push(`在等 ${m.waiting.length ? m.waiting.map((w) => this.nameOf(w)).join("、") : "—"}`);
    if (m.blocked) parts.push(`卡在 ${m.blocked}`);
    if (m.binds.exec.length) parts.push(`执行：${m.binds.exec.map((k) => this.nameOf(k)).join("、")}`);
    if (m.binds.commits.length) parts.push(`提交：${m.binds.commits.join(" ")}`);
    if (m.kind === "confirm") parts.push("（等人确认）");
    if (m.conclusion) parts.push(`结论：${m.conclusion}`);
    if (last && !m.closedAt) parts.push(`最近：${hhmm(last.at)} ${last.cause ?? ""}（${this.nameOf(last.by)}）`);
    return parts.join(" · ");
  }
}

export { hhmm };
