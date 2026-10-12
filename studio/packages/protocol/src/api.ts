// Host API: REST requests/responses and the WS event stream. Host listens on 127.0.0.1 only.
import type { Id, ModelProfile, Session, SessionItem, Task, TaskColumn, TaskScope, Workspace } from "./entities.js";

export const HOST_DEFAULT_PORT = 47900;

export interface StateSnapshot {
  workspaces: Workspace[];
  tasks: Task[];
  sessions: Session[];
  profiles: ModelProfile[];
  /** Last event sequence included in this snapshot; subscribe to the event stream after it. */
  eventSeq: number;
}

export interface NewSessionInput {
  profileId: Id;
  /** Required for cross-workspace tasks; defaults to the task's workspace otherwise. */
  workspaceId?: Id;
  /** First user message; when present the session starts a turn right away. */
  text?: string;
}

export type ApprovalDecision = "accept" | "decline";

/** What "open in terminal" produced. The token travels only through the named env var, never in `command`. */
export interface TerminalAttach {
  command: string;
  envVar: string | null;
  /** False in test mode or when the caller asked only for the command. */
  launched: boolean;
}

/** Every REST route as `"METHOD /path"` with its request body and response. `:id` segments are path params. */
export interface HostRoutes {
  "GET /api/state": { req: void; res: StateSnapshot };
  "POST /api/workspaces": { req: { path: string; name?: string }; res: Workspace };
  "DELETE /api/workspaces/:id": { req: void; res: { ok: true } };
  "POST /api/tasks": { req: { title?: string; scope: TaskScope; firstSession: NewSessionInput }; res: { task: Task; session: Session } };
  "PATCH /api/tasks/:id": { req: { title?: string; column?: TaskColumn }; res: Task };
  "POST /api/tasks/:id/sessions": { req: NewSessionInput; res: Session };
  "GET /api/sessions/:id/items": { req: void; res: SessionItem[] };
  /** Starts a turn when idle, steers the running turn otherwise. */
  "POST /api/sessions/:id/messages": { req: { text: string }; res: { mode: "start" | "steer" } };
  "POST /api/sessions/:id/interrupt": { req: void; res: { ok: true } };
  "POST /api/sessions/:id/fork": { req: { profileId?: Id }; res: Session };
  /** Archives the session together with its forks and subagents; returns every session changed. */
  "POST /api/sessions/:id/archive": { req: void; res: Session[] };
  "POST /api/sessions/:id/unarchive": { req: void; res: Session[] };
  "POST /api/sessions/:id/terminal": { req: { launch: boolean }; res: TerminalAttach };
  "POST /api/sessions/:id/reclaim": { req: void; res: Session };
  "POST /api/approvals/:approvalId": { req: { sessionId: Id; decision: ApprovalDecision }; res: { ok: true } };
}

export type HostRoute = keyof HostRoutes;
export type RouteRequest<R extends HostRoute> = HostRoutes[R]["req"];
export type RouteResponse<R extends HostRoute> = HostRoutes[R]["res"];

export interface HostErrorBody {
  error: { code: HostErrorCode; message: string };
}
export type HostErrorCode = "bad_request" | "not_found" | "conflict" | "read_only" | "runtime_error" | "internal";

/** Events on `ws://127.0.0.1:<port>/api/events?since=<eventSeq>`. `seq` is global and monotonic. */
export type HostEvent = { seq: number } & (
  | { type: "workspace.upserted"; workspace: Workspace }
  | { type: "workspace.removed"; workspaceId: Id }
  | { type: "task.upserted"; task: Task }
  | { type: "session.upserted"; session: Session }
  | { type: "item.appended"; item: SessionItem }
  /** Full replacement, e.g. a finished agent message or an approval that changed state. */
  | { type: "item.updated"; item: SessionItem }
  /** Streaming text appended to an agent item; not persisted as a separate event. */
  | { type: "item.delta"; sessionId: Id; itemId: Id; append: string }
);

export type HostEventType = HostEvent["type"];
