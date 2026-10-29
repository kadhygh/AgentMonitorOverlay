import { describe, expect, it } from "vitest";
import type { Task } from "@amo-studio/protocol";
import { filterChoices, rankChoices, recentIds, rowChoices, topicProject, type Choice } from "./choices.js";
import { draftText } from "./draft.js";

const task = (id: string, workspaceId: string, topicId: string | null, updatedAt: string, archivedAt: string | null = null) => ({ id, workspaceId, topicId, updatedAt, archivedAt }) as unknown as Task;
const item = (id: string) => ({ id, name: id.toUpperCase(), hint: `G:\\${id}` });

describe("新任务页的专题和项目两行 (2026-10-29)", () => {
  it("recent ones come from the live tasks' last change, newest first, each once", () => {
    const tasks = [task("t1", "a", "p1", "2026-10-01"), task("t2", "b", null, "2026-10-03"), task("t3", "a", "p2", "2026-10-02"), task("t4", "c", "p3", "2026-10-09", "x")];
    expect(recentIds(tasks, (t) => t.workspaceId)).toEqual(["b", "a"]);
    expect(recentIds(tasks, (t) => t.topicId)).toEqual(["p2", "p1"]);
    expect(recentIds(tasks, (t) => t.workspaceId, 1)).toEqual(["b"]);
  });

  it("ranks the topic's projects first, then pinned, recent, the rest; each once, in its first group", () => {
    const ranked = rankChoices(["a", "b", "c", "d", "e"].map(item), (x) => x, { topic: ["d", "zz"], pinned: ["b", "d"], recent: ["e", "b"] });
    expect(ranked.map((c) => `${c.id}:${c.group}`)).toEqual(["d:topic", "b:pinned", "e:recent", "a:all", "c:all"]);
  });

  it("a row shows six, always the picked one, and counts the rest for 「更多…」", () => {
    const ranked: Choice[] = "abcdefghij".split("").map((id) => ({ ...item(id), group: "all" }));
    expect(rowChoices(ranked, null)).toMatchObject({ more: 4 });
    expect(rowChoices(ranked, null).shown.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    const picked = rowChoices(ranked, "i");
    expect(picked.shown.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e", "i"]);
    expect(picked.more).toBe(4);
    expect(rowChoices(ranked.slice(0, 3), "b")).toMatchObject({ more: 0 });
  });

  it("the picker filters by name, or by folder for a word with a slash; every word", () => {
    const ranked: Choice[] = [
      { id: "1", name: "BattleConfig", hint: "G:\\PROJECT\\BattleConfig", group: "topic" },
      { id: "2", name: "battle-sim", hint: "G:\\PROJECT\\tools\\battle-sim", group: "all" },
      { id: "3", name: "LubanTools", hint: "G:\\PROJECT\\LubanTools", group: "all" },
    ];
    expect(filterChoices(ranked, "batt").map((c) => c.id)).toEqual(["1", "2"]);
    expect(filterChoices(ranked, "project").map((c) => c.id)).toEqual([]);
    expect(filterChoices(ranked, "tools/ batt").map((c) => c.id)).toEqual(["2"]);
    expect(filterChoices(ranked, "tools").map((c) => c.id)).toEqual(["3"]);
    expect(filterChoices(ranked, "  ").length).toBe(3);
  });

  it("a topic picks its project only when it has exactly one", () => {
    expect(topicProject(["a"])).toBe("a");
    expect(topicProject([])).toBeNull();
    expect(topicProject(["a", "b"])).toBeNull();
  });

  it("the first message says what its @ names point at", () => {
    expect(draftText({ text: "  只是一句话 " })).toBe("只是一句话");
    const text = draftText({ text: "按 @冰冻炮复核 的结论改 @BattleConfig", refs: { 冰冻炮复核: { kind: "task", id: "t1" }, BattleConfig: { kind: "project", id: "w1", path: "G:\\BattleConfig" }, 删掉了: { kind: "task", id: "t9" } } });
    expect(text).toContain("提到的项目：\n- @BattleConfig：AMO 项目 w1，文件夹 G:\\BattleConfig");
    expect(text).toContain("提到的任务：\n- @冰冻炮复核：AMO 任务 t1");
    expect(text).not.toContain("t9");
  });
});
