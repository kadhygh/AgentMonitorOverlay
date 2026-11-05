import type { Id, Session, Task, Topic } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// Who a session is in AMO — 主控, 执行, a topic's own session or a branch — and what it was last told of it: the judgment
// several features make (relays, task plans, the inbox's role updates), here since 2026-11-06 (plans/host-structure.md
// 8c) so they do not reach into the guide feature for it. The card's text (roleCard) stays in features/guide/role.ts.

/** All the role needs of the Host: its store. */
export type RoleHost = { readonly store: Store };

export type AmoRole = "lead" | "worker" | "topic" | "fork";

/** What a role is worked out from: a stored session, or one about to start (its thread is told before it exists). */
export type RoleSubject = Pick<Session, "taskId" | "topicId" | "kind" | "workspaceId" | "runtime"> & Partial<Pick<Session, "id" | "title">>;

export interface RoleFacts {
  sessionId: Id | null;
  role: AmoRole;
  session: RoleSubject;
  task: Task | null;
  topic: Topic | null;
  /** Other topics whose canvases show the task as a reference card. */
  refTopics: Topic[];
}

/** What the session is: 主控 (its task is marked so, or it is a topic's own session), 执行, or a branch of one. */
export function roleFacts(host: RoleHost, sessionId: Id): RoleFacts {
  const session = host.store.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  return subjectFacts(host, session);
}

/** The same for a session about to start (the role card of a thread told before it exists). */
export function subjectFacts(host: RoleHost, session: RoleSubject): RoleFacts {
  const task = session.taskId ? (host.store.getTask(session.taskId) ?? null) : null;
  const topicId = session.topicId ?? task?.topicId ?? null;
  const topic = topicId ? (host.store.getTopic(topicId) ?? null) : null;
  const role: AmoRole = !task ? "topic" : session.kind === "fork" ? "fork" : task.lead ? "lead" : "worker";
  return { sessionId: session.id ?? null, role, session, task, topic, refTopics: task ? refTopics(host, task) : [] };
}

/** The topics, other than its own, whose canvases show the task as a reference card. */
export function refTopics(host: RoleHost, task: Task): Topic[] {
  return host.store.listTopics().filter((t) => t.id !== task.topicId && !!host.store.getCanvas(t.id)?.nodes.some((n) => n.kind === "ref" && n.taskId === task.id));
}

/** Whether the session coordinates `topicId`: a 主控 task's session there, or the topic's own session. */
export function leadsTopic(host: RoleHost, sessionId: Id, topicId: Id): boolean {
  const f = roleFacts(host, sessionId);
  return f.topic?.id === topicId && (f.role === "lead" || f.role === "topic");
}
export const ROLE_NAME: Record<AmoRole, string> = { lead: "主控", worker: "执行", topic: "专题会话", fork: "分支" };

export const ROLE_DUTY: Record<AmoRole, string> = {
  lead:
    "你是主控：负责协调这个专题（不在专题里时是这个项目）的任务。把大的工作拆成平级的任务，给任务写说明（task_describe）；人让你用画布展开时，照 amo_guide 的 lead 一节在画布上排好分组和依赖（canvas_*），人没说就不动画布，把计划和决定写进专题文档（topic_doc_write）。具体的活交给各个任务的会话去做，让人可以直接和每个任务对话，要它们马上知道的用 task_message 传话；不要把重活都放进自己的子 agent 里。Studio 不替你建分支、不合并，人说开才开、说合才合。",
  worker:
    "你是执行：专注做好自己的任务。平时不用主动记进度：人让你记时用 task_note_add，一段工作要交给别的会话或人接手时用 handoff_submit。需要主控或别的任务知道的事用 mailbox_send；需要人拍板用 decision_request；本任务里要并行做一部分、或换个干净的上下文，可以用 session_start 再开一个会话。不要去改别的任务的内容。",
  topic: "你是专题会话：从专题的角度看全局、回答人的问题，和主控一样可以写专题文档、给任务写说明；人让你整理画布时再整理画布、标颜色。",
  fork: "你是某个会话的分支：在原会话的基础上试另一条路，原会话不受影响。身份和原任务相同。",
};


