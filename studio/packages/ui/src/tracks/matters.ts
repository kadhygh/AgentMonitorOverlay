import { inTurn, messageOrigin, splitRoleUpdate, type DecisionRequest, type Session, type SessionItem, type TeamThread } from "@amo-studio/protocol";

// 事项 (2026-11-15, plans/collab-framework.md): one session carries several small loops at once — it asked someone
// through 中转, it started a sub-session, it waits for an approval — and the conversation shows them only as they came,
// one after the other. This is the list of them for one session, read from what Studio already keeps (中转 sessions,
// the sessions it started, its rows): nothing is asked of the model, so it costs no tokens. What the AI itself
// settled (已定的事) is not here yet.

export type MatterKind = "team" | "session" | "subagent" | "approval" | "question" | "decision" | "held";
/** `you`: waits for the person; `back`: an answer is here, the session goes on with it; `run`: someone works on it; `wait`: waits for another person. */
export type MatterState = "you" | "failed" | "stopped" | "back" | "run" | "wait" | "done";

export interface Matter {
  key: string;
  kind: MatterKind;
  state: MatterState;
  /** Still going on (still listed above the line). */
  open: boolean;
  title: string;
  /** Where it stands, in words. */
  note: string;
  /** For the order and 「等了 N 分钟」: when it got to where it stands, ms; null: unknown. */
  since: number | null;
  /** Where a click goes: a row of this conversation, or another session. */
  itemId?: string;
  sessionId?: string;
}

export interface MatterSources {
  session: Session;
  /** The task's sessions (the ones this one started are read from them). */
  sessions: readonly Session[];
  threads: readonly TeamThread[];
  /** This session's rows. */
  items: readonly SessionItem[];
  decisions: readonly DecisionRequest[];
  now: number;
}

const MARKS: Record<MatterState, string> = { you: "!", failed: "!", stopped: "○", back: "◐", run: "◐", wait: "◐", done: "✓" };
/** The mark in front of a matter (never colour alone). */
export const matterMark = (state: MatterState): string => MARKS[state];

const ORDER: MatterState[] = ["you", "failed", "stopped", "back", "run", "wait", "done"];

