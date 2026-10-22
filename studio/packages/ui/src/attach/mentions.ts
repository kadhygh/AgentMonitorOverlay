import { lineSuffix, type FileMark, type ProjectFile, type Session, type Task } from "@amo-studio/protocol";
import { baseName, dirName } from "./refs.js";

// "@" in a session's composer (stage 11): grouped suggestions — tasks, sessions of the same project or topic, recently
// changed files — and a last entry that opens the file selector. Pure logic; the hook and the list live beside it.

export type MentionKind = "task" | "session" | "mark" | "file" | "find";

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

/** A task or session picked with @: the text keeps "@name", the message says which one it is. */
export type MentionPick = { kind: "task"; id: string } | { kind: "session"; id: string; taskId: string | null };

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
    { kind: "find", heading: "", options: [{ kind: "find", id: "find", name: "找文件…", hint: "Ctrl+P" }] },
  ];
}

/** The message as sent: the text, then which AMO tasks and sessions its @ names are (only those still in the text). */
export function withMentionRefs(message: string, picked: ReadonlyMap<string, MentionPick>): string {
  const refs = [...picked.entries()].filter(([name]) => message.includes(`@${name}`));
  const tasks = refs.flatMap(([name, p]) => (p.kind === "task" ? [`- @${name}：AMO 任务 ${p.id}（可以用 AMO 的 task_get 查看）`] : []));
  const sessions = refs.flatMap(([name, p]) =>
    p.kind === "session" ? [`- @${name}：AMO 会话 ${p.id}${p.taskId ? `，属于任务 ${p.taskId}（可以用 AMO 的 session_tree 查看）` : ""}`] : [],
  );
  const blocks = [tasks.length ? `提到的任务：\n${tasks.join("\n")}` : "", sessions.length ? `提到的会话：\n${sessions.join("\n")}` : ""].filter(Boolean);
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
