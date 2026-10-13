import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// S11-A canvas management: empty groups go away, the way back to the canvas, show-on-canvas per task, reference cards.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("canvas: the last empty group can be deleted, also after its topic's only card was archived", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "空画布" });
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  const groups = page.getByTestId("canvas-group");

  // An empty canvas: a new group, then its ×.
  await page.getByRole("button", { name: "+ 分组" }).click();
  await expect(groups).toHaveCount(1);
  await expect.poll(async () => (await canvas()).groups.length).toBe(1);
  await page.getByTestId("group-remove").click();
  await expect(groups).toHaveCount(0);
  await expect.poll(async () => (await canvas()).groups.length).toBe(0);

  // The same with the Delete key.
  await page.getByRole("button", { name: "+ 分组" }).click();
  await expect.poll(async () => (await canvas()).groups.length).toBe(1);
  await page.getByTestId("canvas-viewport").focus();
  await page.keyboard.press("Delete");
  await expect(groups).toHaveCount(0);
  await expect.poll(async () => (await canvas()).groups.length).toBe(0);

  // A canvas that only looks empty: its one card belongs to a task that was archived since.
  const { task } = await studio.api<{ task: Task; session: Session | null }>("POST", "/api/tasks", { title: "已归档的任务", workspaceId: ws.id, topicId: topic.id });
  await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
  await page.getByRole("button", { name: "+ 分组" }).click();
  await expect.poll(async () => (await canvas()).groups.length).toBe(1);
  await studio.api("POST", `/api/tasks/${task.id}/archive`);
  await expect(page.getByTestId("canvas-card")).toHaveCount(0);
  await page.getByTestId("group-remove").click();
  await expect(groups).toHaveCount(0);
  await expect.poll(async () => (await canvas()).groups.length).toBe(0);
  // The archived task's card is kept, so restoring the task brings it back.
  await studio.api("POST", `/api/tasks/${task.id}/unarchive`);
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
});

test("canvas: the new-task page and the new task's page return to the canvas they came from", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<Topic>("POST", "/api/topics", { title: "回到画布" });

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "+ 在专题里新建任务" }).click();
  await expect(page.getByText("要推进什么？")).toBeVisible();
  await page.getByRole("button", { name: "← 画布" }).click();
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();

  // Created from the canvas: the task page opens, and its "←" goes back to the canvas too.
  await page.getByRole("button", { name: "+ 在专题里新建任务" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  await page.getByLabel("第一句话").fill("从画布建的任务");
  await page.getByRole("button", { name: "开始" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("从画布建的任务");
  await screenshot(studio.app, "stage-11", "S11-A-back-to-canvas", page);
  await page.getByRole("button", { name: "← 画布" }).click();
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();

  // Opened from the board, both pages still go back to the board.
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("button", { name: "← 看板" }).click();
  await page.getByTestId("task-card").filter({ hasText: "从画布建的任务" }).click();
  await page.getByRole("button", { name: "← 看板" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(1);
});

test("canvas: tasks from the canvas are always on it, others only when asked; the task page toggles it", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "显示" });
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const cards = page.getByTestId("canvas-card");

  // From the board, with the topic picked: "显示在画布上" is offered, off by default.
  await page.getByTestId("scope-topic-显示").click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByTestId("draft-on-canvas")).not.toBeChecked();
  await page.getByLabel("第一句话").fill("看板上建的任务");
  await page.getByRole("button", { name: "放进待办" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(1);
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();
  await expect(cards).toHaveCount(0);
  // The agent view still lists it, as not placed yet.
  await page.getByRole("tab", { name: "agent 视角" }).click();
  await expect(page.getByTestId("agent-view")).toContainText("还没放到画布上的任务");
  await expect(page.getByTestId("agent-view")).toContainText("看板上建的任务");

  // From the canvas: always on it (the box is ticked and fixed); filing it returns to the canvas.
  await page.getByRole("button", { name: "+ 在专题里新建任务" }).click();
  await expect(page.getByTestId("draft-on-canvas")).toBeChecked();
  await expect(page.getByTestId("draft-on-canvas")).toBeDisabled();
  await page.getByLabel("第一句话").fill("画布上建的任务");
  await page.getByRole("button", { name: "放进待办" }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("画布上建的任务");

  // The task page puts the other one on the canvas, and takes it off again.
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: "看板上建的任务" }).click();
  const toggle = page.getByTestId("task-on-canvas");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(async () => (await canvas()).nodes.length).toBe(2);
  await screenshot(studio.app, "stage-11", "S11-A-task-on-canvas", page);
  await toggle.uncheck();
  await expect.poll(async () => (await canvas()).nodes.length).toBe(1);
  await toggle.check();
  await expect.poll(async () => (await canvas()).nodes.length).toBe(2);

  // On the canvas, the sidebar takes a card off; the task stays in the topic.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(cards).toHaveCount(2);
  await cards.filter({ hasText: "看板上建的任务" }).click();
  await page.getByRole("button", { name: "从画布上拿掉（任务不变）" }).click();
  await expect(cards).toHaveCount(1);
  await expect.poll(async () => (await canvas()).nodes.length).toBe(1);
  const state = await studio.api<{ tasks: Task[] }>("GET", "/api/state");
  expect(state.tasks.find((t) => t.title === "看板上建的任务")?.topicId).toBe(topic.id);
});
