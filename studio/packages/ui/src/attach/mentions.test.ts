import { describe, expect, it } from "vitest";
import type { FileMark, Session, Task } from "@amo-studio/protocol";
import { mentionGroups, mentionSpans, nearbySessions, nextSubSessionName, withMentionRefs } from "./mentions.js";

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

describe("@ 标记的文件 (S12-D)", () => {
  const mark = (id: string, path: string, note: string, extra: Partial<FileMark> = {}) =>
    ({ id, path, note, workspaceId: "w1", startLine: null, endLine: null, order: 0, createdAt: "", updatedAt: "", exists: true, folder: false, ...extra }) as FileMark;
  const marks = [
    mark("m1", "C:\\game\\drop.lua", "掉落表\n第二行", { startLine: 12, endLine: 30 }),
    mark("m2", "C:\\game\\docs\\boss.md", ""),
    mark("m3", "C:\\game\\gone.lua", "掉落", { exists: false }),
  ];
  const base = { tasks: [], sessions: [], current: null, files: [] };

  it("lists the project's marks after sessions, with their range and the note's first line", () => {
    const groups = mentionGroups({ ...base, query: "", marks });
    expect(groups.map((g) => g.heading)).toEqual(["书签里的文件", ""]);
    expect(groups[0]!.options).toEqual([
      { kind: "mark", id: "m1", name: "drop.lua:12-30", hint: "掉落表" },
      { kind: "mark", id: "m2", name: "boss.md", hint: "C:\\game\\docs" },
    ]);
  });

  it("matches the query against the path and the note; missing files are left out", () => {
    expect(mentionGroups({ ...base, query: "掉落", marks })[0]!.options.map((o) => o.id)).toEqual(["m1"]);
    expect(mentionGroups({ ...base, query: "BOSS", marks })[0]!.options.map((o) => o.id)).toEqual(["m2"]);
    expect(mentionGroups({ ...base, query: "zzz", marks }).map((g) => g.kind)).toEqual(["find"]);
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

describe("mentionSpans", () => {
  it("cuts out the picked names, longest first, and leaves other @ alone", () => {
    expect(mentionSpans("看 @掉落表 和 @掉落表二 再问 @别人", ["掉落表", "掉落表二"])).toEqual([
      { text: "看 ", mention: false },
      { text: "@掉落表", mention: true },
      { text: " 和 ", mention: false },
      { text: "@掉落表二", mention: true },
      { text: " 再问 @别人", mention: false },
    ]);
    expect(mentionSpans("没有提及", [])).toEqual([{ text: "没有提及", mention: false }]);
  });
});

describe("开子会话… (2026-10-26)", () => {
  const input = { query: "", tasks: [], sessions: [], current: null, files: [] };
  it("is offered before 找文件… only when the session may start sessions", () => {
    expect(mentionGroups({ ...input, subsession: true }).at(-1)!.options.map((o) => o.kind)).toEqual(["subsession", "find"]);
    expect(mentionGroups(input).at(-1)!.options.map((o) => o.kind)).toEqual(["find"]);
  });

  it("tells the model how to start sub-sessions: AMO's session_start with the picked setup", () => {
    const picked = new Map([
      ["子会话1", { kind: "subsession" as const, spec: { model: "Claude/claude-sonnet", modelName: "Sonnet", effort: "high", permission: "write" as const, report: true } }],
      ["子会话2", { kind: "subsession" as const, spec: { model: "DeepSeek", modelName: "DeepSeek", report: false, note: "便宜，\n照计划做" } }],
    ]);
    const out = withMentionRefs("接下来开子会话就用 @子会话1", picked);
    expect(out).toContain("子会话的开法（要开时用 AMO 的 session_start，不要用你自带的子 agent");
    expect(out).toContain('- @子会话1：session_start 带 model: "Claude/claude-sonnet"（Sonnet），effort: "high"，permission: "write"，report: true');
    // Only the ones still in the text.
    expect(out).not.toContain("@子会话2：");
    expect(withMentionRefs("@子会话2 去查", picked)).toContain('- @子会话2：session_start 带 model: "DeepSeek"（DeepSeek），report: false。人对这个模型的说明：便宜， 照计划做');
  });

  it("numbers them by what is free", () => {
    expect(nextSubSessionName("", [])).toBe("子会话1");
    expect(nextSubSessionName("用 @子会话1 和 @子会话3", ["子会话2"])).toBe("子会话4");
  });
});
