// Neutral sample data for tests and UI development. Not product content.
import type { ModelProfile, Session, SessionItem, Task, Workspace } from "./entities.js";

const t = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, "0")}:00.000Z`;

export const exampleWorkspaces: Workspace[] = [
  { id: "ws-alpha", name: "alpha", path: "C:/sandbox/alpha", createdAt: t(0) },
  { id: "ws-beta", name: "beta", path: "C:/sandbox/beta", createdAt: t(0) },
];

export const exampleProfiles: ModelProfile[] = [
  { id: "codex-default", label: "Codex", runtime: "codex", provider: null, model: null },
  { id: "codex-deepseek-flash", label: "DeepSeek Flash", runtime: "codex", provider: "amo-deepseek", model: "deepseek-flash", reasoningEffort: "low", credentialId: "deepseek-v4" },
];

export const exampleTasks: Task[] = [
  { id: "task-1", title: "Add retry to the importer", scope: { kind: "workspace", workspaceId: "ws-alpha" }, column: "doing", createdAt: t(1), updatedAt: t(9) },
  { id: "task-2", title: "Align config keys across projects", scope: { kind: "area" }, column: "todo", createdAt: t(2), updatedAt: t(2) },
];

const session = (over: Partial<Session> & Pick<Session, "id" | "createdAt">): Session => ({
  taskId: "task-1", parentId: null, kind: "main", runtime: "codex", profileId: "codex-deepseek-flash", workspaceId: "ws-alpha",
  title: "", status: "idle", writer: "workbench", runtimeRef: null, options: {}, updatedAt: over.createdAt, archivedAt: null, ...over,
});

export const exampleSessions: Session[] = [
  session({ id: "s-main", title: "Plan the retry", createdAt: t(3), status: "awaiting-approval", runtimeRef: "thread-main" }),
  session({ id: "s-fork", parentId: "s-main", kind: "fork", title: "Try exponential backoff", createdAt: t(5), runtimeRef: "thread-fork" }),
  session({ id: "s-sub", parentId: "s-fork", kind: "sub", title: "explorer", createdAt: t(6), status: "completed", runtimeRef: "thread-sub" }),
  session({ id: "s-second", title: "Write tests", createdAt: t(7), profileId: "codex-default" }),
];

export const exampleItems: SessionItem[] = [
  { id: "i-1", sessionId: "s-main", seq: 1, createdAt: t(3), type: "user", text: "Add retry to the importer." },
  { id: "i-2", sessionId: "s-main", seq: 2, createdAt: t(4), type: "agent", markdown: "Looking at `importer.ts` first.", streaming: false },
  { id: "i-3", sessionId: "s-main", seq: 3, createdAt: t(4), type: "tool", name: "shell", summary: "rg retry", status: "completed" },
  { id: "i-4", sessionId: "s-main", seq: 4, createdAt: t(5), type: "approval", approvalId: "0", kind: "command", summary: "npm test", state: "pending" },
  { id: "i-5", sessionId: "s-fork", seq: 1, createdAt: t(6), type: "subagent", childSessionId: "s-sub", summary: "explorer: map call sites" },
];
