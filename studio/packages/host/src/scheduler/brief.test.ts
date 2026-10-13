import { describe, expect, it } from "vitest";
import { schedulerBrief } from "./brief.js";

describe("schedulerBrief", () => {
  it("lists open todos, which projects are free, models and presets, with the rules", () => {
    const text = schedulerBrief({
      todos: [
        { id: "td1", text: "统一掉落表格式", done: false, workspaceId: "w1", taskId: null, createdAt: "" },
        { id: "td2", text: "已转的", done: true, workspaceId: "w1", taskId: "t1", createdAt: "" },
        { id: "td3", text: "随便看看", done: false, workspaceId: null, taskId: null, createdAt: "" },
      ],
      workspaces: [{ id: "w1", name: "alpha" }, { id: "w2", name: "beta" }] as never,
      activity: new Map([["w1", { workspaceId: "w1", idle: true, busy: 0 }], ["w2", { workspaceId: "w2", idle: false, busy: 2 }]]),
      profiles: [{ id: "claude-glm", label: "Claude · GLM" }] as never,
      packs: [{ workspaceId: "w1", dirName: "demo", dir: "", errors: [], warnings: [], manifest: { schemaVersion: 1, name: "demo", title: "示例", docs: [], templates: [], tools: [], presets: [{ id: "impl", title: "按约定实现", prompt: "x" }] } }],
      perRound: 3,
    });
    expect(text).toContain("这一轮最多提 3 条");
    expect(text).toContain("- todoId=td1：统一掉落表格式（适合：alpha）");
    expect(text).toContain("- todoId=td3：随便看看（适合：未指定）");
    expect(text).not.toContain("已转的");
    expect(text).toContain("- alpha（id=w1）：空闲");
    expect(text).toContain("- beta（id=w2）：忙碌，2 个会话在进行");
    expect(text).toContain("- profileId=claude-glm：Claude · GLM");
    expect(text).toContain("- alpha / 示例 / 按约定实现");
  });
});
