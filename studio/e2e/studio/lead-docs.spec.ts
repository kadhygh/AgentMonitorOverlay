import { expect, test } from "@playwright/test";
import type { StateSnapshot, Task, Topic, TopicDoc, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 16 (the stage 15 design, first part): a task marked 主控 when made or later, shown on its cards and page; a
// topic's documents on its canvas page (文档), which agents read with topic_docs.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("主控 from the new task page and the task's menu; a topic's documents on its canvas (stage 16)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "迁移" });

  // A new task in the topic, marked 主控.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  await page.getByRole("group", { name: "专题" }).getByRole("button", { name: "迁移" }).click();
  await page.getByTestId("draft-lead").check();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock Claude" }).click();
  await page.getByLabel("第一句话").fill("拆一下迁移的任务");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("task-lead")).toHaveText("主控", { timeout: 60_000 });
  const lead = (await studio.api<StateSnapshot>("GET", "/api/state")).tasks.find((t) => t.topicId === topic.id)!;
  expect(lead.lead).toBe(true);
  await screenshot(studio.app, "stage-16", "S16-C-lead", page);

  // The task's ⋯ takes the mark off, and puts it back.
  await page.getByTestId("task-more").click();
  await expect(page.getByTestId("task-lead-toggle")).toHaveText("取消主控");
  await page.getByTestId("task-lead-toggle").click();
  await expect(page.getByTestId("task-lead")).toHaveCount(0);
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).tasks.find((t) => t.id === lead.id)?.lead).toBeFalsy();
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-lead-toggle").click();
  await expect(page.getByTestId("task-lead")).toBeVisible();

  // The topic's canvas: the card says 主控; 文档 holds the topic's documents.
  await studio.api("PUT", `/api/tasks/${lead.id}/canvas`, { onCanvas: true });
  await page.getByRole("button", { name: "返回画布" }).or(page.getByRole("button", { name: "返回看板" })).first().click();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card").getByTestId("lead-badge")).toBeVisible();
  await page.getByRole("tab", { name: "文档" }).click();
  await page.getByTestId("doc-new").click();
  await page.getByLabel("文档标题").fill("迁移计划");
  await page.getByLabel("文档内容").fill("## 顺序\n\n1. 装甲车\n2. 弹射闪电");
  await page.getByTestId("doc-save").click();
  const view = page.getByTestId("doc-view");
  await expect(view.getByRole("listitem")).toHaveText(["装甲车", "弹射闪电"]);
  await expect(view).toContainText("弹射闪电");
  await screenshot(studio.app, "stage-16", "S16-C-topic-docs", page);
  await page.getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("文档内容").fill("## 顺序\n\n1. 装甲车（已完成）\n2. 弹射闪电");
  await page.getByTestId("doc-save").click();
  await expect(view).toContainText("已完成");
  const docs = await studio.api<TopicDoc[]>("GET", `/api/topics/${topic.id}/docs`);
  expect(docs).toMatchObject([{ title: "迁移计划", body: expect.stringContaining("已完成") }]);
  // An agent's write shows here at once.
  await studio.api("PATCH", `/api/topic-docs/${docs[0]!.id}`, { title: "迁移计划 v2" });
  await page.getByRole("button", { name: "‹ 全部文档" }).click();
  await expect(page.getByTestId("doc-row")).toHaveCount(1);
  await expect(page.getByTestId("doc-row")).toContainText("迁移计划 v2");
  expect(((await studio.api<StateSnapshot>("GET", "/api/state")).tasks as Task[]).filter((t) => t.lead)).toHaveLength(1);
});
