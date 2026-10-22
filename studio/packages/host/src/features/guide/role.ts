import { isCommon, type Id, type Session, type Task, type Topic } from "@amo-studio/protocol";
import type { HostService } from "../../service.js";

// Who a session is in AMO (stage 16, from the stage 15 design): its role card. Claude sessions get it in their MCP
// server's instructions (each Claude session has its own in-process server); Codex threads get it as developer
// instructions when they start (2026-10-17: their shared server's instructions cannot name the session). Both can ask
// again at any time with amo_whoami, and when the card changes later (the task joins a topic, is referenced on another
// canvas, becomes a 主控, gets a new 说明) the next message the session gets says so (roleUpdate).

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
export function roleFacts(service: HostService, sessionId: Id): RoleFacts {
  const session = service.store.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  return subjectFacts(service, session);
}

function subjectFacts(service: HostService, session: RoleSubject): RoleFacts {
  const task = session.taskId ? (service.store.getTask(session.taskId) ?? null) : null;
  const topicId = session.topicId ?? task?.topicId ?? null;
  const topic = topicId ? (service.store.getTopic(topicId) ?? null) : null;
  const role: AmoRole = !task ? "topic" : session.kind === "fork" ? "fork" : task.lead ? "lead" : "worker";
  return { sessionId: session.id ?? null, role, session, task, topic, refTopics: task ? refTopics(service, task) : [] };
}

/** The topics, other than its own, whose canvases show the task as a reference card. */
export function refTopics(service: HostService, task: Task): Topic[] {
  return service.store.listTopics().filter((t) => t.id !== task.topicId && !!service.store.getCanvas(t.id)?.nodes.some((n) => n.kind === "ref" && n.taskId === task.id));
}

/** Whether the session coordinates `topicId`: a 主控 task's session there, or the topic's own session. */
export function leadsTopic(service: HostService, sessionId: Id, topicId: Id): boolean {
  const f = roleFacts(service, sessionId);
  return f.topic?.id === topicId && (f.role === "lead" || f.role === "topic");
}

const ROLE_NAME: Record<AmoRole, string> = { lead: "主控", worker: "执行", topic: "专题会话", fork: "分支" };

const ROLE_DUTY: Record<AmoRole, string> = {
  lead:
    "你是主控：负责协调这个专题（不在专题里时是这个项目）的任务。把大的工作拆成平级的任务、在画布上排好关系（canvas_*），给任务写说明（task_describe），把计划和决定写进专题文档（topic_doc_write）。具体的活交给各个任务的会话去做，让人可以直接和每个任务对话，要它们马上知道的用 relay_send 传话；不要把重活都放进自己的子 agent 里。Studio 不替你建分支、不合并，人说开才开、说合才合。",
  worker:
    "你是执行：专注做好自己的任务。平时不用主动记进度：人让你记时用 task_note_add，一段工作要交给别的会话或人接手时用 handoff_submit。需要主控或别的任务知道的事用 mailbox_send；需要人拍板用 decision_request；本任务里要并行做一部分、或换个干净的上下文，可以用 session_start 再开一个会话。不要去改别的任务的内容。",
  topic: "你是专题会话：从专题的角度看全局、整理画布、回答人的问题，和主控一样可以写专题文档、给任务写说明、标画布颜色。",
  fork: "你是某个会话的分支：在原会话的基础上试另一条路，原会话不受影响。身份和原任务相同。",
};

const taskName = (t: Task) => t.title || "未命名任务";
const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").slice(0, max);

/** A topic's 主控 tasks, as text. */
function leadsOf(service: HostService, topicId: Id): string {
  const leads = service.store.listTasks().filter((t) => t.topicId === topicId && !t.archivedAt && t.lead);
  return leads.length ? leads.map((t) => `${taskName(t)}（${t.id}）`).join("、") : "还没有（人可以在任务页标记）";
}

/** The role card as text (Markdown), for the instructions and amo_whoami. */
export function roleCard(service: HostService, sessionId: Id): string {
  return cardOf(service, roleFacts(service, sessionId));
}

/** The card for a session about to start (Codex's developer instructions). */
export function roleCardFor(service: HostService, subject: RoleSubject): string {
  return cardOf(service, subjectFacts(service, subject));
}

