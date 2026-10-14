import type { StateSnapshot } from "@amo-studio/protocol";

// The search box left of "+ 新任务" (stage 14): tasks and sessions by name, project and topic. Pure, so it is tested
// without the page.

export type SearchHit =
  | { kind: "task"; id: string; title: string; where: string; archived: boolean; updatedAt: string }
  | {
      kind: "session";
      id: string;
      /** The session's task; null for a topic's own session (it lives on the topic's canvas). */
      taskId: string | null;
      topicId: string | null;
      title: string;
      /** Its task's or topic's name. */
      owner: string;
      where: string;
      archived: boolean;
      updatedAt: string;
    };

/** The words of a query: every one must be found (case aside). */
export const searchTokens = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Matching tasks and sessions. Every word must appear in the name, the task / topic name, the project or the topic.
 * Live ones first, then the ones whose name holds the whole query, then the ones whose name holds every word, then
 * the rest (found through the project or topic), each group most recently active first. An empty query lists the most
 * recently active live ones.
 */
export function searchAll(state: Pick<StateSnapshot, "tasks" | "sessions" | "workspaces" | "topics">, query: string, limit = 20): SearchHit[] {
  const workspace = new Map(state.workspaces.map((w) => [w.id, w.name]));
  const topic = new Map(state.topics.map((t) => [t.id, t.title || "专题"]));
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  const hits: SearchHit[] = [];
  for (const t of state.tasks) {
    const where = [workspace.get(t.workspaceId), t.topicId ? topic.get(t.topicId) : undefined].filter(Boolean).join(" · ");
    hits.push({ kind: "task", id: t.id, title: t.title || "未命名任务", where, archived: !!t.archivedAt, updatedAt: t.updatedAt });
  }
  for (const s of state.sessions) {
    const task = s.taskId ? taskById.get(s.taskId) : undefined;
    if (s.taskId && !task) continue;
    const owner = task ? task.title || "未命名任务" : s.topicId ? (topic.get(s.topicId) ?? "专题") : "";
    const topicId = task ? task.topicId : s.topicId;
    const where = [workspace.get(s.workspaceId), topicId ? topic.get(topicId) : undefined].filter(Boolean).join(" · ");
    hits.push({
      kind: "session",
      id: s.id,
      taskId: s.taskId,
      topicId: s.topicId,
      title: s.title || "新会话",
      owner,
      where,
      archived: !!s.archivedAt || !!task?.archivedAt,
      updatedAt: s.updatedAt,
    });
  }
  const tokens = searchTokens(query);
  const newest = (a: SearchHit, b: SearchHit) => b.updatedAt.localeCompare(a.updatedAt);
  if (!tokens.length) return hits.filter((h) => !h.archived).sort(newest).slice(0, Math.min(limit, 8));
  const whole = query.trim().toLowerCase();
  const scored: Array<{ hit: SearchHit; rank: number }> = [];
  for (const hit of hits) {
    const name = hit.title.toLowerCase();
    const all = [hit.title, hit.kind === "session" ? hit.owner : "", hit.where].join("\n").toLowerCase();
    if (!tokens.every((w) => all.includes(w))) continue;
    const rank = name.includes(whole) ? 0 : tokens.every((w) => name.includes(w)) ? 1 : 2;
    scored.push({ hit, rank: rank + (hit.archived ? 10 : 0) });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || newest(a.hit, b.hit))
    .slice(0, limit)
    .map((s) => s.hit);
}

/** A name cut into plain and matched parts, for marking the words found. */
export function markParts(text: string, tokens: readonly string[]): Array<{ text: string; hit: boolean }> {
  if (!tokens.length) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const w of tokens) {
    for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + w.length)) marked.fill(true, at, at + w.length);
  }
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.hit === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: marked[i]! });
  }
  return parts;
}
