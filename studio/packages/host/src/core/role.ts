import { taskLeadIn, type Id, type Session, type Task, type Topic } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";
import { coworkCards } from "./cowork.js";

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
  /** 任务主控 (2026-11-25): this session is its task's 主控 (taskLeadOf). */
  taskLead: boolean;
}

/**
 * 任务主控 (2026-11-25, plans/collab-agent-spec.md §1, plans/collab-framework.md「主控是一个角色，三级范围」): the session
 * the person picked (Task.leadSessionId), else the first main session the person opened in the task — one no other
 * session started (`startedBy`), not archived. Its 执行会话 (session_start) report to it; the patrol (features/pending)
 * wakes it for what waits on it. null: the task has no such session.
 */
export function taskLeadOf(store: Store, taskId: Id): Id | null {
  return taskLeadIn(store.getTask(taskId), store.listSessions({ taskId }));
}

/** The 任务主控's card (plans/collab-agent-spec.md §1「任务主控」, its wording). */
export function taskLeadCard(task: Pick<Task, "title">): string {
  const name = task.title.split("\n").map((l) => l.trim()).find(Boolean) ?? "未命名任务";
  return `你是任务「${name}」的**主控**。你开的会话是执行会话：它们每一轮的结果自动回到你这里（作为那件委派事项的消息）；要补充或改口，用 \`session_send\`（还没送到时可以撤回、改写）。别的任务、别的会话给你的消息会自动进来，回话用 \`replyTo\` 回到原来那条线。`;
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
  // A session about to start is the 任务主控 when the task has none yet (its first one; one session_start opens has a lead).
  const lead = task && session.kind === "main" ? taskLeadOf(host.store, task.id) : null;
  const taskLead = !!task && session.kind === "main" && (session.id ? lead === session.id : lead === null);
  return { sessionId: session.id ?? null, role, session, task, topic, refTopics: task ? refTopics(host, task) : [], taskLead };
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
  /**
   * Its role in each 协作 (2026-11-25, 中转迭代讨论: 「role-stamp 把协作角色也算进去」): 「主控」「执行（事项 3）」「未分角色」.
   * Absent in stamps from before: counted as in none, so a session already in one hears its card once.
   */
  cowork?: Array<{ id: string; title: string; role: string }>;
  /** 任务主控 (2026-11-25). Absent in stamps from before: counted as not, so the task's 主控 hears its card once. */
  taskLead?: boolean;
}

const stampKey = (sessionId: Id) => `role-stamp:${sessionId}`;

function stampOf(host: RoleHost, f: RoleFacts): RoleStamp {
  return {
    role: f.role,
    topic: f.topic ? { id: f.topic.id, title: f.topic.title } : null,
    refs: f.refTopics.map((t) => ({ id: t.id, title: t.title })),
    description: f.task?.description ?? "",
    cowork: f.sessionId ? coworkCards(host.store, f.sessionId).map((c) => ({ id: c.coworkId, title: c.title, role: c.role })) : [],
    taskLead: f.taskLead,
  };
}

/** Notes that the session now knows its card (it was just given it: instructions, or an update). */
export function recordRole(host: RoleHost, sessionId: Id): void {
  host.store.setKv(stampKey(sessionId), JSON.stringify(stampOf(host, roleFacts(host, sessionId))));
}

/**
 * The session was given its 协作 cards some other way (session_start with matter: in its first message), so its next
 * message does not tell them again. Without a stamp yet it is told with its instructions (which carry them).
 */
export function noteCoworkKnown(host: RoleHost, sessionId: Id): void {
  const raw = host.store.getKv(stampKey(sessionId))?.value;
  if (!raw) return;
  try {
    const stamp = JSON.parse(raw) as RoleStamp;
    host.store.setKv(stampKey(sessionId), JSON.stringify({ ...stamp, cowork: stampOf(host, roleFacts(host, sessionId)).cowork }));
  } catch {
    // A stamp it cannot read is replaced when the session is next told.
  }
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
    host.store.setKv(stampKey(sessionId), JSON.stringify({ ...stamp, description: stampOf(host, roleFacts(host, sessionId)).description }));
  } catch {
    // A stamp it cannot read is replaced when the session is next told.
  }
}

