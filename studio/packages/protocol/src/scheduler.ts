import type { Id, Session, SessionStatus, Workspace } from "./entities.js";

// Whether a project (workspace) is free for new work, for the canvas and the scheduler (design/scheduler.md). Busy
// means someone is at it: a session in that workspace is running, waits for the person (approval or review), or is in a
// terminal (the person may be typing there while Studio shows it idle).

export const BUSY_STATUSES: readonly SessionStatus[] = ["running", "awaiting-approval", "awaiting-review"];

export interface WorkspaceActivity {
  workspaceId: Id;
  idle: boolean;
  /** Live sessions that keep the workspace busy. */
  busy: number;
}

export function sessionKeepsBusy(s: Session): boolean {
  if (s.archivedAt) return false;
  return BUSY_STATUSES.includes(s.status) || s.writer === "terminal-handoff" || s.writer === "terminal-shared";
}

export function workspaceActivity(workspaceId: Id, sessions: readonly Session[]): WorkspaceActivity {
  const busy = sessions.filter((s) => s.workspaceId === workspaceId && sessionKeepsBusy(s)).length;
  return { workspaceId, idle: busy === 0, busy };
}

export function workspacesActivity(workspaces: readonly Workspace[], sessions: readonly Session[]): Map<Id, WorkspaceActivity> {
  return new Map(workspaces.map((w) => [w.id, workspaceActivity(w.id, sessions)]));
}
