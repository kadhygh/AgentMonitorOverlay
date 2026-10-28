import { createContext, useContext } from "react";
import { VERDICT_LABEL, type Member, type Message, type ThreadView } from "./shared.js";

const HUES = [18, 42, 160, 200, 230, 280, 330, 100];

/** Who is who (name → member, with nickname and picture), provided by the signed-in screen. */
export const PeopleContext = createContext<ReadonlyMap<string, Member>>(new Map());
export const usePeople = () => useContext(PeopleContext);

/** The colour of someone's initial: picked from the account name, so it stays when the nickname changes. */
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return `hsl(${HUES[h % HUES.length]} 32% 42%)`;
}

/** Their picture, or their initial on a colour picked from the name, so people are told apart at a glance. */
export function Avatar({ name, small = false, big = false }: { name: string; small?: boolean; big?: boolean }) {
  const m = usePeople().get(name);
  const cls = `avatar ${small ? "small" : ""} ${big ? "big" : ""}`;
  if (m?.avatar) return <img className={cls} src={m.avatar} alt="" />;
  return (
    <span className={cls} style={{ background: avatarColor(name) }}>
      {(m?.nick || name).slice(0, 1)}
    </span>
  );
}

/** A name as shown: the nickname, then the account name faintly; just the name without a nickname. */
export function Who({ name }: { name: string }) {
  const m = usePeople().get(name);
  return m?.nick ? (
    <>
      {m.nick}
      <span className="aka">({name})</span>
    </>
  ) : (
    <>{name}</>
  );
}

/** The same as text, for places that take a string. */
export function useDisplayName(): (name: string) => string {
  const people = usePeople();
  return (name) => people.get(name)?.nick || name;
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

/** A session the asker's AI fetched and left untouched this long is 卡住. Back and not fetched, it is the asker's at
 * once: since 2026-10-28 the AI does not wait for a reply, the asker copies it over (plans/relay-tasks.md「卡点」). */
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
  const stuckMs = limits ? limits.aiStuckMinutes * 60_000 : AI_STUCK_MS;
  const asker = `${r.from}${r.byAi ? " 的 AI" : ""}`;
  if (r.state === "done") return { text: "已完成", dot: "done", needsMe: false, warn: false };
  if (r.waitingOn !== me) {
    if (r.state === "returned" && r.handler === "ai") return { text: r.pickedAt ? `${r.from} 的 AI 处理中` : `已返回给 ${r.from}`, dot: "run", needsMe: false, warn: false };
    return { text: `等 ${r.waitingOn} 处理`, dot: "idle", needsMe: false, warn: false };
  }
  if (r.state === "open") return { text: `${asker} 发来 · 等你处理`, dot: "attn", needsMe: true, warn: true };
  if (r.handler === "person") return { text: "回复已到 · 等你处理", dot: "attn", needsMe: true, warn: true };
  if (r.pickedAt) {
    if (now - r.pickedAt > stuckMs) return { text: `! AI 取回后 ${waitedText(now - r.pickedAt)}没有动作，可能卡住了`, dot: "attn", needsMe: true, warn: true };
    return { text: "AI 已取回，正在处理", dot: "run", needsMe: false, warn: false };
  }
  return { text: "回复已到 · 复制给 AI 继续", dot: "attn", needsMe: true, warn: true };
}

export function VerdictChip({ thread }: { thread: ThreadView }) {
  const v = thread.request?.verdict;
  return v ? <span className={`chip v-${v}`}>{VERDICT_LABEL[v]}</span> : null;
}
