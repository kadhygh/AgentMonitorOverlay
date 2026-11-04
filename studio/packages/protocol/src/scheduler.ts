import type { Id, Session, SessionStatus, Workspace } from "./entities.js";

// Whether a project (workspace) is free for new work, for the canvas and the scheduler (design/scheduler.md). Busy
// means someone is at it: a session in that workspace is running, waits for the person (approval or review), or is in a
// terminal (the person may be typing there while Studio shows it idle).

/**
 * In the middle of a turn: working, or the turn waits on the person (an approval, a question). What the runtimes, the
 * Host and the board mean by "the session is at it" (2026-11-04, plans/message-delivery.md: each had its own copy).
 */
export const TURN_STATUSES: readonly SessionStatus[] = ["running", "awaiting-approval", "awaiting-answer"];

export function inTurn(status: SessionStatus): boolean {
  return TURN_STATUSES.includes(status);
}


export interface WorkspaceActivity {
  workspaceId: Id;
  idle: boolean;
  /** Live sessions that keep the workspace busy. */
  busy: number;
}

export function sessionKeepsBusy(s: Session): boolean {
  if (s.archivedAt) return false;
  // awaiting-review no longer counts (2026-11-04, the user agreed): nothing sets it on a session.
  return inTurn(s.status) || s.writer === "terminal-handoff" || s.writer === "terminal-shared";
}

export function workspaceActivity(workspaceId: Id, sessions: readonly Session[]): WorkspaceActivity {
  const busy = sessions.filter((s) => s.workspaceId === workspaceId && sessionKeepsBusy(s)).length;
  return { workspaceId, idle: busy === 0, busy };
}

export function workspacesActivity(workspaces: readonly Workspace[], sessions: readonly Session[]): Map<Id, WorkspaceActivity> {
  return new Map(workspaces.map((w) => [w.id, workspaceActivity(w.id, sessions)]));
}
