import { describe, expect, it } from "vitest";
import type { Session, Task } from "@amo-studio/protocol";
import { mentionGroups, nearbySessions, withMentionRefs } from "./mentions.js";

const task = (id: string, title: string, extra: Partial<Task> = {}) => ({ id, title, column: "doing", archivedAt: null, workspaceId: "w1", topicId: null, ...extra }) as unknown as Task;
const session = (id: string, title: string, extra: Partial<Session> = {}) =>
  ({ id, title, taskId: "t1", topicId: null, workspaceId: "w1", kind: "main", archivedAt: null, updatedAt: "2026-10-13T10:00:00Z", ...extra }) as unknown as Session;

describe("@ suggestions", () => {
  const current = session("s0", "这里");
  const sessions = [
    current,
    session("s1", "摸底", { updatedAt: "2026-10-13T09:00:00Z" }),
    session("s2", "改导入器", { updatedAt: "2026-10-13T11:00:00Z" }),
    session("s3", "别的项目", { workspaceId: "w2" }),
    session("s4", "同专题", { workspaceId: "w2", topicId: "p1", taskId: null }),
    session("s5", "子 agent", { kind: "sub" }),
    session("s6", "归档的", { archivedAt: "2026-10-01T00:00:00Z" }),
  ];

  it("offers sessions of the same project (and topic), newest first, not this one, subagents or archived ones", () => {
    expect(nearbySessions(sessions, current).map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(nearbySessions(sessions, { ...current, topicId: "p1" }).map((s) => s.id)).toEqual(["s2", "s4", "s1"]);
  });

  it("groups tasks, sessions and files, and always ends with 找文件…", () => {
    const groups = mentionGroups({
      query: "",
      tasks: [task("t1", "掉落表"), task("t2", "旧的", { archivedAt: "x" } as Partial<Task>)],
      sessions,
      current,
      files: [{ path: "src/app/main.ts", size: 1, modifiedAt: null, change: "M" }],
    });
    expect(groups.map((g) => g.heading)).toEqual(["任务", "会话", "最近改动的文件", ""]);
    expect(groups[0]!.options.map((o) => o.name)).toEqual(["掉落表"]);
    expect(groups[2]!.options[0]).toMatchObject({ kind: "file", id: "src/app/main.ts", name: "main.ts", hint: "src/app" });
    expect(groups.at(-1)!.options[0]).toMatchObject({ kind: "find", name: "找文件…" });
  });

  it("filters by the query and drops empty groups; pinned tasks first", () => {
    const groups = mentionGroups({ query: "导入", tasks: [task("t1", "掉落表"), task("t3", "导入 B"), task("t4", "导入 A", { topicId: "pin" })], pinnedTask: (t) => t.topicId === "pin", sessions, current, files: [] });
    expect(groups.map((g) => g.kind)).toEqual(["task", "session", "find"]);
    expect(groups[0]!.options.map((o) => o.name)).toEqual(["导入 A", "导入 B"]);
    expect(groups[1]!.options.map((o) => o.id)).toEqual(["s2"]);
  });
});

describe("the message as sent", () => {
  it("says which tasks and sessions the @ names are, only for names still in the text", () => {
    const picked = new Map([
      ["掉落表", { kind: "task" as const, id: "t1" }],
      ["摸底", { kind: "session" as const, id: "s1", taskId: "t1" }],
      ["删掉了", { kind: "task" as const, id: "t9" }],
    ]);
    expect(withMentionRefs("看 @掉落表 和 @摸底", picked)).toBe(
      "看 @掉落表 和 @摸底\n\n提到的任务：\n- @掉落表：AMO 任务 t1（可以用 AMO 的 task_get 查看）\n\n提到的会话：\n- @摸底：AMO 会话 s1，属于任务 t1（可以用 AMO 的 session_tree 查看）",
    );
    expect(withMentionRefs("没有提到", picked)).toBe("没有提到");
  });
});
