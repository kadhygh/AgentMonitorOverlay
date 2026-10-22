import { describe, expect, it } from "vitest";
import { FILE_MARK_MIME, parseFileMarkDrag, type Bookmark, type ChatMark, type FileMark, type Topic } from "@amo-studio/protocol";
import { chatDragText, filterGroups, findMark, groupBookmarks, markDragData, marksHash, matchMark, parseMarksHash, parseRange, pastedPaths, rangeText, relativeTo, scopedGroups, scopeKey, scopesFor } from "./logic.js";

const mark = (id: string, path: string, workspaceId: string | null, note = "", extra: Partial<FileMark> = {}): FileMark => ({
  kind: "file",
  id,
  topicId: null,
  path,
  workspaceId,
  startLine: null,
  endLine: null,
  note,
  order: 0,
  createdAt: "",
  updatedAt: "",
  exists: true,
  folder: false,
  ...extra,
});

describe("the marks window's address", () => {
  it("round-trips the project", () => {
    expect(marksHash({ workspaceId: "ws-1" })).toBe("#marks?workspace=ws-1");
    expect(marksHash()).toBe("#marks");
    expect(parseMarksHash("#marks?workspace=ws-1")).toEqual({ workspaceId: "ws-1" });
    expect(parseMarksHash("#marks")).toEqual({});
    expect(parseMarksHash("#review?workspace=ws-1")).toBeNull();
  });

  it("round-trips the topic (none: 未归专题)", () => {
    expect(marksHash({ topicId: "topic-1", workspaceId: "ws-1" })).toBe("#marks?topic=topic-1&workspace=ws-1");
    expect(parseMarksHash("#marks?topic=none")).toEqual({ topicId: "none" });
  });

  it("round-trips the mark to show, and whether to edit its note", () => {
    const t = { workspaceId: "ws-1", markId: "m-1", edit: true, nonce: "7" };
    expect(parseMarksHash(marksHash(t))).toEqual(t);
    expect(parseMarksHash(marksHash({ markId: "m-1" }))).toEqual({ markId: "m-1" });
    expect(marksHash({ edit: true })).toBe("#marks");
  });

  it("round-trips the task it was opened from", () => {
    const t = { topicId: "none", workspaceId: "ws-1", taskId: "task-1" };
    expect(marksHash(t)).toBe("#marks?topic=none&workspace=ws-1&task=task-1");
    expect(parseMarksHash(marksHash(t))).toEqual(t);
  });
});

describe("findMark", () => {
  const marks = [
    mark("whole", "G:\\game\\src\\Drop.cs", "w1"),
    mark("ranged", "G:\\game\\src\\Drop.cs", "w1", "", { startLine: 40, endLine: 60 }),
    mark("other", "G:\\other\\src\\Drop.cs", "w2"),
  ];
  it("matches absolute paths whatever the slashes and case", () => {
    expect(findMark(marks, { path: "g:/GAME/src/drop.cs" })?.id).toBe("whole");
    expect(findMark(marks, { path: "G:\\game\\src\\Nope.cs" })).toBeNull();
  });
  it("matches a project-relative path inside that project only", () => {
    expect(findMark(marks, { path: "src/Drop.cs", workspaceId: "w2" })?.id).toBe("other");
    expect(findMark(marks, { path: "./src/Drop.cs", workspaceId: "w1" })?.id).toBe("whole");
    expect(findMark(marks, { path: "rc/Drop.cs", workspaceId: "w1" })).toBeNull();
  });
  it("prefers the mark at the line", () => {
    expect(findMark(marks, { path: "G:/game/src/Drop.cs" }, 40)?.id).toBe("ranged");
    expect(findMark(marks, { path: "G:/game/src/Drop.cs" }, 3)?.id).toBe("whole");
  });
});