const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").slice(0, max);

// ---- what the session was last told -------------------------------------------------------------------------------

/** The parts of the card whose change the session hears about. */
interface RoleStamp {
  role: AmoRole;
  topic: { id: Id; title: string } | null;
  refs: Array<{ id: Id; title: string }>;
  description: string;
}

const stampKey = (sessionId: Id) => `role-stamp:${sessionId}`;

function stampOf(f: RoleFacts): RoleStamp {
  return {
    role: f.role,
    topic: f.topic ? { id: f.topic.id, title: f.topic.title } : null,
    refs: f.refTopics.map((t) => ({ id: t.id, title: t.title })),
    description: f.task?.description ?? "",
  };
}

/** Notes that the session now knows its card (it was just given it: instructions, or an update). */
export function recordRole(host: RoleHost, sessionId: Id): void {
  host.store.setKv(stampKey(sessionId), JSON.stringify(stampOf(roleFacts(host, sessionId))));
}

/**
 * The session wrote its own task's 说明 (task_describe): it knows the new one, so its next message does not tell it
 * again (2026-10-22: it read as a change made by someone else). Other changes it was not told yet stay to tell.
 */
export function noteOwnDescription(host: RoleHost, sessionId: Id): void {
  const raw = host.store.getKv(stampKey(sessionId))?.value;
  if (!raw) return;
  try {
    const stamp = JSON.parse(raw) as RoleStamp;
    host.store.setKv(stampKey(sessionId), JSON.stringify({ ...stamp, description: stampOf(roleFacts(host, sessionId)).description }));
  } catch {
    // A stamp it cannot read is replaced when the session is next told.
  }
}

/**
 * What changed since the session was last told, one line each; `told()` once the message carrying them went out. A
 * session never told (one from before 2026-10-17, or a fork) is only noted: its card is what amo_whoami says.
 */
export function roleUpdate(host: RoleHost, sessionId: Id): { lines: string[]; told: () => void } {
  const raw = host.store.getKv(stampKey(sessionId))?.value;
  const now = stampOf(roleFacts(host, sessionId));
  let before: RoleStamp | null = null;
  try {
    before = raw ? (JSON.parse(raw) as RoleStamp) : null;
  } catch {
    before = null;
  }
  const lines = before ? changes(before, now) : [];
  const told = () => {
    if (!before || lines.length) host.store.setKv(stampKey(sessionId), JSON.stringify(now));
  };
  return { lines, told };
}

function changes(before: RoleStamp, now: RoleStamp): string[] {
  const lines: string[] = [];
  if (before.role !== now.role) lines.push(`你现在是「${ROLE_NAME[now.role]}」（之前是「${ROLE_NAME[before.role]}」）。${ROLE_DUTY[now.role]}`);
  if (now.topic && before.topic?.id !== now.topic.id) lines.push(`任务现在在专题「${now.topic.title}」（${now.topic.id}）里：那里的主控、其他任务和专题文档见 amo_whoami。`);
  else if (!now.topic && before.topic) lines.push(`任务已移出专题「${before.topic.title}」。`);
  for (const t of now.refs.filter((r) => !before.refs.some((b) => b.id === r.id))) {
    lines.push(`任务被引用到了专题「${t.title}」（${t.id}）的画布上：那个专题的主控可能会给你传话，它的专题文档用 topic_docs（topic 填这个专题）读。`);
  }
  for (const t of before.refs.filter((b) => !now.refs.some((r) => r.id === b.id) && b.id !== now.topic?.id)) lines.push(`任务不再在专题「${t.title}」的画布上。`);
  if (before.description !== now.description) lines.push(now.description ? `任务说明改成了：${oneLine(now.description, 600)}` : "任务说明删掉了。");
  return lines;
}
