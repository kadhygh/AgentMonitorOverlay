import { isCommon, TASK_DESCRIPTION_MAX, TASK_PLAN_MAX_TASKS, wouldCycle, type Id, type ModelProfile, type PlannedTask, type Task, type TaskPlan } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { roleFacts } from "../guide/role.js";

const SUMMARY_MAX = 2000;
const FIRST_MESSAGE_MAX = 20_000;
/** How long a decided proposal stays listed. */
const DECIDED_SHOWN_MS = 24 * 3600_000;

/**
 * 主控's proposals to split work into tasks (stage 16, from the stage 15 design): a 主控 (or a topic's own session)
 * proposes; the person looks at it on the topic's canvas, changes what they want and accepts it — then Studio makes
 * the tasks, puts them on the canvas (a group per project when they span several) with their dependencies, starts
 * them or leaves them in 待办, and tells the 主控 which tasks they became — or dismisses it, with a note.
 */
export class TaskPlansFeature extends Feature {
  list(): TaskPlan[] {
    const since = Date.now() - DECIDED_SHOWN_MS;
    return this.store.listTaskPlans().filter((p) => p.state === "open" || Date.parse(p.decidedAt ?? p.createdAt) > since);
  }

  private requirePlan(id: Id): TaskPlan {
    const plan = this.store.getTaskPlan(id);
    if (!plan) throw new HostError("not_found", `proposal ${id} not found`);
    return plan;
  }

  private save(plan: TaskPlan): TaskPlan {
    this.store.putTaskPlan(plan);
    this.publish({ type: "taskplan.upserted", plan });
    return plan;
  }

