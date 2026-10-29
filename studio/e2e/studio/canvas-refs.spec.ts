import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

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
  // Since 2026-10-22 the archived task's card stays, greyed and marked 已归档.
  await expect(page.getByTestId("canvas-card")).toHaveClass(/is-archived/);
  await page.getByTestId("group-remove").click();
  await expect(groups).toHaveCount(0);
  await expect.poll(async () => (await canvas()).groups.length).toBe(0);
  // Restoring the task makes it an ordinary card again.
  await studio.api("POST", `/api/tasks/${task.id}/unarchive`);
  await expect(page.getByTestId("canvas-card")).not.toHaveClass(/is-archived/);
});

test("canvas: the new-task page and the new task's page return to the canvas they came from", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<Topic>("POST", "/api/topics", { title: "回到画布" });

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "+ 在专题里新建任务" }).click();
  await expect(page.getByText("要推进什么？")).toBeVisible();
  await page.getByRole("button", { name: "返回画布" }).click();
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();

  // Created from the canvas: the task page opens, and its "←" goes back to the canvas too.
  await page.getByRole("button", { name: "+ 在专题里新建任务" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  await page.getByLabel("第一句话").fill("从画布建的任务");
  await page.getByRole("button", { name: "开始" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("从画布建的任务");
  await expect(page.getByRole("button", { name: "画布", exact: true })).toHaveAttribute("aria-current", "page");
  await screenshot(studio.app, "stage-11", "S11-A-back-to-canvas", page);
  await page.getByRole("button", { name: "返回画布" }).click();
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();

  // Opened from the board, both pages still go back to the board.
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("button", { name: "返回看板" }).click();
  await page.getByTestId("task-card").filter({ hasText: "从画布建的任务" }).click();
  await page.getByRole("button", { name: "返回看板" }).click();
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
  await page.getByTestId("task-more").click();
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

test("canvas: reference cards point at other topics' tasks, show their live status, group, open and go away", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const here = await studio.api<Topic>("POST", "/api/topics", { title: "甲专题" });
  const there = await studio.api<Topic>("POST", "/api/topics", { title: "乙专题" });
  const { task: other } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "乙的任务", workspaceId: ws.id, topicId: there.id, firstSession: { profileId: "codex-mock", text: "慢慢来 [[slow]]" } });
  const { task: loose } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "没专题的任务", workspaceId: ws.id });
  await studio.api("POST", "/api/tasks", { title: "甲的任务", workspaceId: ws.id, topicId: here.id });
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${here.id}/canvas`);
  const refs = page.getByTestId("canvas-ref");

  await page.getByTestId("scope-topic-甲专题").click();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  await page.getByRole("button", { name: "+ 分组" }).click();
  await expect.poll(async () => (await canvas()).groups.length).toBe(1);

  // The picker lists every live task with its topic and project; typing filters.
  await page.getByRole("button", { name: "引用任务" }).click();
  const picker = page.getByRole("dialog", { name: "引用任务" });
  const options = picker.getByTestId("ref-option");
  await expect(options).toHaveCount(3);
  await expect(options.filter({ hasText: "甲的任务" })).toContainText("本专题 · 放上画布");
  await expect(options.filter({ hasText: "乙的任务" })).toContainText("乙专题");
  await screenshot(studio.app, "stage-11", "S11-A-ref-picker", page);
  await picker.getByLabel("搜索任务").fill("乙");
  await expect(options).toHaveCount(1);
  await options.first().click();

  // Dropped in the middle of the view, which is inside the new group.
  await expect(refs).toHaveCount(1);
  await expect(refs).toContainText("引用");
  await expect(refs).toContainText("乙的任务");
  await expect(refs).toContainText("乙专题 / alpha");
  await expect(refs).toContainText("运行中");
  const group = (await canvas()).groups[0]!;
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.kind === "ref")?.groupId).toBe(group.id);

  // This topic's own task is placed as its card; a task already referenced cannot be picked twice; Enter picks.
  await page.getByRole("button", { name: "引用任务" }).click();
  await options.filter({ hasText: "甲的任务" }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
  await page.getByRole("button", { name: "引用任务" }).click();
  await expect(options.filter({ hasText: "乙的任务" })).toBeDisabled();
  await expect(options.filter({ hasText: "甲的任务" })).toContainText("已在画布上");
  await picker.getByLabel("搜索任务").fill("没专题");
  await picker.getByLabel("搜索任务").press("Enter");
  await expect(refs).toHaveCount(2);
  await expect(refs.filter({ hasText: "没专题的任务" })).toContainText("不在专题里 / alpha");

  // Dragged out of the group; the status follows the task live.
  const refNode = (await refs.filter({ hasText: "乙的任务" }).getAttribute("data-node-id"))!;
  const box = (await refs.filter({ hasText: "乙的任务" }).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 160, { steps: 4 });
  await page.mouse.move(box.x + 40, box.y + 300, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.id === refNode)?.groupId).toBeNull();
  await expect(refs.filter({ hasText: "乙的任务" })).not.toContainText("运行中", { timeout: 60_000 });

  // The agent view lists references with where they belong.
  await page.getByRole("tab", { name: "agent 视角" }).click();
  await expect(page.getByTestId("agent-view")).toContainText("引用：乙的任务（专题 乙专题 / 项目 alpha");

  // Archived: greyed, saying so.
  await studio.api("POST", `/api/tasks/${loose.id}/archive`);
  await expect(refs.filter({ hasText: "没专题的任务" })).toContainText("任务已归档");
  await expect(refs.filter({ hasText: "没专题的任务" })).toHaveClass(/gone/);
  await screenshot(studio.app, "stage-11", "S11-A-ref-cards", page);

  // Double-click opens the task; "←" comes back.
  await refs.filter({ hasText: "乙的任务" }).dblclick();
  await expect(page.getByTestId("task-title")).toHaveText("乙的任务");
  await page.getByRole("button", { name: "返回画布" }).click();

  // Delete removes the card, never the task.
  await refs.filter({ hasText: "乙的任务" }).click();
  await page.keyboard.press("Delete");
  await expect(refs).toHaveCount(1);
  await refs.first().click();
  await page.getByTestId("canvas-detail").getByRole("button", { name: "删除引用卡片（任务不变）" }).click();
  await expect(refs).toHaveCount(0);
  await expect.poll(async () => (await canvas()).nodes.filter((n) => n.kind === "ref").length).toBe(0);
  const state = await studio.api<{ tasks: Task[] }>("GET", "/api/state");
  expect(state.tasks.find((t) => t.id === other.id)).toMatchObject({ topicId: there.id, archivedAt: null });
});
