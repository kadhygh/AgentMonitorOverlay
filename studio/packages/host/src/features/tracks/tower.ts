import { TOWER_SESSION_ROUNDS, inTurn, messageOrigin, originLabel, splitRoleUpdate, type Id, type MessageOrigin, type Session, type SessionItem, type TeamThread, type TowerData, type TowerLine, type TowerMark, type TowerReport, type TowerRoof, type TowerRound, type TowerSession } from "@amo-studio/protocol";
import type { TracksState } from "../../core/tracks.js";

// 脉络的楼 (2026-11-15, protocol/src/tower.ts): a session's rows put together as a building. Everything here is read from
// what Studio already keeps, so a session from before the feature has its building too; only a round's title and line
// may come from its AI (TracksState.rounds), and where it wrote none they are made from the round's own text (the user:
// 允许前面每轮楼板上有信息缺失).

/** A round as it is cut out of the rows, before it is worded. */
export interface RawRound {
  n: number;
  /** The id of its first row: what its AI's title is kept under, and where 「在对话里看这一轮」 goes. */
  firstId: Id;
  startAt: number;
  you: string[];
  /** What came in that was not the person's, in this round. */
  origins: Array<{ origin: MessageOrigin; body: string; itemId: Id; at: number }>;
  work: string[];
  /** Steps beyond the ones listed. */
  more: number;
  ai: string;
  marks: TowerMark[];
  /** Whether anything was done since it began: the next message then begins a new round. */
  worked: boolean;
  /** Titles of what it asked through 中转 (team_ask). */
  asked: string[];
  /** Pending approvals and questions: the rows, for the roof. */
  waiting: Array<{ kind: "approval" | "question"; text: string; itemId: Id }>;
}