function cardOf(service: HostService, f: RoleFacts): string {
  const ws = service.store.getWorkspace(f.session.workspaceId);
  const lines: string[] = [`## 你在 AMO Studio 里的角色：${ROLE_NAME[f.role]}`, "", ROLE_DUTY[f.role], ""];
  lines.push(`- 会话：${f.session.title || "（未命名）"}（${f.sessionId ?? "新会话"}，${f.session.runtime}）`);
  if (f.task) {
    lines.push(`- 任务：${taskName(f.task)}（${f.task.id}）· 状态 ${f.task.column}${f.task.lead ? " · 主控" : ""}`);
    if (f.task.description) lines.push(`- 任务说明：${oneLine(f.task.description, 400)}`);
  }
  if (ws) lines.push(`- 项目：${isCommon(ws) ? "公共目录（未指定项目）" : ws.name}（${ws.path}）`);
  if (f.topic) {
    lines.push(`- 专题：${f.topic.title}（${f.topic.id}）${f.topic.description ? ` — ${oneLine(f.topic.description, 200)}` : ""}`);
    const tasks = service.store.listTasks().filter((t) => t.topicId === f.topic!.id && !t.archivedAt);
    lines.push(`- 专题的主控：${leadsOf(service, f.topic.id)}`);
    lines.push(`- 专题里的任务：${tasks.length} 个${tasks.length ? `（${tasks.slice(0, 12).map(taskName).join("、")}${tasks.length > 12 ? "…" : ""}）` : ""}`);
    const docs = service.store.listTopicDocs(f.topic.id);
    lines.push(`- 专题文档：${docs.length ? docs.map((d) => `「${d.title}」（${d.id}）`).join("、") : "还没有"}（topic_docs 读）`);
  }
  for (const t of f.refTopics) {
    const docs = service.store.listTopicDocs(t.id).length;
    lines.push(`- 也被引用在专题「${t.title}」（${t.id}）的画布上：那里的主控 ${leadsOf(service, t.id)}，专题文档 ${docs} 篇（topic_docs 加 topic 读）`);
  }
  if (f.role === "lead" || f.role === "topic") {
    const models = service.profiles.filter((p) => !p.hidden).map((p) => p.label);
    lines.push(`- 拆任务时可用的模型：${models.join("、")}（task_plan_propose 的 model；不写就用你自己的）`);
    const open = f.sessionId ? service.store.listTaskPlans().filter((p) => p.fromSessionId === f.sessionId && p.state === "open").length : 0;
    if (open) lines.push(`- 你有 ${open} 个拆任务提案在等人确认`);
  }
  const marks = ws && !isCommon(ws) ? service.store.listFileMarks(ws.id).length : 0;
  if (marks) lines.push(`- 这个项目有 ${marks} 个书签里的文件（人标出的重要文件，list_file_marks 读）`);
  lines.push("", "完整用法：amo_guide。身份随看板变化，需要时再调 amo_whoami。");
  return lines.join("\n");
}

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
export function recordRole(service: HostService, sessionId: Id): void {
  service.store.setKv(stampKey(sessionId), JSON.stringify(stampOf(roleFacts(service, sessionId))));
}

/**
 * The session wrote its own task's 说明 (task_describe): it knows the new one, so its next message does not tell it
 * again (2026-10-22: it read as a change made by someone else). Other changes it was not told yet stay to tell.
 */
export function noteOwnDescription(service: HostService, sessionId: Id): void {
  const raw = service.store.getKv(stampKey(sessionId))?.value;
  if (!raw) return;
  try {
    const stamp = JSON.parse(raw) as RoleStamp;
    service.store.setKv(stampKey(sessionId), JSON.stringify({ ...stamp, description: stampOf(roleFacts(service, sessionId)).description }));
  } catch {
    // A stamp it cannot read is replaced when the session is next told.
  }
}

/**
 * What changed since the session was last told, one line each; `told()` once the message carrying them went out. A
 * session never told (one from before 2026-10-17, or a fork) is only noted: its card is what amo_whoami says.
 */
export function roleUpdate(service: HostService, sessionId: Id): { lines: string[]; told: () => void } {
  const raw = service.store.getKv(stampKey(sessionId))?.value;
  const now = stampOf(roleFacts(service, sessionId));
  let before: RoleStamp | null = null;
  try {
    before = raw ? (JSON.parse(raw) as RoleStamp) : null;
  } catch {
    before = null;
  }
  const lines = before ? changes(before, now) : [];
  const told = () => {
    if (!before || lines.length) service.store.setKv(stampKey(sessionId), JSON.stringify(now));
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
