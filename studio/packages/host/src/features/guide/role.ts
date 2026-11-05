import { isCommon, type Id, type Task } from "@amo-studio/protocol";
import type { FeatureHost } from "../../core/feature.js";
import { ROLE_DUTY, ROLE_NAME, roleFacts, subjectFacts, type RoleFacts, type RoleSubject } from "../../core/role.js";

// Who a session is in AMO (stage 16, from the stage 15 design): its role card. Claude sessions get it in their MCP
// server's instructions (each Claude session has its own in-process server); Codex threads get it as developer
// instructions when they start (2026-10-17: their shared server's instructions cannot name the session). Both can ask
// again at any time with amo_whoami, and when the card changes later (the task joins a topic, is referenced on another
// canvas, becomes a 主控, gets a new 说明) the next message the session gets says so (roleUpdate).

// Who the session is and what it was last told live in core/role.ts (2026-11-06); they are passed on from here for
// the MCP server and the tests.
export { leadsTopic, noteOwnDescription, recordRole, refTopics, roleFacts, roleUpdate, type AmoRole, type RoleFacts, type RoleSubject } from "../../core/role.js";

/** What the card reads besides the store: the person's notes on models as sub-sessions (设置 → 子会话). */
type CardHost = FeatureHost<"config">;

const taskName = (t: Task) => t.title || "未命名任务";
const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").slice(0, max);

/** A topic's 主控 tasks, as text. */
function leadsOf(service: CardHost, topicId: Id): string {
  const leads = service.store.listTasks().filter((t) => t.topicId === topicId && !t.archivedAt && t.lead);
  return leads.length ? leads.map((t) => `${taskName(t)}（${t.id}）`).join("、") : "还没有（人可以在任务页标记）";
}

/** The role card as text (Markdown), for the instructions and amo_whoami. */
export function roleCard(service: CardHost, sessionId: Id): string {
  return cardOf(service, roleFacts(service, sessionId));
}

/** The card for a session about to start (Codex's developer instructions). */
export function roleCardFor(service: CardHost, subject: RoleSubject): string {
  return cardOf(service, subjectFacts(service, subject));
}

function cardOf(service: CardHost, f: RoleFacts): string {
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
    lines.push(`- 拆任务时可用的模型：${models.join("、")}（task_plan_propose 的 model，「名字/型号」可以指定具体型号；effort 设思考强度；不写就用你自己的模型和人设的默认强度）`);
    const open = f.sessionId ? service.store.listTaskPlans().filter((p) => p.fromSessionId === f.sessionId && p.state === "open").length : 0;
    if (open) lines.push(`- 你有 ${open} 个拆任务提案在等人确认`);
  }
  // 设置 → 子会话 (2026-10-26): what the person wrote about models as sub-sessions, where this session may start some
  // (session_start) or split work into tasks (task_plan_propose).
  const notes = f.session.kind === "sub" ? [] : service.config.subsessionNotes();
  if (notes.length) {
    lines.push("- 人写的模型用法（开子会话 session_start、拆任务 task_plan_propose 时参考；model 照括号里的写）：");
    for (const n of notes) {
      const p = service.profiles.find((x) => x.id === n.profileId)!;
      // 2026-11-05: its defaults as a sub-session, which session_start applies when they are left out.
      const defaults = [n.effort ? `effort ${n.effort}` : "", n.fast === true ? "Fast 开" : n.fast === false ? "Fast 关" : "", n.permission ? `permission ${n.permission}` : ""].filter(Boolean);
      const tail = `${n.note ? oneLine(n.note, 1000) : "（没写用法）"}${defaults.length ? `（人设的默认：${defaults.join("、")}；session_start 不带这几项时自动用）` : ""}`;
      if (n.model) lines.push(`  - ${p.label}/${n.model}（model: "${p.label}/${n.model}"）：${tail}`);
      else lines.push(`  - ${p.label} 的所有型号（model: "${p.label}" 是它的默认型号，"${p.label}/型号" 指定型号；某个型号另有说明时以那条为准）：${tail}`);
    }
  }
  const marks = ws && !isCommon(ws) ? service.store.listFileMarks(ws.id).length : 0;
  if (marks) lines.push(`- 这个项目有 ${marks} 个书签里的文件（人标出的重要文件，list_file_marks 读）`);
  lines.push("", "完整用法：amo_guide。身份随看板变化，需要时再调 amo_whoami。");
  return lines.join("\n");
}
