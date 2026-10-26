import { VERDICT_LABEL, type Message, type ThreadView } from "./shared.js";

const HUES = [18, 42, 160, 200, 230, 280, 330, 100];

/** A name's initial on a colour picked from the name, so people are told apart at a glance. */
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return (
    <span className={`avatar ${small ? "small" : ""}`} style={{ background: `hsl(${HUES[h % HUES.length]} 38% 46%)` }}>
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

/** A message in one line, for the list. */
export function preview(m: Message | null): string {
  if (!m) return "";
  const text = m.body.replace(/```[\s\S]*?```/g, "[代码]").replace(/[#>*_`|]/g, "").replace(/\s+/g, " ").trim();
  if (m.kind === "reply") return `${m.verdict ? `【${VERDICT_LABEL[m.verdict]}】` : ""}${m.answers?.length ? `回答了 ${m.answers.length} 个问题 ` : ""}${text}`.trim() || "回复";
  return text;
}

export function RequestStatus({ thread, me }: { thread: ThreadView; me: string }) {
  const r = thread.request;
  if (!r) return null;
  if (r.status === "open") return <span className={`chip ${r.to === me ? "todo" : "wait"}`}>{r.to === me ? "待我回答" : "等回复"}</span>;
  return <span className={`chip v-${r.verdict ?? "none"}`}>{r.verdict ? VERDICT_LABEL[r.verdict] : "已回复"}</span>;
}
