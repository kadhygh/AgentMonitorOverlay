import type { Id, Session, Task, Workspace } from "./entities.js";

/**
 * Workspace names a task touches: its own workspace, or for a cross-workspace task the workspaces of its live
 * sessions, in order of first use.
 */
export function taskWorkspaceNames(task: Task, sessions: readonly Session[], workspaces: readonly Workspace[]): string[] {
  const name = (id: Id) => workspaces.find((w) => w.id === id)?.name ?? "未知工作区";
  if (task.scope.kind === "workspace") return [name(task.scope.workspaceId)];
  const ids = sessions
    .filter((s) => s.taskId === task.id && !s.archivedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => s.workspaceId);
  return [...new Set(ids)].map(name);
}

/** One-line label: "alpha", or "跨工作区（alpha、beta）". */
export function taskWhere(task: Task, sessions: readonly Session[], workspaces: readonly Workspace[]): string {
  const names = taskWorkspaceNames(task, sessions, workspaces);
  if (task.scope.kind === "workspace") return names[0]!;
  return `跨工作区${names.length ? `（${names.join("、")}）` : ""}`;
}
