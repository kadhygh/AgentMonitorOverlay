import { lineSuffix, type FileMark, type ProjectFile, type Session, type Task } from "@amo-studio/protocol";
import { baseName, dirName } from "./refs.js";

// "@" in a session's composer (stage 11): grouped suggestions — tasks, sessions of the same project or topic, recently
// changed files — and last entries that set up sub-sessions and open the file selector. Pure logic; the hook and the
// list live beside it.

export type MentionKind = "task" | "session" | "mark" | "file" | "find" | "subsession";

export interface MentionOption {
  kind: MentionKind;
  /** Task, session or mark id, the file's relative path, or "find". */
  id: string;
  name: string;
  hint: string;
}

export interface MentionGroup {
  kind: MentionKind;
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
}

/** A task, session or sub-session setup picked with @: the text keeps "@name", the message says what it is. */
export type MentionPick = { kind: "task"; id: string } | { kind: "session"; id: string; taskId: string | null } | { kind: "subsession"; spec: SubSessionSpec };

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
  return [
    ...groups.filter((g) => g.options.length),
    {
      kind: "find",
      heading: "",
      options: [
        ...(input.subsession ? [{ kind: "subsession" as const, id: "subsession", name: "开子会话…", hint: "选模型和强度，告诉它怎么开" }] : []),
        { kind: "find", id: "find", name: "找文件…", hint: "Ctrl+P" },
      ],
    },
  ];
}

/** The message as sent: the text, then which AMO tasks and sessions its @ names are (only those still in the text). */
export function withMentionRefs(message: string, picked: ReadonlyMap<string, MentionPick>): string {
  const refs = [...picked.entries()].filter(([name]) => message.includes(`@${name}`));
  const tasks = refs.flatMap(([name, p]) => (p.kind === "task" ? [`- @${name}：AMO 任务 ${p.id}（可以用 AMO 的 task_get 查看）`] : []));
  const sessions = refs.flatMap(([name, p]) =>
    p.kind === "session" ? [`- @${name}：AMO 会话 ${p.id}${p.taskId ? `，属于任务 ${p.taskId}（可以用 AMO 的 session_tree 查看）` : ""}`] : [],
  );
  const subs = refs.flatMap(([name, p]) => (p.kind === "subsession" ? [`- @${name}：${subSessionArgs(p.spec)}`] : []));
  const blocks = [
    tasks.length ? `提到的任务：\n${tasks.join("\n")}` : "",
    sessions.length ? `提到的会话：\n${sessions.join("\n")}` : "",
    subs.length ? `子会话的开法（要开时用 AMO 的 session_start，不要用你自带的子 agent；第一句话写够让它能独立开工）：\n${subs.join("\n")}` : "",
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
