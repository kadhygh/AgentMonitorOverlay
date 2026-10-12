import { describe, expect, it } from "vitest";
import { exampleSessions, exampleTasks, exampleWorkspaces } from "./examples.js";
import { taskWhere, taskWorkspaceNames } from "./scope.js";

describe("taskWhere", () => {
  const area = exampleTasks.find((t) => t.scope.kind === "area")!;
  const own = exampleTasks.find((t) => t.scope.kind === "workspace")!;
  const session = (id: string, workspaceId: string, createdAt: string, archivedAt: string | null = null) => ({
    ...exampleSessions[0]!,
    id,
    taskId: area.id,
    workspaceId,
    createdAt,
    archivedAt,
  });

  it("names a workspace task's own workspace", () => {
    expect(taskWhere(own, exampleSessions, exampleWorkspaces)).toBe("alpha");
  });

  it("lists a cross-workspace task's live session workspaces in order of first use", () => {
    expect(taskWhere(area, [], exampleWorkspaces)).toBe("跨工作区");
    const sessions = [
      session("a", "ws-alpha", "2026-10-02T00:00:00Z"),
      session("b", "ws-beta", "2026-10-01T00:00:00Z"),
      session("c", "ws-beta", "2026-10-03T00:00:00Z"),
      session("d", "ws-gone", "2026-10-04T00:00:00Z", "2026-10-05T00:00:00Z"),
    ];
    expect(taskWorkspaceNames(area, sessions, exampleWorkspaces)).toEqual(["beta", "alpha"]);
    expect(taskWhere(area, sessions, exampleWorkspaces)).toBe("跨工作区（beta、alpha）");
  });
});
