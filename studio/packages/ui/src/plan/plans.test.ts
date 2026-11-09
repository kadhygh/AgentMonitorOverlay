import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { latestPlan, planVersions, shownPlan } from "./plans.js";

const plan = (id: string, state: "pending" | "answered" | "dismissed" | "cancelled", seq: number) =>
  ({ id, sessionId: "s", seq, createdAt: "", type: "question", source: "plan-review", plan: `# ${id}`, state }) as unknown as SessionItem;
const ask = { id: "q", sessionId: "s", seq: 2, createdAt: "", type: "question", source: "claude-ask", questions: [], state: "pending" } as unknown as SessionItem;

describe("the plan window's versions", () => {
  const items = [plan("v1", "answered", 1), ask, plan("v2", "answered", 3), plan("v3", "pending", 4)];
  it("counts only plan reviews, oldest first", () => {
    expect(planVersions(items).map((v) => v.id)).toEqual(["v1", "v2", "v3"]);
  });
  it("shows the one asked for, else the one waiting, else the last", () => {
    const versions = planVersions(items);
    expect(shownPlan(versions, "v1")?.id).toBe("v1");
    expect(shownPlan(versions, null)?.id).toBe("v3");
    expect(shownPlan(versions, "gone")?.id).toBe("v3");
    expect(latestPlan(planVersions(items.slice(0, 3)))?.id).toBe("v2");
    expect(latestPlan([])).toBeNull();
  });
});