  /** A 主控's proposal (MCP task_plan_propose). */
  async propose(sessionId: Id, input: { summary?: unknown; tasks?: unknown }): Promise<TaskPlan> {
    const facts = roleFacts(this.host, sessionId);
    if (facts.role !== "lead" && facts.role !== "topic") {
      throw new HostError("bad_request", "只有主控（或专题会话）能提拆任务的提案：把想法用 mailbox_send 发给主控，或请人把你的任务标成主控。");
    }
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary) throw new HostError("bad_request", "summary is required: what the split is for, in a few lines");
    if (summary.length > SUMMARY_MAX) throw new HostError("bad_request", `summary is limited to ${SUMMARY_MAX} characters`);
    if (!Array.isArray(input.tasks) || !input.tasks.length) throw new HostError("bad_request", "tasks must list at least one task");
    if (input.tasks.length > TASK_PLAN_MAX_TASKS) throw new HostError("bad_request", `at most ${TASK_PLAN_MAX_TASKS} tasks in one proposal`);
    const defaultWs = facts.task?.workspaceId ?? facts.topic?.workspaceIds[0] ?? this.commonWorkspace().id;
    const tasks: PlannedTask[] = [];
    for (const [i, t] of (input.tasks as Array<Record<string, unknown>>).entries()) {
      if (!t || typeof t !== "object") throw new HostError("bad_request", `task ${i + 1} is not an object`);
      const key = typeof t.key === "string" && t.key.trim() ? t.key.trim() : `t${i + 1}`;
      const title = typeof t.title === "string" ? t.title.trim() : "";
      if (!title) throw new HostError("bad_request", `task ${key} needs a title`);
      const workspaceId = t.project === undefined || t.project === "" ? defaultWs : this.workspaceByRef(String(t.project));
      const description = optionalText(t.description, `task ${key}: description`, TASK_DESCRIPTION_MAX);
      const firstMessage = optionalText(t.firstMessage, `task ${key}: firstMessage`, FIRST_MESSAGE_MAX);
      // model: an account, or "<account>/<model>"; effort: checked against the model it will run (as session_start).
      const picked = t.model === undefined || t.model === "" ? { profileId: this.requireSession(sessionId).profileId } : await this.f.sessions.modelByRef(String(t.model));
      const effort = typeof t.effort === "string" && t.effort.trim() ? await this.f.sessions.effortFor(picked.profileId, picked.model, t.effort.trim()) : undefined;
      const options = picked.model || effort ? { ...(picked.model ? { model: picked.model } : {}), ...(effort ? { effort } : {}) } : undefined;
      const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [];
      tasks.push({ key, title, workspaceId, ...(description ? { description } : {}), ...(firstMessage ? { firstMessage } : {}), profileId: picked.profileId, ...(options ? { options } : {}), dependsOn });
    }
    checkKeys(tasks);
    const at = new Date().toISOString();
    return this.save({ id: newId("plan"), topicId: facts.topic?.id ?? null, fromSessionId: sessionId, fromTaskId: facts.task?.id ?? null, summary, tasks, state: "open", createdAt: at, decidedAt: null });
  }

  /** The person accepts, with their changes: the tasks are made (and started, with `run`). */
  async accept(id: Id, input: { tasks?: unknown; run?: unknown }): Promise<TaskPlan> {
    const plan = this.requirePlan(id);
    if (plan.state !== "open") throw new HostError("conflict", "this proposal was decided already");
    const run = input.run === true;
    const given: Array<Record<string, unknown>> = Array.isArray(input.tasks) ? (input.tasks as Array<Record<string, unknown>>) : plan.tasks.map((t) => ({ ...t }));
    const kept: PlannedTask[] = [];
    for (const t of given) {
      if (!t || typeof t !== "object" || t.include === false) continue;
      const original = plan.tasks.find((p) => p.key === t.key);
      if (!original) throw new HostError("bad_request", `the proposal has no task ${String(t.key)}`);
      const title = typeof t.title === "string" && t.title.trim() ? t.title.trim() : original.title;
      const workspaceId = typeof t.workspaceId === "string" && t.workspaceId ? this.requireLiveWorkspace(t.workspaceId).id : original.workspaceId;
      const description = t.description === undefined ? original.description : optionalText(t.description, "description", TASK_DESCRIPTION_MAX);
      const firstMessage = t.firstMessage === undefined ? original.firstMessage : optionalText(t.firstMessage, "firstMessage", FIRST_MESSAGE_MAX);
      const profileId = typeof t.profileId === "string" && t.profileId ? this.requireProfile(t.profileId).id : original.profileId;
      // Another account picked: the proposed model and effort were that account's; the new one's defaults apply.
      const options = profileId === original.profileId ? original.options : undefined;
      kept.push({ key: original.key, title, workspaceId, ...(description ? { description } : {}), ...(firstMessage ? { firstMessage } : {}), ...(profileId ? { profileId } : {}), ...(options ? { options } : {}), dependsOn: original.dependsOn });
    }
    if (!kept.length) throw new HostError("bad_request", "keep at least one task, or dismiss the proposal");
    const topic = plan.topicId ? this.store.getTopic(plan.topicId) : undefined;
    const topicId = topic && !topic.archivedAt ? topic.id : null;
    // A group per project when the tasks span several (the person's case: one migration in three projects).
    const projects = [...new Set(kept.map((t) => t.workspaceId))];
    const groups = new Map<Id, Id>();
    if (topicId && projects.length > 1) {
      for (const ws of projects) {
        const w = this.store.getWorkspace(ws);
        groups.set(ws, this.f.canvases.canvasCreateGroup(topicId, { title: w && !isCommon(w) ? w.name : "未指定项目", ...(w && !isCommon(w) ? { workspace: ws } : {}) }).groupId);
      }
    }
    const made: Array<{ key: string; task: Task }> = [];
    for (const t of kept) {
      const { task } = await this.f.tasks.createTask({
        title: t.title,
        workspaceId: t.workspaceId,
        topicId,
        ...(run && t.profileId ? { firstSession: { profileId: t.profileId, ...(t.firstMessage ? { text: t.firstMessage } : {}), ...(t.options ? { options: t.options } : {}) } } : { column: "todo" as const }),
      });
      const described = t.description ? this.f.tasks.updateTask(task.id, { description: t.description }) : task;
      if (topicId) this.f.canvases.canvasPlaceTask(task.id, groups.get(t.workspaceId) ?? null);
      made.push({ key: t.key, task: described });
    }
    if (topicId) {
      for (const t of kept) {
        const to = made.find((m) => m.key === t.key)!.task.id;
        for (const dep of t.dependsOn) {
          const from = made.find((m) => m.key === dep)?.task.id;
          if (from) this.f.canvases.canvasAddDependency(from, to);
        }
      }
    }
    const accepted = this.save({ ...plan, state: "accepted", decidedAt: new Date().toISOString(), created: made.map((m) => ({ key: m.key, taskId: m.task.id })) });
    const lines = made.map((m) => `- ${m.task.title}（${m.task.id}）`);
    const dropped = plan.tasks.length - made.length;
    this.tellLead(
      plan,
      `人确认了你的拆任务提案「${firstLine(plan.summary)}」，建了 ${made.length} 个任务${dropped ? `（${dropped} 个没有采用）` : ""}，${run ? "都已开跑" : "放在待办里，等人开始"}：\n${lines.join("\n")}${topicId ? "\n它们已经在专题画布上，依赖也连好了。" : ""}`,
    );
    return accepted;
  }

  dismiss(id: Id, input: { note?: unknown }): TaskPlan {
    const plan = this.requirePlan(id);
    if (plan.state !== "open") throw new HostError("conflict", "this proposal was decided already");
    const note = optionalText(input.note, "note", SUMMARY_MAX);
    const dismissed = this.save({ ...plan, state: "dismissed", decidedAt: new Date().toISOString(), ...(note ? { note } : {}) });
    this.tellLead(plan, `人没有采用你的拆任务提案「${firstLine(plan.summary)}」${note ? `：${note}` : "。"}`);
    return dismissed;
  }

  /** The decision goes back to the 主控 as mail (the person decides when it enters the conversation). */
  private tellLead(plan: TaskPlan, text: string): void {
    try {
      this.f.collab.sendMail(null, { kind: "session", sessionId: plan.fromSessionId }, text);
    } catch {
      // The 主控's session is gone: the proposal still records the decision.
    }
  }

  private workspaceByRef(ref: string): Id {
    const ws = this.store.listWorkspaces().find((w) => !w.archivedAt && (w.id === ref || w.name === ref));
    if (!ws) throw new HostError("bad_request", `project ${ref} not found (give its id or name; project_context lists them)`);
    return ws.id;
  }

  private profileByRef(ref: string): ModelProfile {
    return this.f.profileByRef(ref);
  }
}

function optionalText(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HostError("bad_request", `${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw new HostError("bad_request", `${what} is limited to ${max} characters`);
  return t || undefined;
}

/** Keys are unique; dependencies name other planned tasks and make no cycle. */
function checkKeys(tasks: readonly PlannedTask[]): void {
  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) throw new HostError("bad_request", `two tasks share the key ${t.key}`);
    keys.add(t.key);
  }
  const edges: Array<{ from: string; to: string }> = [];
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!keys.has(d)) throw new HostError("bad_request", `task ${t.key} depends on ${d}, which is not in the proposal`);
      if (wouldCycle(edges, d, t.key)) throw new HostError("bad_request", `the dependencies of ${t.key} make a cycle`);
      edges.push({ from: d, to: t.key });
    }
  }
}

const firstLine = (text: string) => text.split(/\r?\n/)[0]!.slice(0, 80);
