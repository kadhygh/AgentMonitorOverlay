import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, StateSnapshot, Task, TaskPlan, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 16 (the stage 15 design, second part): a 主控 proposes splitting the work into tasks (MCP
// task_plan_propose); the person sees it on the topic's canvas, changes it, and accepts it — the tasks are made, put
// on the canvas in a group per project with their dependencies — or dismisses it.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a 主控's proposal on the canvas: changed, accepted into 待办, on the canvas by project with dependencies (stage 16)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "迁移" });
  const proposal = {
    summary: "把装甲车和弹射闪电迁过来",
    tasks: [
      { key: "a", title: "装甲车数据", project: "alpha", description: "先迁数据表", firstMessage: "迁装甲车的数据表" },
      { key: "b", title: "装甲车界面", project: "beta", dependsOn: ["a"] },
      { key: "c", title: "弹射闪电", project: "alpha" },
    ],
  };
  const { task: lead } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "迁移主控",
    workspaceId: alpha.id,
    topicId: topic.id,
    lead: true,
    firstSession: { profileId: "claude-mock", text: `[[mcp: task_plan_propose ${JSON.stringify(proposal)}]]` },
  });
  await expect.poll(async () => (await studio!.api<TaskPlan[]>("GET", "/api/task-plans")).length, { timeout: 60_000 }).toBe(1);

  // Focus counts it as something waiting for the person.
  const opened = studio.app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-plan")).toContainText("拆任务提案 · 3 个任务", { timeout: 30_000 });

  // The topic's canvas says so.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const banner = page.getByTestId("plan-banner");
  await expect(banner).toContainText("主控「迁移主控」提了 3 个任务：把装甲车和弹射闪电迁过来");
  await banner.getByTestId("plan-open").click();
  const dialog = page.getByTestId("plan-dialog");
  const rows = dialog.getByTestId("plan-task");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("依赖：装甲车数据");
  await rows.nth(0).getByLabel("任务名").fill("装甲车数据表");
  await rows.nth(2).getByRole("checkbox").uncheck();
  await expect(dialog).toContainText("建 2 个任务");
  await screenshot(studio.app, "stage-16", "S16-D-plan", page);
  await dialog.getByTestId("plan-accept-todo").click();
  await expect(dialog).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect(focus.getByTestId("focus-plan")).toHaveCount(0);

  // Made, described, in 待办, on the canvas in a group per project, the dependency drawn.
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const data = state.tasks.find((t) => t.title === "装甲车数据表")!;
  const ui = state.tasks.find((t) => t.title === "装甲车界面")!;
  expect(data).toMatchObject({ workspaceId: alpha.id, topicId: topic.id, column: "todo", description: "先迁数据表" });
  expect(ui).toMatchObject({ workspaceId: beta.id, column: "todo" });
  expect(state.tasks.some((t) => t.title === "弹射闪电")).toBe(false);
  await expect(page.getByTestId("canvas-card").filter({ hasText: "装甲车数据表" })).toBeVisible();
  await expect(page.getByTestId("canvas-group")).toHaveCount(2);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(1);
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  expect(canvas.edges.map((e) => [e.from, e.to])).toEqual([[data.id, ui.id]]);

  // The 主控 hears back (mail), with the new tasks' ids.
  const plans = await studio.api<TaskPlan[]>("GET", "/api/task-plans");
  expect(plans[0]).toMatchObject({ state: "accepted", fromTaskId: lead.id, created: [{ key: "a", taskId: data.id }, { key: "b", taskId: ui.id }] });
});