/** 「3 分钟」「2 小时」「3 天」. */
export function ago(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`;
}

const oneLine = (text: string, max = 60) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

const at = (iso: string | undefined | null): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** The session's matters: the open ones first (what waits for the person on top), then the ended ones, newest first. */
export function sessionMatters({ session, sessions, threads, items, decisions, now }: MatterSources): Matter[] {
  const out: Matter[] = [];
  const waited = (since: number | null) => (since === null ? "" : ` · ${ago(now - since)}`);

  // What came back into this conversation, by where it came from: the row a click on its matter goes to.
  const replyOf = new Map<string, string>();
  const reportOf = new Map<string, string>();
  let held = 0;
  let firstHeld: SessionItem | null = null;
  for (const item of items) {
    if (item.type !== "user") continue;
    if (item.delivery === "held") {
      held++;
      firstHeld ??= item;
    }
    const from = item.origin ?? messageOrigin({ text: splitRoleUpdate(item.text).text })?.origin;
    if (!from) continue;
    if (from.kind === "team") for (const id of from.threadIds ?? []) replyOf.set(id, item.id);
    if (from.kind === "report" && from.sessionId) reportOf.set(from.sessionId, item.id);
  }

  // Asked someone through 中转.
  for (const t of threads) {
    if (t.sessionId !== session.id) continue;
    const base = { key: `team:${t.threadId}`, kind: "team" as const, title: `问 ${t.to}：${oneLine(t.title)}`, since: t.since, ...(replyOf.has(t.threadId) ? { itemId: replyOf.get(t.threadId)! } : {}) };
    if (t.state === "open") out.push({ ...base, state: "wait", open: true, note: `等 ${t.to} 回复${waited(t.since)}` });
    else if (t.state === "returned") out.push({ ...base, state: "back", open: true, note: `${t.to} 回复了${waited(t.since)}前${t.deliveredAt ? "，已送进会话" : "，还没送进会话"}` });
    else out.push({ ...base, state: "done", open: false, note: t.takenAt ? `${t.to} 已接手，不用回复` : "已结束" });
  }

  // Sessions it started (session_start), and its CLI's own subagents while they run.
  for (const s of sessions) {
    if (s.id === session.id) continue;
    const name = s.title || "未命名会话";
    const since = at(s.updatedAt);
    if (s.kind === "sub") {
      if (s.parentId === session.id && s.status === "running") out.push({ key: `sub:${s.id}`, kind: "subagent", state: "run", open: true, title: `子 agent「${name}」`, note: `在跑${waited(at(s.createdAt))}`, since: at(s.createdAt), sessionId: s.id });
      continue;
    }
    if (s.startedBy !== session.id) continue;
    const base = { key: `session:${s.id}`, kind: "session" as const, title: `子会话「${name}」`, since, sessionId: s.id };
    const report = reportOf.get(s.id);
    if (s.archivedAt) out.push({ ...base, state: "done", open: false, note: "已归档", ...(report ? { itemId: report } : {}) });
    else if (s.status === "running") out.push({ ...base, state: "run", open: true, note: `在跑${waited(since)}` });
    else if (s.status === "awaiting-approval") out.push({ ...base, state: "you", open: true, note: "等你审批" });
    else if (s.status === "awaiting-answer" || s.status === "awaiting-review") out.push({ ...base, state: "you", open: true, note: "等你回答" });
    else if (s.status === "error") out.push({ ...base, state: "failed", open: true, note: "出错停下了", ...(report ? { itemId: report } : {}) });
    else if (s.status === "interrupted") out.push({ ...base, state: "stopped", open: true, note: "被停下了，还没有结论" });
    // Free again: its turn is over. With a report in this conversation the loop is closed; without one (report was not
    // asked for) there is nothing more to wait for either.
    else out.push({ ...base, state: "done", open: false, note: report ? "这一轮做完了，结果已回到这里" : "这一轮做完了", ...(report ? { itemId: report } : {}) });
  }

  // What waits for the person in this conversation.
  for (const item of items) {
    if (item.type === "approval" && item.state === "pending") out.push({ key: `approval:${item.id}`, kind: "approval", state: "you", open: true, title: `等你审批：${oneLine(item.summary)}`, note: `等了 ${ago(now - (at(item.createdAt) ?? now))}`, since: at(item.createdAt), itemId: item.id });
    if (item.type === "question" && item.state === "pending") {
      const what = item.source === "plan-review" ? "看一份计划" : oneLine(item.questions?.[0]?.question ?? item.message ?? "有问题问你");
      out.push({ key: `question:${item.id}`, kind: "question", state: "you", open: true, title: `等你回答：${what}`, note: `等了 ${ago(now - (at(item.createdAt) ?? now))}`, since: at(item.createdAt), itemId: item.id });
    }
  }
  for (const d of decisions) {
    if (d.sessionId !== session.id || d.state !== "open") continue;
    out.push({ key: `decision:${d.id}`, kind: "decision", state: "you", open: true, title: `等你决定：${oneLine(d.question)}`, note: `等了 ${ago(now - (at(d.createdAt) ?? now))}`, since: at(d.createdAt) });
  }
  // Held in the inbox: for the turn to end, or — no turn runs — for the person (they stopped the session or are writing).
  if (held && firstHeld) {
    const busy = inTurn(session.status);
    out.push({ key: "held", kind: "held", state: busy ? "run" : "you", open: true, title: `${held} 条转来的消息还没送进去`, note: busy ? "等这一轮结束后送进去" : "等你发出下一条消息时一起送进去", since: at(firstHeld.createdAt), itemId: firstHeld.id });
  }

  return out.sort((a, b) => Number(b.open) - Number(a.open) || ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (b.since ?? 0) - (a.since ?? 0));
}
