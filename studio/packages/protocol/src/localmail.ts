// 本机的事项和消息 (2026-11-25, plans/collab-framework.md「留言和主控的来往也在本轮改」, step 4 of 「本轮分六步」): what used
// to be 留言 (mailbox_send), 传话 (task_message), session_start's first message and report, and session_send are now
// messages in a 事项 of the Host's own table (scope "task", the same fields as the 中转's 协作: matters.ts). Each message
// is still a MailMessage (the `mail` table, so the 留言 from before are all there and old Studio pages keep reading it),
// with the fields below added; a 事项 is a Matter with scope "task".
//
// The user 11-24/25: 留言变成事项里的消息 (回话 replyTo 回到原来那条线, 同一件事串成一个对话视图); 按距离自动送 (same task: at
// once; same topic: at once unless the task says 先问 — relayAuto turned the other way round, as the user had put it on
// 11-15: 默认自动，可配置; another topic or none: 先问); 排队的消息看得见、撤得回、改得了; 送到时附「发出于 HH:MM，之后你又做了：…」;
// session_start reports by default, its results being messages of the 委派事项; the person's 留言页 becomes 「待我处理」.

import type { Id, MailMessage, Session, Task, Timestamp } from "./entities.js";
import type { Matter, MatterStatus, Party, PendingItem, ReceiptState } from "./matters.js";

/**
 * How a local message came about: `mail` 留言 (mailbox_send, or the person's), `start` session_start's first message,
 * `report` its turn's result, `send` session_send, `relay` 传话 (task_message), `background` 背景更新 for a session opened
 * forPerson (goes in with the person's next message), `answer` the answer to a decision request, `note` Studio's own
 * line (「传话已送到…」).
 */
export type LocalMessageVia = "mail" | "start" | "report" | "send" | "relay" | "background" | "answer" | "note";

export const LOCAL_VIA_LABEL: Record<LocalMessageVia, string> = {
  mail: "留言",
  start: "派活",
  report: "结果",
  send: "续发",
  relay: "传话",
  background: "背景更新",
  answer: "回答",
  note: "通知",
};

/**
 * 按距离 (the user 11-15 rule 3, 11-24): how a message to another session or task goes in.
 * - `auto`: into its conversation once its turn is over (the session's inbox).
 * - `ask`: it waits in 「待我处理」 until the person sends it in (or drops it).
 * - `background` (a session opened forPerson, from the session that opened it): with the person's next message.
 */
export type DeliveryMode = "auto" | "ask" | "background";

/** What deliveryMode needs of the sender and of where the message goes. */
export interface DistanceInput {
  /** The sending session's task (null: a topic's own session, or the person). */
  fromTask: Pick<Task, "id" | "topicId"> | null;
  /** The sending session's topic (its task's, or its own as a topic session); null when none. */
  fromTopicId: Id | null;
  /** The person sends: always at once. */
  fromPerson?: boolean;
  /** The task the message goes to (a session's task); null for a topic's own session. */
  toTask: Pick<Task, "id" | "topicId" | "relayAuto"> | null;
  /** The topic it goes to when it is a topic's own session. */
  toTopicId: Id | null;
}

/**
 * The rule: the person's go at once; inside one task (the session tree) at once; another task of the same topic at once
 * unless that task says 先问 (relayAuto === false); a topic's own session from a task of it at once; anything farther
 * (another topic — a reference card included —, no topic) waits for the person, unless the receiving task takes
 * messages without asking (relayAuto === true, as 传话 has done since stage 16).
 */
export function deliveryMode(i: DistanceInput): Exclude<DeliveryMode, "background"> {
  if (i.fromPerson) return "auto";
  if (i.toTask) {
    if (i.fromTask && i.fromTask.id === i.toTask.id) return "auto";
    if (i.toTask.relayAuto === false) return "ask";
    if (i.fromTopicId && i.toTask.topicId === i.fromTopicId) return "auto";
    return i.toTask.relayAuto === true ? "auto" : "ask";
  }
  if (i.toTopicId && i.fromTopicId === i.toTopicId) return "auto";
  return "ask";
}

/** A session's party in the Host's 事项 (its id is its mark). */
export const sessionParty = (sessionId: Id): Party => `agent:${sessionId}`;
/** The person at this computer, in the Host's 事项 (matters.ts: `person:me` when there is no account to name). */
export const LOCAL_PERSON: Party = "person:me";

/**
 * 「事项 3」, 「3」, 3 or a 事项's id; 「#7」, 「7」 or 7 for a message. Returns the number, or the id as given; null when
 * there is nothing.
 */
export function matterRef(ref: unknown): { no: number } | { id: string } | null {
  if (typeof ref === "number" && Number.isInteger(ref) && ref > 0) return { no: ref };
  if (typeof ref !== "string") return null;
  const s = ref.trim();
  if (!s) return null;
  const m = /^(?:事项\s*)?(\d+)$/.exec(s);
  return m ? { no: Number(m[1]) } : { id: s };
}

