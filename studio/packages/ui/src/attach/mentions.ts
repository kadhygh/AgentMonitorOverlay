import { lineSuffix, RUNTIME_LABELS, type FileMark, type ProjectFile, type Session, type SubsessionPermission, type SubsessionSetup, type Task, type Workspace } from "@amo-studio/protocol";
import { baseName, dirName } from "./refs.js";

// "@" in a session's composer (stage 11): grouped suggestions — tasks, sessions of the same project or topic, recently
// changed files and the file selector — and last「AMO 扩展功能」(10-26): sub-session setups, 快速提交 and (10-31)
// 提示词模板. Pure logic;
// the hook and the list live beside it.

export type MentionKind = "task" | "session" | "project" | "mark" | "file" | "find" | "subsession" | "commit" | "template";

export interface MentionOption {
  kind: MentionKind;
  /** Task, session, project or mark id, the file's relative path, or "find". */
  id: string;
  name: string;
  hint: string;
  /** A session listed under its task (the new-task page, 2026-10-29). */
  sub?: boolean;
}

export interface MentionGroup {
  kind: MentionKind | "ext";
  heading: string;
  options: MentionOption[];
}

/**
 * 开子会话 (2026-10-26): how the model is to start sub-sessions when it does — AMO's session_start with these. The
 * person usually says when ("接下来你开子会话就用 @子会话1").
 * 2026-11-05 (plans/done/subsession-mention-2026-11-05.md): sent to the Host with the message (SubsessionSetup), so
 * session_start takes it by name (`setup`); the model's own options (effort, Fast), the person's words for this round
 * (`extra`). Whether its results come back is the model's to decide (session_start's report), no longer set here.
 */
export interface SubSessionSpec {
  profileId: string;
  /** One of the profile's models; null: its default. */
  modelId: string | null;
  /** session_start's model, for the model to read: a profile's name, or "<profile>/<model>". */
  model: string;
  /** How the person knows it ("Opus 5.5"). */
  modelName: string;
  effort?: string;
  fast?: boolean;
  permission?: SubsessionPermission;
  /** 设置 → 子会话: the person's note on that model as a sub-session (for the main model). */
  note?: string;
  /** 这一轮补充: the person's words for the sub-session itself. */
  extra?: string;
}

/** A task, session, sub-session setup or 快速提交 picked with @: the text keeps "@name", the message says what it is. */
export type MentionPick =
  | { kind: "task"; id: string }
  | { kind: "session"; id: string; taskId: string | null }
  | { kind: "project"; id: string; path: string }
  | { kind: "subsession"; spec: SubSessionSpec }
  | { kind: "commit"; push: boolean };

/** 快速提交 (10-26): the one name in the text; whether it pushes too was confirmed in its dialog. */
export const QUICK_COMMIT = "快速提交";

/**
 * What 「@快速提交」 asks of the model: commit the local changes (split by what they are about), pull the upstream
 * with a merge, push too when chosen, and ask the person where it is unclear and about every conflict.
 */
export function quickCommitBrief(push: boolean): string {
  return [
    `「@${QUICK_COMMIT}」是人要你现在做的事：把本地改动提交，再拉取上游并合并${push ? "，最后推送" : "（这次不推送）"}。`,
    "1. 先看清本地改动（git status、git diff，没跟踪的文件也算），按开发内容分组：不相关的内容分成多条 commit，每条只放属于它的改动（一个文件里混了几件事时按块暂存）。提交信息照这个仓库以往的写法。",
    "2. 拿不准的先问人，不要猜：某个改动该不该提交（临时文件、调试代码、像密钥的东西）、该归哪一条、为什么这么改看不出来。",
    "3. 提交完拉取当前分支的上游：git pull --no-rebase（用合并，不要变基）。没有上游、或者不确定该从哪里拉时问人。",
    "4. 合并有冲突时不要自己挑：列出每个冲突文件、两边各改了什么、你建议怎么解决，问人；照人的回答解决，确认没有冲突标记、能编译的先编译一下，再完成合并提交。",
    push
      ? "5. 合并好以后 git push 到上游。被拒绝（上游又有新提交）时再拉取合并一次再推；不要 --force。不要用会丢改动的命令（reset --hard、checkout -- 、clean -f、stash drop 之类）。"
      : "5. 不要 push；不要用会丢改动的命令（reset --hard、checkout -- 、clean -f、stash drop、push --force 之类）。",
    `6. 做完告诉人：提交了哪几条（短哈希和标题）、拉下来了哪些提交、冲突怎么解决的${push ? "、推送到了哪里" : ""}。`,
    "问人时用你的提问工具（有的话），没有就停下来在回复里问，等人回答再继续。",
  ].join("\n");
}

