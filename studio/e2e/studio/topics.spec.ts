import { expect, test } from "@playwright/test";
import type { StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Structure v2 (design/structure.md): a topic gathers tasks from several projects on its own canvas; a task moves
// between topics or out of them.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a topic gathers tasks from two projects on its own canvas, and a task can leave it", async () => {
  studio = await launchStudio();
  const { page } = studio;
  for (const name of ["alpha", "beta"]) await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace(name) });

  // Make the topic in the left column; it becomes the scope.
  await page.getByTestId("new-topic").click();
  await page.getByLabel("专题名称").fill("掉落表重构");
  await page.getByRole("button", { name: "建立" }).click();
  await expect(page.locator(".brand")).toContainText("掉落表重构");

  // Two tasks from the new-task page: one started in alpha, one filed in beta. The topic is preselected.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByRole("group", { name: "专题" }).getByRole("button", { name: "掉落表重构" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  await page.getByTestId("draft-on-canvas").check(); // off by default outside the canvas (S11-A)
  await page.getByLabel("第一句话").fill("掉落表概率校验");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 掉落表概率校验", { timeout: 30_000 });
  await expect(page.locator(".page-head")).toContainText("alpha");
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "beta" }).click();
  await page.getByTestId("draft-on-canvas").check();
  await page.getByLabel("第一句话").fill("Elite 表补测试");
  await page.getByRole("button", { name: "放进待办" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(2);

  // The topic's canvas holds both, each naming its project; the agent view says the same.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const cards = page.getByTestId("canvas-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "掉落表概率校验" })).toContainText("alpha");
  await expect(cards.filter({ hasText: "Elite 表补测试" })).toContainText("beta");
  await page.getByRole("tab", { name: "agent 视角" }).click();
  await expect(page.getByTestId("agent-view")).toContainText("Elite 表补测试");
  await screenshot(studio.app, "stage-10", "S10-topic-canvas", page);

  // The canvas has its own way into the draft page, with the topic picked.
  await page.getByRole("button", { name: "+ 在专题里新建任务" }).click();
  await expect(page.getByRole("group", { name: "专题" }).getByRole("button", { name: "掉落表重构" })).toHaveAttribute("aria-pressed", "true");

  // Transfer: the filed task leaves the topic from its task page, and leaves the canvas with it.
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: "Elite 表补测试" }).click();
  await page.getByTestId("task-topic").click();
  await page.getByTestId("topic-picker").getByTestId("topic-option").filter({ hasText: "不放进专题" }).click();
  await expect(page.getByTestId("task-topic")).toHaveText("—");
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks.find((t) => t.title === "Elite 表补测试")?.topicId).toBeNull();
});