describe("grouping by topic and search", () => {
  const topic = (id: string, title: string, extra: Partial<Topic> = {}): Topic => ({ id, title, workspaceIds: [], createdAt: "", updatedAt: "", archivedAt: null, ...extra });
  const topics = [topic("t1", "掉落"), topic("t2", "战斗"), topic("t3", "UI")];
  const passage: ChatMark = {
    kind: "chat", id: "c1", topicId: "t2", sessionId: "s1", itemId: "i1", start: 0, end: 4, quote: "先改掉落表", prefix: "", suffix: "",
    note: "关键一步", order: 0, createdAt: "", updatedAt: "", taskId: "k1", workspaceId: "a", sessionTitle: "调数值", exists: true,
  };
  const marks: Bookmark[] = [
    mark("m1", "C:\\alpha\\drop.lua", "a", "掉落表", { topicId: "t1" }),
    mark("m2", "C:\\beta\\boss.md", "b", "Boss 数值", { topicId: "t2" }),
    passage,
    mark("m3", "D:\\notes\\todo.txt", null, "随手记"),
    mark("m4", "C:\\gone\\x.ts", "a", "", { topicId: "t-removed" }),
  ];

  it("puts the current topic first (even without bookmarks), skips empty ones and ends with 未归专题", () => {
    expect(groupBookmarks(marks, topics, "t3").map((g) => [g.name, g.marks.map((m) => m.id)])).toEqual([
      ["UI", []],
      ["掉落", ["m1"]],
      ["战斗", ["m2", "c1"]],
      ["未归专题", ["m3", "m4"]],
    ]);
    expect(groupBookmarks(marks, topics, "t2").map((g) => g.topicId)).toEqual(["t2", "t1", null]);
    expect(groupBookmarks(marks, topics, "none").map((g) => g.topicId)).toEqual([null, "t1", "t2"]);
    expect(groupBookmarks([], topics, "none")).toEqual([{ topicId: null, name: "未归专题", archived: false, marks: [] }]);
    expect(groupBookmarks([], topics)).toEqual([]);
  });

  it("显示范围: the topic in front alone, the project in front by topic, or everything (2026-10-22)", () => {
    const names = (gs: ReturnType<typeof scopedGroups>) => gs.map((g) => [g.name, g.marks.map((m) => m.id)]);
    const fromTask = { topicId: "t2", workspaceId: "a", taskId: "k1" };
    expect(names(scopedGroups(marks, topics, fromTask, "t2", "topic"))).toEqual([["战斗", ["m2", "c1"]]]);
    // In project a: m1 (掉落), the passage (战斗, first as the topic in front) and m4 (its topic is gone: 未归专题).
    expect(names(scopedGroups(marks, topics, fromTask, "t2", "project"))).toEqual([
      ["战斗", ["c1"]],
      ["掉落", ["m1"]],
      ["未归专题", ["m4"]],
    ]);
    expect(scopedGroups(marks, topics, fromTask, "t2", "all")).toEqual(groupBookmarks(marks, topics, "t2"));
    // A task in no topic: 当前专题 is 未归专题, shown even when empty.
    expect(names(scopedGroups(marks, topics, { topicId: "none" }, null, "topic"))).toEqual([["未归专题", ["m3", "m4"]]]);
    expect(names(scopedGroups([], topics, { topicId: "none" }, null, "topic"))).toEqual([["未归专题", []]]);
  });

  it("offers 当前专题 and 当前项目 only with a topic or project in front, and remembers per task first", () => {
    expect(scopesFor({})).toEqual({ topic: false, project: false, all: true });
    expect(scopesFor({ topicId: "none", workspaceId: "a" })).toEqual({ topic: true, project: true, all: true });
    expect(scopeKey({ topicId: "t1", workspaceId: "a", taskId: "k1" })).toBe("task:k1");
    expect(scopeKey({ topicId: "t1" })).toBe("topic:t1");
    expect(scopeKey({ workspaceId: "a" })).toBe("workspace:a");
    expect(scopeKey({})).toBe("all");
  });

  it("matches every word against a file's path and note, or a passage's text, session and note", () => {
    expect(matchMark(marks[0]!, "drop")).toBe(true);
    expect(matchMark(marks[0]!, "掉落 ALPHA")).toBe(true);
    expect(matchMark(marks[0]!, "掉落 beta")).toBe(false);
    expect(matchMark(passage, "掉落表 调数值 关键")).toBe(true);
    expect(matchMark(passage, "drop")).toBe(false);
    expect(filterGroups(groupBookmarks(marks, topics, "t3"), "随手").map((g) => g.name)).toEqual(["未归专题"]);
    // No query: everything, the empty current topic included.
    expect(filterGroups(groupBookmarks(marks, topics, "t3"), " ")).toHaveLength(4);
  });

  it("drags a passage out as a quote with where it came from and the note", () => {
    expect(chatDragText({ ...passage, quote: "一\n二" }, "调数值")).toBe("> 一\n> 二\n\n（调数值）\n关键一步\n");
    expect(chatDragText({ ...passage, note: "" }, "x")).toBe("> 先改掉落表\n\n（x）\n");
  });

  it("shows paths relative to the project folder", () => {
    expect(relativeTo("C:\\alpha\\src\\drop.lua", "C:\\alpha")).toBe("src\\drop.lua");
    expect(relativeTo("C:\\Alpha\\drop.lua", "c:\\alpha\\")).toBe("drop.lua");
    expect(relativeTo("C:\\alphabet\\drop.lua", "C:\\alpha")).toBe("");
    expect(relativeTo("C:\\alpha\\drop.lua", "")).toBe("");
  });
});

describe("dragging a mark out", () => {
  it("carries the mark as JSON and the path with its lines as text", () => {
    const data = markDragData(mark("m1", "C:\\alpha\\drop.lua", "a", "掉落表", { startLine: 12, endLine: 30 }));
    expect(data["text/plain"]).toBe("C:\\alpha\\drop.lua:12-30");
    expect(parseFileMarkDrag(data[FILE_MARK_MIME]!)).toEqual({ id: "m1", path: "C:\\alpha\\drop.lua", note: "掉落表", startLine: 12, endLine: 30 });
    expect(parseFileMarkDrag("not json")).toBeNull();
    expect(parseFileMarkDrag(JSON.stringify({ note: "no path" }))).toBeNull();
  });
});

describe("typed and pasted input", () => {
  it("takes absolute paths from pasted text, quotes removed", () => {
    expect(pastedPaths('"C:\\alpha\\a.ts"\r\nD:/b.md\nrelative\\c.ts\n\\\\server\\share\\d.txt\n')).toEqual(["C:\\alpha\\a.ts", "D:/b.md", "\\\\server\\share\\d.txt"]);
    expect(pastedPaths("随便一句话")).toEqual([]);
  });

  it("reads a line range field", () => {
    expect(parseRange("")).toEqual({ startLine: null, endLine: null });
    expect(parseRange("12")).toEqual({ startLine: 12, endLine: null });
    expect(parseRange("12-30")).toEqual({ startLine: 12, endLine: 30 });
    expect(parseRange(" 12 – 30 ")).toEqual({ startLine: 12, endLine: 30 });
    expect(parseRange("7-7")).toEqual({ startLine: 7, endLine: null });
    expect(parseRange("30-12")).toBeUndefined();
    expect(parseRange("0")).toBeUndefined();
    expect(parseRange("abc")).toBeUndefined();
    expect(rangeText({ startLine: 12, endLine: 30 })).toBe("12-30");
    expect(rangeText({ startLine: null, endLine: null })).toBe("");
  });
});
