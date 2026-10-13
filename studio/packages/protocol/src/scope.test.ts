import { describe, expect, it } from "vitest";
import type { Task, Topic, Workspace } from "./entities.js";
import { exampleWorkspaces } from "./examples.js";
import { projectWorkspaces, taskProject, taskWhere, topicWorkspaceIds } from "./scope.js";

const common: Workspace = { id: "ws-common", name: "公共", path: "C:/data/common", builtin: "common", createdAt: "2026-10-01T00:00:00Z" };
const workspaces = [...exampleWorkspaces, common];
const task = (id: string, workspaceId: string, topicId: string | null = null, archivedAt: string | null = null): Task => ({
  id, title: id, workspaceId, topicId, column: "doing", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt,
});

describe("where a task runs", () => {
  it("names the project, and hides the common space", () => {
    expect(taskWhere(task("a", "ws-alpha"), workspaces)).toBe("alpha");
    expect(taskWhere(task("b", "ws-common"), workspaces)).toBe("未指定项目");
    expect(taskProject(task("b", "ws-common"), workspaces)).toBeNull();
    expect(taskProject(task("a", "ws-beta"), workspaces)?.name).toBe("beta");
    expect(projectWorkspaces(workspaces).map((w) => w.id)).toEqual(["ws-alpha", "ws-beta"]);
  });

  it("collects a topic's projects from its hand-added ones and its live tasks", () => {
    const topic: Topic = { id: "tp-1", title: "掉落表重构", workspaceIds: ["ws-beta"], createdAt: "", updatedAt: "", archivedAt: null };
    const tasks = [task("a", "ws-alpha", "tp-1"), task("b", "ws-common", "tp-1"), task("c", "ws-beta", "tp-1"), task("d", "ws-alpha", "tp-2"), task("e", "ws-gone", "tp-1"), task("f", "ws-alpha", "tp-1", "2026-10-02T00:00:00Z")];
    expect(topicWorkspaceIds(topic, tasks, workspaces)).toEqual(["ws-beta", "ws-alpha"]);
  });
});
