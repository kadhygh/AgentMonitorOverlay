import { describe, expect, it } from "vitest";
import type { Session, Task } from "@amo-studio/protocol";
import { markParts, searchAll } from "./search.js";

const task = (id: string, title: string, over: Partial<Task> = {}): Task =>
  ({ id, title, workspaceId: "w1", topicId: null, column: "doing", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", archivedAt: null, ...over }) as Task;
const session = (id: string, title: string, over: Partial<Session> = {}): Session =>
  ({ id, title, taskId: "t1", topicId: null, parentId: null, kind: "main", workspaceId: "w1", archivedAt: null, updatedAt: "2026-10-01T00:00:00.000Z", ...over }) as Session;

const state = {
  workspaces: [{ id: "w1", name: "game" }, { id: "w2", name: "tools" }] as never,
  topics: [{ id: "tp", title: "数值平衡", archivedAt: null }] as never,
  tasks: [
    task("t1", "掉落表调整", { topicId: "tp", updatedAt: "2026-10-10T00:00:00.000Z" }),
    task("t2", "旧的掉落表", { archivedAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" }),
    task("t3", "导表工具", { workspaceId: "w2", updatedAt: "2026-10-11T00:00:00.000Z" }),
    task("t4", ""),
  ],
  sessions: [
    session("s1", "检查掉落概率", { updatedAt: "2026-10-13T00:00:00.000Z" }),
    session("s2", "画布协调", { taskId: null, topicId: "tp" }),
    session("s3", "孤儿", { taskId: "gone" }),
  ],
};

describe("搜索", () => {
  it("finds tasks and sessions by name, live first, the whole query in the name before the rest", () => {
    const hits = searchAll(state, "掉落");
    expect(hits.map((h) => `${h.kind}:${h.id}`)).toEqual(["session:s1", "task:t1", "task:t2"]);
    expect(hits.at(-1)).toMatchObject({ archived: true });
    expect(hits[0]).toMatchObject({ owner: "掉落表调整", where: "game · 数值平衡" });
  });

  it("matches every word, also through the project, the topic or the task of a session", () => {
    expect(searchAll(state, "tools").map((h) => h.id)).toEqual(["t3"]);
    expect(searchAll(state, "数值 概率").map((h) => h.id)).toEqual(["s1"]);
    expect(searchAll(state, "画布")[0]).toMatchObject({ kind: "session", taskId: null, topicId: "tp", owner: "数值平衡" });
    expect(searchAll(state, "未命名").map((h) => h.id)).toEqual(["t4"]);
    expect(searchAll(state, "孤儿")).toEqual([]);
    expect(searchAll(state, "没有这个")).toEqual([]);
  });

  it("finds a session or task by its id, whole or its start from 6 characters, first (问题页 shows it, 2026-10-31)", () => {
    const ids = {
      ...state,
      tasks: [...state.tasks, task("task-a36fbfe6-f964", "10-31维护", { archivedAt: "2026-10-20T00:00:00.000Z" })],
      sessions: [...state.sessions, session("s-3173af00-39e8", "开始维护", { taskId: "t1" }), session("s-3a665306-3e14", "#1 远程任务里", { taskId: "t1" })],
    };
    expect(searchAll(ids, "s-3173af00-39e8").map((h) => h.id)).toEqual(["s-3173af00-39e8"]);
    expect(searchAll(ids, " S-3173A ").map((h) => h.id)).toEqual(["s-3173af00-39e8"]);
    // Archived too, when asked by id.
    expect(searchAll(ids, "task-a36f")[0]).toMatchObject({ id: "task-a36fbfe6-f964", archived: true });
    // Too short to be taken as an id: words as before.
    expect(searchAll(ids, "s-3")).toEqual([]);
  });

  it("lists the most recently active live ones for an empty query", () => {
    expect(searchAll(state, "  ").map((h) => h.id)).toEqual(["s1", "t3", "t1", "t4", "s2"]);
  });

  it("marks the words found", () => {
    expect(markParts("Boss 掉落表 boss", ["boss"])).toEqual([
      { text: "Boss", hit: true },
      { text: " 掉落表 ", hit: false },
      { text: "boss", hit: true },
    ]);
    expect(markParts("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });
});
