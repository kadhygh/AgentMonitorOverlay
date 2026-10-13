import { describe, expect, it } from "vitest";
import { FILE_MARK_MIME, parseFileMarkDrag, type FileMark, type Workspace } from "@amo-studio/protocol";
import { filterGroups, groupMarks, markDragData, marksHash, matchMark, parseMarksHash, parseRange, pastedPaths, rangeText, relativeTo } from "./logic.js";

const ws = (id: string, name: string, path: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name, path, createdAt: "", ...extra });
const mark = (id: string, path: string, workspaceId: string | null, note = "", extra: Partial<FileMark> = {}): FileMark => ({
  id,
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
});

describe("grouping and search", () => {
  const workspaces = [ws("common", "公共", "C:\\common", { builtin: "common" }), ws("a", "alpha", "C:\\alpha"), ws("b", "beta", "C:\\beta"), ws("c", "gamma", "C:\\gamma")];
  const marks = [
    mark("m1", "C:\\alpha\\drop.lua", "a", "掉落表"),
    mark("m2", "C:\\beta\\boss.md", "b", "Boss 数值"),
    mark("m3", "D:\\notes\\todo.txt", null, "随手记"),
    mark("m4", "C:\\gone\\x.ts", "ws-removed"),
  ];

  it("puts the current project first (even without marks), skips empty ones and ends with 其他", () => {
    expect(groupMarks(marks, workspaces, "c").map((g) => [g.name, g.marks.map((m) => m.id)])).toEqual([
      ["gamma", []],
      ["alpha", ["m1"]],
      ["beta", ["m2"]],
      ["其他", ["m3", "m4"]],
    ]);
    expect(groupMarks(marks, workspaces, "b").map((g) => g.workspaceId)).toEqual(["b", "a", null]);
    expect(groupMarks([], workspaces, null)).toEqual([]);
  });

  it("matches every word against the path and the note", () => {
    expect(matchMark(marks[0]!, "drop")).toBe(true);
    expect(matchMark(marks[0]!, "掉落 ALPHA")).toBe(true);
    expect(matchMark(marks[0]!, "掉落 beta")).toBe(false);
    expect(matchMark(marks[1]!, "boss 数值")).toBe(true);
    expect(filterGroups(groupMarks(marks, workspaces, "c"), "随手").map((g) => g.name)).toEqual(["其他"]);
    // No query: everything, the empty current project included.
    expect(filterGroups(groupMarks(marks, workspaces, "c"), " ")).toHaveLength(4);
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
