import { describe, expect, it } from "vitest";
import { canvasOutline, emptyCanvas, findCycle, validateCanvas, wouldCycle } from "./canvas.js";
import type { CanvasDoc, Task, Topic } from "./entities.js";
import { exampleSessions, exampleTasks, exampleWorkspaces } from "./examples.js";

const TASKS = new Set(exampleTasks.map((t) => t.id));

function doc(over: Partial<CanvasDoc> = {}): CanvasDoc {
  return {
    ...emptyCanvas(),
    groups: [{ id: "g1", title: "导入", workspaceId: "ws-alpha", rect: { x: 0, y: 0, w: 400, h: 300 } }],
    nodes: [
      { id: "n1", kind: "task", taskId: "task-1", groupId: "g1", pos: { x: 20, y: 40 } },
      { id: "n2", kind: "note", text: "先问策划", groupId: "g1", pos: { x: 20, y: 160 } },
      { id: "n3", kind: "note", text: "零散想法", groupId: null, pos: { x: 600, y: 40 } },
    ],
    edges: [{ id: "e1", kind: "depends", from: "task-2", to: "task-1" }],
    ...over,
  };
}

describe("validateCanvas", () => {
  it("accepts a well-formed canvas", () => {
    expect(validateCanvas(doc(), TASKS)).toEqual([]);
  });

  it("reports missing references, duplicates and bad geometry", () => {
    const errors = validateCanvas(
      doc({
        groups: [{ id: "g1", title: "x", workspaceId: null, rect: { x: 0, y: 0, w: 0, h: 10 } }],
        nodes: [
          { id: "n1", kind: "task", taskId: "nope", groupId: "g-missing", pos: { x: 0, y: 0 } },
          { id: "n1", kind: "note", text: "dup id", groupId: null, pos: { x: Number.NaN, y: 0 } },
        ],
        edges: [{ id: "e1", kind: "depends", from: "task-1", to: "task-1" }],
      }),
      TASKS,
    );
    expect(errors.join("\n")).toMatch(/invalid rect/);
    expect(errors.join("\n")).toMatch(/missing task nope/);
    expect(errors.join("\n")).toMatch(/missing group g-missing/);
    expect(errors.join("\n")).toMatch(/duplicate id n1/);
    expect(errors.join("\n")).toMatch(/invalid position/);
    expect(errors.join("\n")).toMatch(/to itself/);
  });

  it("refuses a task placed twice and dependency cycles", () => {
    const twice = doc({ nodes: [...doc().nodes, { id: "n4", kind: "task", taskId: "task-1", groupId: null, pos: { x: 0, y: 0 } }] });
    expect(validateCanvas(twice, TASKS).join()).toMatch(/placed twice/);
    const cyclic = doc({ edges: [...doc().edges, { id: "e2", kind: "depends", from: "task-1", to: "task-2" }] });
    expect(validateCanvas(cyclic, TASKS).join()).toMatch(/cycle/);
  });
});

describe("reference cards", () => {
  const ref = (id: string, taskId: string, groupId: string | null = null) => ({ id, kind: "ref" as const, taskId, groupId, pos: { x: 0, y: 400 } });

  it("may point at any task of another topic, even one that is gone, but not at this topic's own tasks", () => {
    const own = new Set(["task-1"]);
    expect(validateCanvas(doc({ nodes: [...doc().nodes, ref("r1", "task-2", "g1"), ref("r2", "gone-task")], edges: [] }), own)).toEqual([]);
    expect(validateCanvas(doc({ nodes: [...doc().nodes, ref("r1", "task-1")] }), own).join()).toMatch(/of this topic/);
    expect(validateCanvas(doc({ nodes: [ref("r1", "task-2"), ref("r2", "task-2")] }), own).join()).toMatch(/referenced twice/);
    expect(validateCanvas(doc({ nodes: [ref("r1", "")] }), own).join()).toMatch(/has no task/);
    expect(validateCanvas(doc({ nodes: [ref("r1", "task-2", "g-missing")] }), own).join()).toMatch(/missing group/);
  });

  it("lists references with their own topic and project, and says when the task is gone", () => {
    const topics: Topic[] = [{ id: "tp-b", title: "配置", workspaceIds: [], createdAt: "", updatedAt: "", archivedAt: null }];
    const all: Task[] = [
      exampleTasks[0]!,
      { ...exampleTasks[1]!, topicId: "tp-b" },
      { ...exampleTasks[1]!, id: "task-old", title: "旧任务", archivedAt: "2026-10-01T00:00:00.000Z" },
    ];
    const canvas = doc({ nodes: [...doc().nodes, ref("r1", "task-2", "g1"), ref("r2", "task-old"), ref("r3", "nope")], edges: [] });
    const { outline, json } = canvasOutline(canvas, [exampleTasks[0]!], exampleWorkspaces, exampleSessions, { tasks: all, topics });
    expect(json.groups[0]!.refs).toEqual([{ taskId: "task-2", title: "Align config keys", topic: "配置", workspace: "beta", column: "todo", status: null, gone: null }]);
    expect(json.ungrouped.refs.map((r) => [r.taskId, r.title, r.gone])).toEqual([
      ["task-old", "任务已归档", "archived"],
      ["nope", "任务不存在", "missing"],
    ]);
    // A reference is not one of the topic's tasks: not "unplaced", not in the group's tasks.
    expect(json.unplaced).toEqual([]);
    expect(json.groups[0]!.tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(outline).toContain("  - 引用：Align config keys（专题 配置 / 项目 beta · todo）");
    expect(outline).toContain("  - 引用：任务已归档（task-old）");
  });
});

describe("findCycle / wouldCycle", () => {
  it("finds the cycle path", () => {
    expect(findCycle([{ from: "a", to: "b" }, { from: "b", to: "c" }])).toBeNull();
    expect(findCycle([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }])).toEqual(["a", "b", "c", "a"]);
  });

  it("tells the UI whether a new dependency is allowed", () => {
    const edges = [{ from: "a", to: "b" }];
    expect(wouldCycle(edges, "b", "c")).toBe(false);
    expect(wouldCycle(edges, "b", "a")).toBe(true);
    expect(wouldCycle(edges, "a", "a")).toBe(true);
  });
});

describe("canvasOutline", () => {
  it("describes structure without coordinates", () => {
    const { outline, json } = canvasOutline(doc(), exampleTasks, exampleWorkspaces, exampleSessions);
    expect(json.groups).toEqual([
      {
        id: "g1",
        title: "导入",
        workspace: "alpha",
        tasks: [{ id: "task-1", title: "Add retry to the importer", column: "doing", status: "awaiting-approval", workspace: "alpha", dependsOn: ["task-2"] }],
        refs: [],
        notes: ["先问策划"],
      },
    ]);
    expect(json.ungrouped).toEqual({ tasks: [], refs: [], notes: ["零散想法"] });
    expect(json.unplaced.map((t) => [t.id, t.workspace])).toEqual([["task-2", "beta"]]);
    expect(json.dependencies).toEqual([{ from: "task-2", to: "task-1" }]);
    expect(outline).toContain("分组「导入」（工作区 alpha）");
    expect(outline).toContain("Add retry to the importer（doing · awaiting-approval · alpha）；依赖：Align config keys");
    expect(outline).toContain("便签：先问策划");
    expect(outline).toContain("还没放到画布上的任务");
    expect(JSON.stringify(json)).not.toMatch(/"x"|"pos"|"rect"/);
  });
});