/**
 * What changed since the session was last told, one line each; `told()` once the message carrying them went out. A
 * session never told (one from before 2026-10-17, or a fork) is only noted: its card is what amo_whoami says — except its
 * 协作 roles, which it hears (拉进协作 is told this way, 2026-11-25).
 */
export function roleUpdate(host: RoleHost, sessionId: Id): { lines: string[]; told: () => void } {
  const raw = host.store.getKv(stampKey(sessionId))?.value;
  const now = stampOf(host, roleFacts(host, sessionId));
  let before: RoleStamp | null = null;
  try {
    before = raw ? (JSON.parse(raw) as RoleStamp) : null;
  } catch {
    before = null;
  }
  const lines = before ? changes(host, sessionId, before, now) : coworkChanges(host, sessionId, [], now.cowork ?? []);
  const told = () => {
    if (!before || lines.length) host.store.setKv(stampKey(sessionId), JSON.stringify(now));
  };
  return { lines, told };
}

function changes(host: RoleHost, sessionId: Id, before: RoleStamp, now: RoleStamp): string[] {
  const lines: string[] = [];
  if (before.role !== now.role) lines.push(`你现在是「${ROLE_NAME[now.role]}」（之前是「${ROLE_NAME[before.role]}」）。${ROLE_DUTY[now.role]}`);
  if (now.topic && before.topic?.id !== now.topic.id) lines.push(`任务现在在专题「${now.topic.title}」（${now.topic.id}）里：那里的主控、其他任务和专题文档见 amo_whoami。`);
  else if (!now.topic && before.topic) lines.push(`任务已移出专题「${before.topic.title}」。`);
  for (const t of now.refs.filter((r) => !before.refs.some((b) => b.id === r.id))) {
    lines.push(`任务被引用到了专题「${t.title}」（${t.id}）的画布上：那个专题的主控可能会给你传话，它的专题文档用 topic_docs（topic 填这个专题）读。`);
  }
  for (const t of before.refs.filter((b) => !now.refs.some((r) => r.id === b.id) && b.id !== now.topic?.id)) lines.push(`任务不再在专题「${t.title}」的画布上。`);
  if (now.taskLead && !before.taskLead) {
    const task = host.store.getSession(sessionId)?.taskId ? host.store.getTask(host.store.getSession(sessionId)!.taskId!) : undefined;
    if (task) lines.push(`你现在是这个任务的主控。${taskLeadCard(task)}`);
  } else if (!now.taskLead && before.taskLead) {
    const s = host.store.getSession(sessionId);
    const lead = s?.taskId ? taskLeadOf(host.store, s.taskId) : null;
    const name = lead ? (host.store.getSession(lead)?.title || "会话").split("\n")[0] : null;
    lines.push(`你不再是这个任务的主控${name ? `（现在是会话「${name}」，${lead}）` : ""}：执行会话的结果、别的任务的来信交给它。`);
  }
  if (before.description !== now.description) lines.push(now.description ? `任务说明改成了：${oneLine(now.description, 600)}` : "任务说明删掉了。");
  lines.push(...coworkChanges(host, sessionId, before.cowork ?? [], now.cowork ?? []));
  return lines;
}

/** 协作 joined, left or whose role changed: with the whole card of the role it has now (plans/collab-agent-spec.md §1). */
function coworkChanges(host: RoleHost, sessionId: Id, before: NonNullable<RoleStamp["cowork"]>, now: NonNullable<RoleStamp["cowork"]>): string[] {
  const lines: string[] = [];
  const cards = coworkCards(host.store, sessionId);
  for (const c of now) {
    const was = before.find((b) => b.id === c.id);
    if (was && was.role === c.role) continue;
    const card = cards.find((x) => x.coworkId === c.id)?.card ?? "";
    lines.push(`${was ? `你在协作「${c.title}」（cowork:${c.id}）里的角色改成了「${c.role}」（之前是「${was.role}」）` : `你被拉进了协作「${c.title}」（cowork:${c.id}），角色是「${c.role}」`}。照下面的角色说明做：\n\n${card}`);
  }
  for (const b of before.filter((x) => !now.some((c) => c.id === x.id))) lines.push(`你已经不在协作「${b.title}」（cowork:${b.id}）里了：别再用 cowork_* 往那里写。`);
  return lines;
}
