import { lineSuffix, type FileMark, type ProjectFile, type Session, type Task } from "@amo-studio/protocol";
import { baseName, dirName } from "./refs.js";

// "@" in a session's composer (stage 11): grouped suggestions — tasks, sessions of the same project or topic, recently
// changed files and the file selector — and last「AMO 扩展功能」(10-26): sub-session setups and 快速提交. Pure logic;
// the hook and the list live beside it.

export type MentionKind = "task" | "session" | "mark" | "file" | "find" | "subsession" | "commit";

export interface MentionOption {
  kind: MentionKind;
  /** Task, session or mark id, the file's relative path, or "find". */
  id: string;
  name: string;
  hint: string;
}

export interface MentionGroup {
  kind: MentionKind | "ext";
  heading: string;
  options: MentionOption[];
}

/**
 * 开子会话 (2026-10-26): how the model is to start sub-sessions when it does — AMO's session_start with these. The
 * person usually says when ("接下来你开子会话就用 @子会话1").
 */
export interface SubSessionSpec {
  /** session_start's model: a profile's name, or "<profile>/<model>" for one of its models. */
  model: string;
  /** How the person knows it ("Opus"). */
  modelName: string;
  effort?: string;
  permission?: "read-only" | "write" | "full";
  report: boolean;
  /** 设置 → 子会话: the person's note on that model as a sub-session. */
  note?: string;
}

/** A task, session, sub-session setup or 快速提交 picked with @: the text keeps "@name", the message says what it is. */
export type MentionPick = { kind: "task"; id: string } | { kind: "session"; id: string; taskId: string | null } | { kind: "subsession"; spec: SubSessionSpec } | { kind: "commit"; push: boolean };

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
const contains = (name: string, q: string) => name.toLowerCase().includes(q);

/** Sessions the person may want to point at: the same project, or the same topic, not this one and not subagents. */
export function nearbySessions(sessions: readonly Session[], current: Session): Session[] {
  return sessions
    .filter((s) => s.id !== current.id && !s.archivedAt && s.kind !== "sub" && (s.workspaceId === current.workspaceId || (!!current.topicId && s.topicId === current.topicId)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
}): MentionGroup[] {
  const q = input.query.toLowerCase();
  const pinned = input.pinnedTask ?? (() => false);
  const tasks = [...input.tasks]
    .sort((a, b) => Number(pinned(b)) - Number(pinned(a)))
    .filter((t) => !t.archivedAt && contains(t.title || "未命名任务", q))
    .slice(0, PER_GROUP)
    .map((t): MentionOption => ({ kind: "task", id: t.id, name: t.title || "未命名任务", hint: t.column === "done" ? "完成" : "" }));
  const taskTitle = new Map(input.tasks.map((t) => [t.id, t.title || "未命名任务"]));
  const sessions = (input.current ? nearbySessions(input.sessions, input.current) : [])
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
    { kind: "mark", heading: "书签里的文件", options: marks },
    { kind: "file", heading: input.query ? "文件" : "最近改动的文件", options: files },
  ];
  const ext: MentionOption[] = [
    ...(input.subsession ? [{ kind: "subsession" as const, id: "subsession", name: "开子会话…", hint: "选模型和强度，告诉它怎么开" }] : []),
    ...(input.commit ? [{ kind: "commit" as const, id: "commit", name: QUICK_COMMIT, hint: "分条提交、拉取合并，可选推送　Ctrl+Shift+P" }] : []),
  ].filter((o) => !q || contains(o.name, q));
  return [
    ...groups.filter((g) => g.options.length),
    { kind: "find", heading: "", options: [{ kind: "find", id: "find", name: "找文件…", hint: "Ctrl+P" }] },
    ...(ext.length ? [{ kind: "ext" as const, heading: "AMO 扩展功能", options: ext }] : []),
  ];
}

/** The message as sent: the text, then which AMO tasks and sessions its @ names are (only those still in the text). */
export function withMentionRefs(message: string, picked: ReadonlyMap<string, MentionPick>): string {
  // Named in full: 「@快速提交吧」 does not also name 「快速提交」.
  const named = new Set(mentionSpans(message, [...picked.keys()]).flatMap((part) => (part.mention ? [part.text.slice(1)] : [])));
  const refs = [...picked.entries()].filter(([name]) => named.has(name));
  const tasks = refs.flatMap(([name, p]) => (p.kind === "task" ? [`- @${name}：AMO 任务 ${p.id}（可以用 AMO 的 task_get 查看）`] : []));
  const sessions = refs.flatMap(([name, p]) =>
    p.kind === "session" ? [`- @${name}：AMO 会话 ${p.id}${p.taskId ? `，属于任务 ${p.taskId}（可以用 AMO 的 session_tree 查看）` : ""}`] : [],
  );
  const subs = refs.flatMap(([name, p]) => (p.kind === "subsession" ? [`- @${name}：${subSessionArgs(p.spec)}${p.spec.note ? `。人对这个模型的说明：${p.spec.note.replace(/\s+/g, " ")}` : ""}`] : []));
  const blocks = [
    tasks.length ? `提到的任务：\n${tasks.join("\n")}` : "",
    sessions.length ? `提到的会话：\n${sessions.join("\n")}` : "",
    subs.length ? `子会话的开法（要开时用 AMO 的 session_start，不要用你自带的子 agent；第一句话写够让它能独立开工）：\n${subs.join("\n")}` : "",
    ...refs.flatMap(([, p]) => (p.kind === "commit" ? [quickCommitBrief(p.push)] : [])),
  ].filter(Boolean);
  return blocks.length ? `${message}\n\n${blocks.join("\n\n")}` : message;
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

/** A sub-session setup as session_start's arguments, for the model to copy. */
export function subSessionArgs(spec: SubSessionSpec): string {
  const args = [`model: "${spec.model}"（${spec.modelName}）`, spec.effort ? `effort: "${spec.effort}"` : "", spec.permission ? `permission: "${spec.permission}"` : "", `report: ${spec.report}`];
  return `session_start 带 ${args.filter(Boolean).join("，")}`;
}

/** The next free 「子会话N」 name: not in the text and not picked already. */
export function nextSubSessionName(text: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const name = `子会话${n}`;
    if (!used.has(name) && !text.includes(`@${name}`)) return name;
  }
}
