import type { Id, Task, Topic, Workspace } from "./entities.js";

// Where things run (design/structure.md): every task has one workspace; the common space is a hidden built-in one.

export const isCommon = (ws: Pick<Workspace, "builtin"> | undefined | null): boolean => ws?.builtin === "common";

/** Workspaces a person picks from: the projects, without the common space. */
export const projectWorkspaces = (workspaces: readonly Workspace[]): Workspace[] => workspaces.filter((w) => !isCommon(w));

/** The project a task runs in, or null for the common space (the UI then shows no project at all). */
export function taskProject(task: Pick<Task, "workspaceId">, workspaces: readonly Workspace[]): Workspace | null {
  const ws = workspaces.find((w) => w.id === task.workspaceId);
  return ws && !isCommon(ws) ? ws : null;
}

/** One-line label for agents and logs: the project's name, or "未指定项目". */
export function taskWhere(task: Pick<Task, "workspaceId">, workspaces: readonly Workspace[]): string {
  const ws = workspaces.find((w) => w.id === task.workspaceId);
  if (!ws) return "未知项目";
  return isCommon(ws) ? "未指定项目" : ws.name;
}

/** A topic's projects: the ones added by hand, then its live tasks' workspaces, without the common space. */
export function topicWorkspaceIds(topic: Pick<Topic, "id" | "workspaceIds">, tasks: readonly Task[], workspaces: readonly Workspace[]): Id[] {
  const ids = [...topic.workspaceIds, ...tasks.filter((t) => t.topicId === topic.id && !t.archivedAt).map((t) => t.workspaceId)];
  const common = new Set(workspaces.filter(isCommon).map((w) => w.id));
  return [...new Set(ids)].filter((id) => !common.has(id) && workspaces.some((w) => w.id === id));
}