const WORK_MAX = 12;
const AI_MAX = 4000;
const YOU_MAX = 2000;

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string, max: number): string => cut(text.replace(/\s+/g, " ").trim(), max);
/** The first line that says something, without Markdown marks. */
const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\s]+/, "").replace(/[*`]/g, "").trim())
    .find(Boolean) ?? "";
/** Up to the first full stop. */
const firstSentence = (text: string): string => {
  const line = firstLine(text);
  const end = line.search(/[。！？!?；;]/);
  return end > 0 ? line.slice(0, end) : line;
};

export function clock(at: number, now: number): string {
  if (!at) return "";
  const d = new Date(at);
  const p = (v: number) => String(v).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

function waited(since: number, now: number): string {
  const min = Math.max(1, Math.round((now - since) / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`;
}

/**
 * A session's rows as rounds: a round begins with a message (the person's, or one put into the session) once the round
 * before it did something; messages that come one after the other before any work are one round's. Also the floor of
 * the last finished compaction.
 */
export function splitRounds(items: readonly SessionItem[]): { rounds: RawRound[]; compact: { after: number; at: number } | null } {
  const rounds: RawRound[] = [];
  // (`null as …`: both are set inside closures and branches the compiler does not follow.)
  let cur = null as RawRound | null;
  let compact = null as { after: number; at: number } | null;
  const begin = (item: SessionItem): RawRound => {
    cur = { n: rounds.length + 1, firstId: item.id, startAt: ms(item.createdAt), you: [], origins: [], work: [], more: 0, ai: "", marks: [], worked: false, asked: [], waiting: [] };
    rounds.push(cur);
    return cur;
  };
  const step = (r: RawRound, line: string) => {
    r.worked = true;
    if (r.work.length < WORK_MAX) r.work.push(oneLine(line, 90));
    else r.more++;
  };
  for (const item of items) {
    if (item.type === "user") {
      // Not in the conversation yet (held in the inbox), or never read by the model.
      if (item.delivery === "held" || item.delivery === "unsent") continue;
      const r: RawRound = !cur || cur.worked ? begin(item) : cur;
      const text = splitRoleUpdate(item.text).text;
      const from = messageOrigin({ text, ...(item.origin ? { origin: item.origin } : {}) });
      if (from) {
        r.origins.push({ origin: from.origin, body: from.body, itemId: item.id, at: ms(item.createdAt) });
        r.you.push(`${originLabel(from.origin)}：${cut(from.body.trim(), 600)}`);
      } else if (text.trim()) r.you.push(text.trim());
      else if (item.images?.length) r.you.push(`（${item.images.length} 张图片）`);
      continue;
    }
    if (item.type === "turn" || item.type === "notice" || item.type === "suggestion" || item.type === "background" || item.type === "reasoning") continue;
    const r: RawRound = cur ?? begin(item);
    if (item.type === "agent") {
      if (item.markdown.trim()) {
        r.ai = item.markdown;
        r.worked = true;
      }
    } else if (item.type === "tool") {
      step(r, item.summary || item.name);
      if (/team_ask$/.test(item.name) && item.input) {
        try {
          const title = (JSON.parse(item.input) as { title?: unknown }).title;
          if (typeof title === "string" && title.trim()) r.asked.push(title.trim());
        } catch {
          // Not JSON (cut short): the line stays without its floor.
        }
      }
    } else if (item.type === "subagent") step(r, `子 agent：${item.summary}`);
    else if (item.type === "error") step(r, `出错：${item.message}`);
    else if (item.type === "command") step(r, `/${item.name}`);
    else if (item.type === "approval") {
      r.worked = true;
      if (item.state === "pending") r.waiting.push({ kind: "approval", text: oneLine(item.summary, 60), itemId: item.id });
    } else if (item.type === "question") {
      r.worked = true;
      if (item.state === "pending") r.waiting.push({ kind: "question", text: item.source === "plan-review" ? "看一份计划" : oneLine(item.questions?.[0]?.question ?? item.message ?? "有问题问你", 60), itemId: item.id });
    } else if (item.type === "compaction") {
      if (item.state === "completed") compact = { after: r.n, at: ms(item.createdAt) };
    }
  }
  return { rounds, compact };
}

/** The round as the building shows it: the AI's title when it wrote one, else one made from the round's text. */
function word(r: RawRound, labels: TracksState["rounds"], now: number, extra: Partial<TowerRound> = {}): TowerRound {
  const label = labels[r.firstId];
  // A round something else began says what it was (a report, a reply); the message that opened a session, or one
  // its opener sent on, is its task — its own first line says more than 「会话 X 开启了这个会话」.
  const from = r.you.length === 1 ? r.origins[0] : undefined;
  const first = from ? (from.origin.kind === "start" || from.origin.kind === "send" ? firstLine(from.body) || originLabel(from.origin) : originLabel(from.origin)) : firstLine(r.you[0] ?? "");
  const title = label?.title || oneLine(first, 18) || "（没有文字）";
  const desc = label?.desc || oneLine(firstSentence(r.ai), 40);
  const work = r.more ? [...r.work, `…还有 ${r.more} 步`] : r.work;
  return { n: r.n, time: clock(r.startAt, now), title, desc, labelled: Boolean(label?.title), you: cut(r.you.join("\n\n"), YOU_MAX), work, ai: cut(r.ai, AI_MAX), ...(r.marks.length ? { items: r.marks } : {}), itemId: r.firstId, ...extra };
}

/** The floor of the main session at a time: its last round that had begun by then. */
function floorAt(rounds: readonly RawRound[], at: number): number {
  let floor = 1;
  for (const r of rounds) if (r.startAt <= at) floor = r.n;
  return floor;
}

/** A, B … Z, AA, AB …: the sub-sessions in the order they were started. */
export function letter(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

function sessionState(s: Session): TowerMark {
  if (s.archivedAt) return { s: "done", t: "已归档" };
  if (s.status === "running") return { s: "ai", t: "在跑" };
  if (s.status === "awaiting-approval") return { s: "you", t: "等你审批" };
  if (s.status === "awaiting-answer" || s.status === "awaiting-review") return { s: "you", t: "等你回答" };
  if (s.status === "error") return { s: "you", t: "出错停下了" };
  if (s.status === "interrupted") return { s: "you", t: "被停下了，还没有结论" };
  return { s: "done", t: "这一轮做完了" };
}

export interface TowerSources {
  session: Session;
  items: readonly SessionItem[];
  /** The sessions it started (session_start), oldest first, each with its rows. */
  subs: ReadonlyArray<{ session: Session; items: readonly SessionItem[] }>;
  /** 中转 sessions, as last seen (all of this computer's; the ones of these sessions are picked out). */
  threads: readonly TeamThread[];
  state: TracksState;
  now: number;
}

export function buildTower({ session, items, subs, threads, state, now }: TowerSources): TowerData {
  const main = splitRounds(items);
  const last = main.rounds.at(-1);
  const reports: TowerReport[] = [];
  const roof: TowerRoof[] = [];
  const lines: TowerLine[] = [];

  // The sub-sessions, each a region on the floor that started it.
  const sessions: TowerSession[] = [];
  const subRounds = new Map<Id, RawRound[]>();
  subs.forEach(({ session: s, items: rows }, i) => {
    const key = letter(i);
    const raw = splitRounds(rows).rounds;
    subRounds.set(s.id, raw);
    const mark = sessionState(s);
    const kept = raw.slice(-TOWER_SESSION_ROUNDS);
    const rounds = kept.map((r) => {
      for (const w of r.waiting) r.marks.push({ s: "you", t: w.kind === "approval" ? `等你审批：${w.text}` : `等你回答：${w.text}` });
      if (r === raw.at(-1) && !r.marks.length) r.marks.push(mark);
      return word(r, {}, now, { at: floorAt(main.rounds, r.startAt) });
    });
    const at = floorAt(main.rounds, ms(s.createdAt));
    sessions.push({ key, sessionId: s.id, title: s.title || "未命名会话", at, rounds, total: raw.length, state: mark });
    const tail = rounds.at(-1);
    if (!tail) return;
    const origin = `${key}-${tail.n}`;
    // One card on the roof per sub-session that is not over: what waits for the person first, then for someone else.
    const asked = threads.filter((t) => t.sessionId === s.id && t.state === "open");
    if (mark.s === "you") roof.push({ key: `roof:${key}`, s: "you", origin, title: `${key} ${mark.t}`, desc: oneLine(`${s.title || "未命名会话"} · ${tail.title}`, 60), ...(s.status === "awaiting-approval" ? { sign: "待你审批" } : s.status === "awaiting-answer" || s.status === "awaiting-review" ? { sign: "等你回答" } : {}), sessionId: s.id });
    else if (mark.s === "ai") roof.push({ key: `roof:${key}`, s: "ai", origin, title: `${key} 在跑`, desc: oneLine(`${s.title || "未命名会话"} · ${tail.title}`, 60), sessionId: s.id });
    else if (asked.length && !s.archivedAt) roof.push({ key: `roof:${key}`, s: "other", origin, title: `${key} 在等 ${asked[0]!.to} 回`, desc: oneLine(asked[0]!.title, 60), sessionId: s.id });
  });
  const keyOf = new Map(sessions.map((s) => [s.sessionId, s] as const));

  // What came back into the main session: a small card on the floor it arrived at.
  const askedOn = new Map<string, number>();
  for (const r of main.rounds) for (const title of r.asked) askedOn.set(title, r.n);
  const mine = threads.filter((t) => t.sessionId === session.id);
  const repliesOf = new Map<string, TowerReport[]>();
  for (const r of main.rounds) {
    r.origins.forEach((o, i) => {
      const key = `r${r.n}-${i + 1}`;
      const desc = oneLine(firstLine(o.body) || o.body, 60);
      if (o.origin.kind === "report") {
        const sub = o.origin.sessionId ? keyOf.get(o.origin.sessionId) : undefined;
        if (!sub) return;
        // The sub-session's round that had begun when the report came: the one it tells of.
        let round = 1;
        for (const sr of subRounds.get(sub.sessionId) ?? []) if (sr.startAt <= o.at) round = sr.n;
        const how = o.origin.state === "stopped" ? "被停下了" : o.origin.state === "failed" ? "出错停下了" : "回报";
        reports.push({ key, from: `${sub.key}-${round}`, sess: sub.key, round, floor: r.n, title: `${sub.key} ${how}`, desc, meta: clock(o.at, now), itemId: o.itemId });
      } else if (o.origin.kind === "team") {
        const ids = o.origin.threadIds ?? [];
        const asked = ids.map((id) => mine.find((t) => t.threadId === id)).find((t) => t && askedOn.has(t.title.trim()));
        const from = asked ? askedOn.get(asked.title.trim())! : 0;
        const rep: TowerReport = { key, from: from ? `m${from}` : "", sess: "main", round: from || r.n, floor: r.n, title: oneLine(originLabel(o.origin), 24), desc, meta: clock(o.at, now), itemId: o.itemId };
        reports.push(rep);
        for (const id of ids) repliesOf.set(id, [...(repliesOf.get(id) ?? []), rep]);
      }
    });
  }

  // What the main session itself asked through 中转: a line from the floor that asked to the floor the answer came to,
  // and a card on the roof while it still waits.
  for (const t of mine) {
    const from = askedOn.get(t.title.trim());
    const reps = repliesOf.get(t.threadId) ?? [];
    const what = `问 ${t.to}：${oneLine(t.title, 30)}`;
    const line = from && reps.length ? `line:${t.threadId}` : "";
    if (line) lines.push({ key: line, origin: `m${from}`, from: from!, to: Math.max(...reps.map((r) => r.floor)), s: t.state === "open" ? "other" : "done", title: what, reps: reps.map((r) => r.key) });
    if (t.state === "open") roof.push({ key: `roof:t:${t.threadId}`, s: "other", origin: `m${from ?? last?.n ?? 1}`, title: `等 ${t.to} 回复`, desc: `${oneLine(t.title, 40)} · 等了 ${waited(t.since, now)}`, ...(line ? { line } : {}) });
  }

  // What waits for the person in the main session itself.
  for (const r of main.rounds) {
    for (const w of r.waiting) {
      r.marks.push({ s: "you", t: w.kind === "approval" ? `等你审批：${w.text}` : `等你回答：${w.text}` });
      roof.unshift({ key: `roof:${w.itemId}`, s: "you", origin: `m${r.n}`, title: w.kind === "approval" ? `等你审批：${w.text}` : `等你回答：${w.text}`, desc: `${r.n}F`, sign: w.kind === "approval" ? "待你审批" : "等你回答", itemId: w.itemId });
    }
    const started = sessions.filter((s) => s.at === r.n);
    if (started.length) r.marks.push({ s: started.some((s) => s.state.s !== "done") ? "ai" : "done", t: `开了子会话 ${started.map((s) => s.key).join("、")}` });
  }
  if (last && inTurn(session.status) && !last.waiting.length) last.marks.push({ s: "ai", t: "AI 在做" });

  // What waits for the person goes first on the roof, then what waits for someone else, then what the AI works on.
  const order = ["you", "other", "ai", "inter", "done"];
  roof.sort((a, b) => order.indexOf(a.s) - order.indexOf(b.s));

  return {
    sessionId: session.id,
    on: state.on,
    title: session.title || "未命名会话",
    rounds: main.rounds.map((r) => word(r, state.rounds, now)),
    sessions,
    reports,
    roof,
    lines,
    compact: main.compact ? { after: main.compact.after, time: clock(main.compact.at, now) } : null,
    points: state.points,
    now: clock(now, now),
  };
}