const PER_GROUP = 5;
const SESSIONS_PER_TASK = 3;
const contains = (name: string, q: string) => name.toLowerCase().includes(q);

/** Sessions the person may want to point at: the same project, or the same topic, not this one and not subagents. */
export function nearbySessions(sessions: readonly Session[], current: Session): Session[] {
  return sessions
    .filter((s) => s.id !== current.id && !s.archivedAt && s.kind !== "sub" && (s.workspaceId === current.workspaceId || (!!current.topicId && s.topicId === current.topicId)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Each task's sessions a person may point at (not subagents, not archived), newest first. */
function taskSessions(sessions: readonly Session[]): Map<string, Session[]> {
  const out = new Map<string, Session[]>();
  for (const s of [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!s.taskId || s.archivedAt || s.kind === "sub") continue;
    out.set(s.taskId, [...(out.get(s.taskId) ?? []), s]);
  }
  return out;
}

export function mentionGroups(input: {
  query: string;
  tasks: readonly Task[];
  /** Tasks of pinned topics and projects come first. */
  pinnedTask?(task: Task): boolean;
  sessions: readonly Session[];
  current: Session | null;
  /** Recent files, or the selector's results for the query (already filtered by the Host). */
  files: readonly ProjectFile[];
  /** The project's file marks (S12-D), matched against their path and note. */
  marks?: readonly FileMark[];
  /** 开子会话… is offered (the session may start sessions: a main or forked session of a task). */
  subsession?: boolean;
  /** 快速提交 is offered (a live session). */
  commit?: boolean;
  /** 提示词模板… is offered (2026-10-31: a composer with room for several lines). */
  template?: boolean;
  /** Projects to offer (2026-10-29: the new-task page, and the composer once something is typed). */
  projects?: readonly Workspace[];
  /**
   * The new-task page (2026-10-29): no session of its own, so each task lists its sessions under it (those matching the
   * query, or the newest ones when the task's own name matches) instead of the sessions near the current one.
   */
  sessionsUnderTasks?: boolean;
  /** "找文件…" is offered (default: yes; the new-task page only once a project is picked). */
  find?: boolean;
}): MentionGroup[] {
  const q = input.query.toLowerCase();
  const pinned = input.pinnedTask ?? (() => false);
  const under = input.sessionsUnderTasks ? taskSessions(input.sessions) : null;
  const titleOf = (t: Task) => t.title || "未命名任务";
  const matchingSessions = (t: Task) => (under?.get(t.id) ?? []).filter((s) => contains(s.title || "未命名会话", q));
  const tasks = [...input.tasks]
    .sort((a, b) => Number(pinned(b)) - Number(pinned(a)))
    .filter((t) => !t.archivedAt && (contains(titleOf(t), q) || (!!q && matchingSessions(t).length > 0)))
    .slice(0, PER_GROUP)
    .flatMap((t): MentionOption[] => {
      const own: MentionOption = { kind: "task", id: t.id, name: titleOf(t), hint: t.column === "done" ? "完成" : "" };
      if (!under) return [own];
      const shown = (contains(titleOf(t), q) ? (under.get(t.id) ?? []) : matchingSessions(t)).slice(0, SESSIONS_PER_TASK);
      return [own, ...shown.map((s): MentionOption => ({ kind: "session", id: s.id, name: s.title || "未命名会话", hint: RUNTIME_LABELS[s.runtime] ?? "", sub: true }))];
    });
  const projects = (input.projects ?? [])
    .filter((w) => contains(w.name, q))
    .slice(0, PER_GROUP)
    .map((w): MentionOption => ({ kind: "project", id: w.id, name: w.name, hint: w.path }));
  const taskTitle = new Map(input.tasks.map((t) => [t.id, titleOf(t)]));
  const sessions = (input.current && !under ? nearbySessions(input.sessions, input.current) : [])
    .filter((s) => contains(s.title || "未命名会话", q))
    .slice(0, PER_GROUP)
    .map((s): MentionOption => ({ kind: "session", id: s.id, name: s.title || "未命名会话", hint: s.taskId ? (taskTitle.get(s.taskId) ?? "") : "专题会话" }));
  const marks = (input.marks ?? [])
    .filter((m) => m.exists && (contains(m.path, q) || contains(m.note, q)))
    .slice(0, PER_GROUP)
    .map((m): MentionOption => ({ kind: "mark", id: m.id, name: `${baseName(m.path)}${lineSuffix(m.startLine, m.endLine)}`, hint: m.note.split("\n")[0] || dirName(m.path) }));
  const files = input.files.slice(0, PER_GROUP).map((f): MentionOption => {
    const slash = f.path.lastIndexOf("/");
    return { kind: "file", id: f.path, name: f.path.slice(slash + 1), hint: slash > 0 ? f.path.slice(0, slash) : "" };
  });
  const groups: MentionGroup[] = [
    { kind: "task", heading: "任务", options: tasks },
    { kind: "session", heading: "会话", options: sessions },
    { kind: "project", heading: "项目", options: projects },
    { kind: "mark", heading: "书签里的文件", options: marks },
    { kind: "file", heading: input.query ? "文件" : "最近改动的文件", options: files },
  ];
  const ext: MentionOption[] = [
    ...(input.subsession ? [{ kind: "subsession" as const, id: "subsession", name: "开子会话…", hint: "选模型、强度，补充这轮的话" }] : []),
    ...(input.commit ? [{ kind: "commit" as const, id: "commit", name: QUICK_COMMIT, hint: "分条提交、拉取合并，可选推送　Ctrl+Shift+P" }] : []),
    ...(input.template ? [{ kind: "template" as const, id: "template", name: "提示词模板…", hint: "选一条存好的提示词，粘进输入框" }] : []),
  ].filter((o) => !q || contains(o.name, q));
  return [
    ...groups.filter((g) => g.options.length),
    ...(input.find === false ? [] : [{ kind: "find" as const, heading: "", options: [{ kind: "find" as const, id: "find", name: "找文件…", hint: "Ctrl+P" }] }]),
    ...(ext.length ? [{ kind: "ext" as const, heading: "AMO 扩展功能", options: ext }] : []),
  ];
}

/** The message as sent: the text, then which AMO projects, tasks and sessions its @ names are (only those still in the text). */
export function withMentionRefs(message: string, picked: ReadonlyMap<string, MentionPick>): string {
  // Named in full: 「@快速提交吧」 does not also name 「快速提交」.
  const named = new Set(mentionSpans(message, [...picked.keys()]).flatMap((part) => (part.mention ? [part.text.slice(1)] : [])));
  const refs = [...picked.entries()].filter(([name]) => named.has(name));
  const projects = refs.flatMap(([name, p]) => (p.kind === "project" ? [`- @${name}：AMO 项目 ${p.id}，文件夹 ${p.path}（可以用 AMO 的 project_context 查看）`] : []));
  const tasks = refs.flatMap(([name, p]) => (p.kind === "task" ? [`- @${name}：AMO 任务 ${p.id}（可以用 AMO 的 task_get 查看）`] : []));
  const sessions = refs.flatMap(([name, p]) =>
    p.kind === "session" ? [`- @${name}：AMO 会话 ${p.id}${p.taskId ? `，属于任务 ${p.taskId}（可以用 AMO 的 session_tree 查看）` : ""}`] : [],
  );
  const subs = refs.flatMap(([name, p]) => (p.kind === "subsession" ? [`- @${name}：${subSessionArgs(name, p.spec)}${p.spec.note ? `。人对这个模型的说明：${p.spec.note.replace(/\s+/g, " ")}` : ""}`] : []));
  const blocks = [
    projects.length ? `提到的项目：\n${projects.join("\n")}` : "",
    tasks.length ? `提到的任务：\n${tasks.join("\n")}` : "",
    sessions.length ? `提到的会话：\n${sessions.join("\n")}` : "",
    subs.length
      ? `子会话的设定（人设好的子会话：要开时用 AMO 的 session_start 带 setup: "名字"，不要用你自带的子 agent。模型、思考强度、Fast、权限和人补充给它的话 Host 会照设定带上；什么时候开、开几个你定，第一句话照常写够让它能独立开工）：\n${subs.join("\n")}`
      : "",
    ...refs.flatMap(([, p]) => (p.kind === "commit" ? [quickCommitBrief(p.push)] : [])),
  ].filter(Boolean);
  return blocks.length ? `${message}\n\n${blocks.join("\n\n")}` : message;
}

/** Where withMentionRefs' blocks start, each after a blank line ("子会话的开法（": before 2026-11-05). */
const REF_HEADS = ["提到的任务：\n", "提到的会话：\n", "子会话的开法（", `「@${QUICK_COMMIT}」是人要你现在做的事`, "提到的项目：\n", "子会话的设定（"];

/**
 * A sent message read back (2026-10-28): the person's text, the @ names it picked (each with what the message said of
 * it), and 快速提交 (whether it pushes) — so the conversation colours them as the composer did, the blocks behind a tag.
 */
export function splitMentionRefs(message: string): { text: string; names: Map<string, string>; commit: { push: boolean } | null; blocks: string } {
  const at = Math.min(...REF_HEADS.map((h) => message.indexOf(`\n\n${h}`)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return { text: message, names: new Map(), commit: null, blocks: "" };
  const blocks = message.slice(at + 2);
  const names = new Map<string, string>();
  for (const line of blocks.split("\n")) {
    const m = /^- @(.+?)：(.*)$/.exec(line);
    if (m) names.set(m[1]!, m[2]!);
  }
  const brief = blocks.indexOf(REF_HEADS[3]!);
  const commit = brief >= 0 ? { push: blocks.slice(brief).split("\n")[0]!.includes("最后推送") } : null;
  if (commit) names.set(QUICK_COMMIT, commit.push ? "提交、拉取合并，再推送" : "提交、拉取合并，这次不推送");
  return { text: message.slice(0, at), names, commit, blocks };
}

/**
 * The text cut where it names a picked task or session ("@名字"), so the composer can colour those parts (10-22).
 * Longer names win where one name starts another's.
 */
export function mentionSpans(text: string, names: readonly string[]): Array<{ text: string; mention: boolean }> {
  const tokens = [...new Set(names)].filter(Boolean).map((n) => `@${n}`).sort((a, b) => b.length - a.length);
  const out: Array<{ text: string; mention: boolean }> = [];
  let plain = "";
  for (let i = 0; i < text.length; ) {
    const hit = text[i] === "@" ? tokens.find((t) => text.startsWith(t, i)) : undefined;
    if (!hit) {
      plain += text[i++];
      continue;
    }
    if (plain) out.push({ text: plain, mention: false });
    plain = "";
    out.push({ text: hit, mention: true });
    i += hit.length;
  }
  if (plain) out.push({ text: plain, mention: false });
  return out;
}

const PERMISSION_LABELS: Record<SubsessionPermission, string> = { "read-only": "只读", write: "可写", full: "完全放开" };

/** What a setup is, for the model to read: session_start's `setup` and what it holds. */
export function subSessionArgs(name: string, spec: SubSessionSpec): string {
  const parts = [`model "${spec.model}"（${spec.modelName}）`, `思考强度 ${spec.effort ?? "默认"}`, spec.fast ? "Fast 开" : "", spec.permission ? `权限 ${spec.permission}（${PERMISSION_LABELS[spec.permission]}）` : "", spec.extra ? "人补充了给它的话" : ""];
  return `session_start 带 setup: "${name}"（${parts.filter(Boolean).join("，")}）`;
}

/** The tag a setup shows in the text (the user, 11-05: 「子会话-模型名-思考强度」), without "@". */
export function subSessionTag(spec: Pick<SubSessionSpec, "modelName" | "effort" | "fast">): string {
  return `子会话·${spec.modelName}·${spec.effort ?? "默认强度"}${spec.fast ? "·Fast" : ""}`;
}

/** The setup's tag, numbered (2, 3…) where the text or the picks already have it. */
export function subSessionName(spec: SubSessionSpec, text: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = subSessionTag(spec);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}${n}`;
    if (!used.has(name) && !text.includes(`@${name}`)) return name;
  }
}

/** The 子会话设定 a message names, as sent to the Host with it. */
export function subSessionSetups(message: string, picked: ReadonlyMap<string, MentionPick>): SubsessionSetup[] {
  const named = new Set(mentionSpans(message, [...picked.keys()]).flatMap((part) => (part.mention ? [part.text.slice(1)] : [])));
  return [...picked.entries()].flatMap(([name, p]) =>
    p.kind === "subsession" && named.has(name)
      ? [{ name, profileId: p.spec.profileId, model: p.spec.modelId, ...(p.spec.effort ? { effort: p.spec.effort } : {}), ...(p.spec.fast !== undefined ? { fast: p.spec.fast } : {}), ...(p.spec.permission ? { permission: p.spec.permission } : {}), ...(p.spec.extra ? { extra: p.spec.extra } : {}) }]
      : [],
  );
}

/** A setup in full, for the tag's tooltip. */
export function subSessionDetail(spec: SubSessionSpec): string {
  return [
    `子会话：${spec.modelName}（${spec.model}）`,
    `思考强度：${spec.effort ?? "默认"}`,
    spec.fast !== undefined ? `Fast：${spec.fast ? "开" : "关"}` : "",
    `权限：${spec.permission ? PERMISSION_LABELS[spec.permission] : "默认"}`,
    spec.extra ? `这一轮补充：${spec.extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