export function messageRef(ref: unknown): number | null {
  if (typeof ref === "number" && Number.isInteger(ref) && ref > 0) return ref;
  if (typeof ref !== "string") return null;
  const m = /^#?\s*(\d+)$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/** The receipt state of a message for one recipient (the first receipt when no party is named); null without receipts. */
export function receiptOf(m: Pick<MailMessage, "receipts">, party?: Party): ReceiptState | null {
  const r = party ? m.receipts?.find((x) => x.party === party) : m.receipts?.[0];
  return r?.state ?? null;
}

/** Still in a queue (no recipient has it yet): 撤回 and 改写 are possible. */
export const isQueued = (m: Pick<MailMessage, "receipts" | "withdrawnAt" | "state">): boolean =>
  m.withdrawnAt === undefined && m.state !== "dismissed" && (m.receipts ?? []).length > 0 && (m.receipts ?? []).every((r) => r.state === "queued");

/** 「发出于 HH:MM，之后你又做了 N 轮，最后的回复开头：「…」」 (the user 11-24), from the receiving session's own record. */
export function sinceLine(sentAt: Timestamp, turns: number, lastReply: string | null, now = Date.now()): string | null {
  if (turns <= 0) return null;
  const at = new Date(sentAt);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const day = new Date(now).toDateString() === at.toDateString() ? "" : `${at.getMonth() + 1}-${at.getDate()} `;
  const opening = lastReply ? lastReply.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return `（这条发出于 ${day}${hhmm}，之后你又做了 ${turns} 轮${opening ? `，最后的回复开头：「${opening}${lastReply!.replace(/\s+/g, " ").trim().length > 80 ? "…" : ""}」` : ""}。它说的可能已经过时，按你现在的情况处理。）`;
}

/** One 事项 of the page, with its messages (oldest first). Old 留言 without a 事项 are grouped under `matter: null`. */
export interface LocalThread {
  matter: Matter | null;
  messages: MailMessage[];
}

/**
 * The person's 「待我处理」 page, the Host's own part (the 协作 part comes from the 中转): `asks` — messages waiting for the
 * person to send them in (先问, or an agent's message that did not go in by itself: `ask` absent), oldest first; `threads` — the 事项 with something still open (a message not 处理了 by
 * its recipient, or the 事项 waiting on the person), newest first; `pending` — the person's own 待我处理 items
 * (matters.ts), for the count and Focus.
 */
export interface LocalPendingView {
  asks: MailMessage[];
  threads: LocalThread[];
  pending: PendingItem[];
}

/** A short title for a 事项 made from its first message (its first line, at most 60 characters). */
export function titleFrom(text: string, fallback = "事项"): string {
  const line = text.split(/\r?\n/).map((l) => l.replace(/^[#>*\-\s【]+|】$/g, "").trim()).find(Boolean) ?? "";
  if (!line) return fallback;
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * 任务主控 (2026-11-25, plans/collab-agent-spec.md §1): the session the person picked (Task.leadSessionId), else the first
 * main session the person opened in the task — one no other session started (`startedBy`), not archived. The Host
 * (core/role.ts) and the task page (its mark, 设为任务主控) read the same rule.
 */
export function taskLeadIn(task: Pick<Task, "id" | "leadSessionId"> | undefined, sessions: readonly Pick<Session, "id" | "taskId" | "kind" | "archivedAt" | "startedBy" | "createdAt">[]): Id | null {
  if (!task) return null;
  const live = sessions.filter((s) => s.taskId === task.id && s.kind === "main" && !s.archivedAt);
  if (task.leadSessionId && live.some((s) => s.id === task.leadSessionId)) return task.leadSessionId;
  const own = live.filter((s) => !s.startedBy).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return own[0]?.id ?? null;
}

/** The session's place for the 「之后你又做了」 line: it is one of the Host's (not a subagent, not archived). */
export const takesMessages = (s: Pick<Session, "kind" | "archivedAt">): boolean => s.kind !== "sub" && !s.archivedAt;

/** The routes (protocol/src/api.ts merges them). */
export interface LocalMailRoutes {
  /** The person's 待我处理 (the Host's part); `?taskId=` only what concerns that task. */
  "GET /api/local-pending": { req: void; res: LocalPendingView };
  /** A task's 事项, newest first; `?open=1` only those not closed. */
  "GET /api/matters": { req: void; res: Matter[] };
  /** One 事项 and all of its messages. */
  "GET /api/matters/:id": { req: void; res: LocalThread };
  /** The person changes a 事项: its status (关闭 marks all of its messages 处理了). */
  "PATCH /api/matters/:id": { req: { status?: MatterStatus; note?: string }; res: Matter };
  /** The person marks messages 看过 / 处理了 (by mail id). */
  "POST /api/mail/marks": { req: { ids: Id[]; mark: "seen" | "handled" }; res: MailMessage[] };
}
