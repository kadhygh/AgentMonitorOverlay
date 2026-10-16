import { isCommon, type Id, type Session, type Task, type Topic } from "@amo-studio/protocol";
import type { HostService } from "../../service.js";

// Who a session is in AMO (stage 16, from the stage 15 design): its role card. Claude sessions get it in their MCP
// server's instructions (each Claude session has its own in-process server); Codex reads it with amo_whoami (its
// server's instructions cannot name the session). Both can ask again at any time: the card follows the board.

export type AmoRole = "lead" | "worker" | "topic" | "fork";

export interface RoleFacts {
  sessionId: Id;
  role: AmoRole;
  session: Session;
  task: Task | null;
  topic: Topic | null;
}

/** What the session is: 主控 (its task is marked so, or it is a topic's own session), 执行, or a branch of one. */
export function roleFacts(service: HostService, sessionId: Id): RoleFacts {
  const session = service.store.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const task = session.taskId ? (service.store.getTask(session.taskId) ?? null) : null;
  const topicId = session.topicId ?? task?.topicId ?? null;
  const topic = topicId ? (service.store.getTopic(topicId) ?? null) : null;
  const role: AmoRole = !task ? "topic" : session.kind === "fork" ? "fork" : task.lead ? "lead" : "worker";
  return { sessionId, role, session, task, topic };
}

/** Whether the session coordinates `topicId`: a 主控 task's session there, or the topic's own session. */
export function leadsTopic(service: HostService, sessionId: Id, topicId: Id): boolean {
  const f = roleFacts(service, sessionId);
  return f.topic?.id === topicId && (f.role === "lead" || f.role === "topic");
}

const ROLE_NAME: Record<AmoRole, string> = { lead: "主控", worker: "执行", topic: "专题会话", fork: "分支" };

const ROLE_DUTY: Record<AmoRole, string> = {
  lead:
    "你是主控：负责协调这个专题（不在专题里时是这个项目）的任务。把大的工作拆成平级的任务、在画布上排好关系（canvas_*），给任务写说明（task_describe），把计划和决定写进专题文档（topic_doc_write）。具体的活交给各个任务的会话去做，让人可以直接和每个任务对话；不要把重活都放进自己的子 agent 里。Studio 不替你建分支、不合并，人说开才开、说合才合。",
  worker:
    "你是执行：专注做好自己的任务。进度写 task_note_add，交接写 handoff_submit；需要主控或别的任务知道的事用 mailbox_send；需要人拍板用 decision_request。不要去改别的任务的内容。",
  topic: "你是专题会话：从专题的角度看全局、整理画布、回答人的问题，和主控一样可以写专题文档、给任务写说明、标画布颜色。",
  fork: "你是某个会话的分支：在原会话的基础上试另一条路，原会话不受影响。身份和原任务相同。",
};

/** The role card as text (Markdown), for the instructions and amo_whoami. */
export function roleCard(service: HostService, sessionId: Id): string {
  const f = roleFacts(service, sessionId);
  const ws = service.store.getWorkspace(f.session.workspaceId);
  const lines: string[] = [`## 你在 AMO Studio 里的角色：${ROLE_NAME[f.role]}`, "", ROLE_DUTY[f.role], ""];
  lines.push(`- 会话：${f.session.title || "（未命名）"}（${f.session.id}，${f.session.runtime}）`);
  if (f.task) {
    lines.push(`- 任务：${f.task.title || "未命名任务"}（${f.task.id}）· 状态 ${f.task.column}${f.task.lead ? " · 主控" : ""}`);
    if (f.task.description) lines.push(`- 任务说明：${f.task.description.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  if (ws) lines.push(`- 项目：${isCommon(ws) ? "公共目录（未指定项目）" : ws.name}（${ws.path}）`);
  if (f.topic) {
    lines.push(`- 专题：${f.topic.title}（${f.topic.id}）${f.topic.description ? ` — ${f.topic.description.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
    const tasks = service.store.listTasks().filter((t) => t.topicId === f.topic!.id && !t.archivedAt);
    const leads = tasks.filter((t) => t.lead);
    lines.push(`- 专题的主控：${leads.length ? leads.map((t) => `${t.title || "未命名任务"}（${t.id}）`).join("、") : "还没有（人可以在任务页标记）"}`);
    lines.push(`- 专题里的任务：${tasks.length} 个${tasks.length ? `（${tasks.slice(0, 12).map((t) => t.title || "未命名任务").join("、")}${tasks.length > 12 ? "…" : ""}）` : ""}`);
    const docs = service.store.listTopicDocs(f.topic.id);
    lines.push(`- 专题文档：${docs.length ? docs.map((d) => `「${d.title}」（${d.id}）`).join("、") : "还没有"}（topic_docs 读）`);
  }
  const marks = ws && !isCommon(ws) ? service.store.listFileMarks(ws.id).length : 0;
  if (marks) lines.push(`- 这个项目有 ${marks} 个文件标记（人标出的重要文件，list_file_marks 读）`);
  lines.push("", "完整用法：amo_guide。身份随看板变化，需要时再调 amo_whoami。");
  return lines.join("\n");
}
