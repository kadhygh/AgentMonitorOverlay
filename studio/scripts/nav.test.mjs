// The navigation index (docs/nav/, scripts/nav.mjs) only helps while it points at real code. 2026-11-06, the user:
// an anchor that went stale is fixed or deleted right away (plans/doc-architecture.md) — each failure below says which
// topic, which anchor, and what to do.
import { describe, expect, it } from "vitest";
import { anchorProblems, loadTopics, render, search, shapeProblems } from "./nav.mjs";

const topics = loadTopics();

describe("导航索引 docs/nav/", () => {
  it("每个主题的字段齐全、id 不重复、related 指向现有主题", () => {
    const problems = shapeProblems(topics);
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it("每个锚点的文件在、字面锚点找得到，next 指向的文件在", () => {
    const problems = anchorProblems(topics);
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it("查询：别名直接命中，连着写的中文也能找到，找不到时说去搜代码", () => {
    expect(search(topics, "值守")[0]?.id).toBe("studio.duty");
    expect(search(topics, "被控端额度推送频率")[0]?.id).toBe("flow.remoteUsage");
    expect(render(topics, { query: "完全不存在的东西 qqzz" })).toContain("去搜代码");
    expect(render(topics, { id: "workflow.newRoute" })).toContain("studio/packages/protocol/src/api.ts:");
  });
});
