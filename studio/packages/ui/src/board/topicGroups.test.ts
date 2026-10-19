import { describe, expect, it } from "vitest";
import type { Task, Topic } from "@amo-studio/protocol";
import { topicGroups } from "./Board.js";

const topic = (id: string, title: string) => ({ id, title }) as Topic;
const task = (id: string, topicId: string | null) => ({ id, topicId }) as Task;

describe("按专题分组", () => {
  it("puts a column's cards under their topics in the order their newest card comes, the ones in none last", () => {
    const topics = [topic("p1", "发布 0.9"), topic("p2", "模型接入")];
    // Cards come newest first.
    const groups = topicGroups([task("a", "p2"), task("b", null), task("c", "p1"), task("d", "p2"), task("e", "gone")], topics);
    expect(groups.map((g) => [g.topic?.title ?? null, g.tasks.map((t) => t.id)])).toEqual([
      ["模型接入", ["a", "d"]],
      ["发布 0.9", ["c"]],
      // A topic that is not (or no longer) known counts as none.
      [null, ["b", "e"]],
    ]);
    expect(topicGroups([], topics)).toEqual([]);
  });
});
