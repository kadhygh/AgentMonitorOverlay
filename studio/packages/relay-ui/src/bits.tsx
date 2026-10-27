import { VERDICT_LABEL, type Message, type ThreadView } from "./shared.js";

const HUES = [18, 42, 160, 200, 230, 280, 330, 100];

/** A name's initial on a colour picked from the name, so people are told apart at a glance. */
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return (
    <span className={`avatar ${small ? "small" : ""}`} style={{ background: `hsl(${HUES[h % HUES.length]} 32% 42%)` }}>
      {name.slice(0, 1)}
    </span>
  );
}

export function timeText(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** "3 分钟" / "2 小时" — how long something has been waiting. */
export function waitedText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} 小时`;
  return `${Math.floor(m / 60 / 24)} 天`;
}

/** A message in one line, for the list. */
export function preview(m: Message | null): string {
  if (!m) return "";
  const text = m.body.replace(/```[\s\S]*?```/g, "[代码]").replace(/[#>*_`|]/g, "").replace(/\s+/g, " ").trim();
  if (m.kind === "reply") return `${m.verdict ? `【${VERDICT_LABEL[m.verdict]}】` : ""}${m.answers?.length ? `回答了 ${m.answers.length} 个问题 ` : ""}${text}`.trim() || "回复";
  if (m.kind === "event") return `${m.author} ${text}`;
  return text;
}

// ---- sessions (stage 2a, plans/relay-tasks.md): where one stands for me

/** A session back with the asker's AI and not fetched this long is flagged; fetched and untouched this long is 卡住. */
export const AI_LATE_MS = 10 * 60_000;
export const AI_STUCK_MS = 30 * 60_000;

export interface SessionStatus {
  text: string;
  dot: "attn" | "run" | "idle" | "done";
  /** In my 待处理: it waits on me (or on my AI, which has not taken it or seems stuck). */
  needsMe: boolean;
  /** Say it loudly. */
  warn: boolean;
}

/** `limits`: the team's settings in minutes; Studio-wide defaults otherwise. */
export function sessionStatus(t: ThreadView, me: string, now = Date.now(), limits?: { aiLateMinutes: number; aiStuckMinutes: number }): SessionStatus {
  const r = t.request!;
  const lateMs = limits ? limits.aiLateMinutes * 60_000 : AI_LATE_MS;
  const stuckMs = limits ? limits.aiStuckMinutes * 60_000 : AI_STUCK_MS;
  const asker = `${r.from}${r.byAi ? " 的 AI" : ""}`;
  if (r.state === "done") return { text: "已完成", dot: "done", needsMe: false, warn: false };
  if (r.waitingOn !== me) {
    if (r.state === "returned" && r.handler === "ai") return { text: r.pickedAt ? `${r.from} 的 AI 处理中` : `等 ${r.from} 的 AI 取回`, dot: "run", needsMe: false, warn: false };
    return { text: `等 ${r.waitingOn} 处理`, dot: "idle", needsMe: false, warn: false };
  }
  if (r.state === "open") return { text: `${asker} 发来 · 等你处理`, dot: "attn", needsMe: true, warn: true };
  if (r.handler === "person") return { text: "回复已到 · 等你处理", dot: "attn", needsMe: true, warn: true };
  if (r.pickedAt) {
    if (now - r.pickedAt > stuckMs) return { text: `! AI 取回后 ${waitedText(now - r.pickedAt)}没有动作，可能卡住了`, dot: "attn", needsMe: true, warn: true };
    return { text: "AI 已取回，正在处理", dot: "run", needsMe: false, warn: false };
  }
  const late = now - (r.returnedAt ?? now) > lateMs;
  return { text: `回复已到 · AI 还没取回（${waitedText(now - (r.returnedAt ?? now))}）`, dot: late ? "attn" : "run", needsMe: true, warn: late };
}

export function VerdictChip({ thread }: { thread: ThreadView }) {
  const v = thread.request?.verdict;
  return v ? <span className={`chip v-${v}`}>{VERDICT_LABEL[v]}</span> : null;
}
