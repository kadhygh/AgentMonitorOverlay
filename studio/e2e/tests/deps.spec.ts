import { expect, test } from "@playwright/test";
import type { CanvasDoc, Task, Workspace, Topic } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("dependencies from the sidebar and notes on the canvas", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const ids: Record<string, string> = {};
  for (const title of ["拆表", "改导入", "跑校验"]) {
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
    ids[title] = task.id;
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true }); // shown on the canvas (S11-A: not automatic)
  }
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(3);
  await expect.poll(async () => (await canvas()).nodes.length).toBe(3);

  // 改导入 depends on 拆表, 跑校验 depends on 改导入.
  const details = page.getByRole("group", { name: "任务详情" });
  await page.getByTestId("canvas-card").filter({ hasText: "改导入" }).click();
  await details.getByLabel("添加前置任务").selectOption({ label: "拆表" });
  await details.getByRole("button", { name: "添加" }).click();
  await expect(details.getByTestId("dependency")).toHaveText(/拆表/);
  await page.getByTestId("canvas-card").filter({ hasText: "跑校验" }).click();
  await details.getByLabel("添加前置任务").selectOption({ label: "改导入" });
  await details.getByRole("button", { name: "添加" }).click();
  await expect.poll(async () => (await canvas()).edges.map((e) => [e.from, e.to])).toEqual([
    [ids["拆表"], ids["改导入"]],
    [ids["改导入"], ids["跑校验"]],
  ]);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(2);

  // 拆表 cannot depend on either of the others: that would form a cycle.
  await page.getByTestId("canvas-card").filter({ hasText: "拆表" }).click();
  await expect(details).toContainText("没有可以设为前置的任务");

  // Remove one dependency.
  await page.getByTestId("canvas-card").filter({ hasText: "跑校验" }).click();
  await details.getByRole("button", { name: "移除前置任务 改导入" }).click();
  await expect.poll(async () => (await canvas()).edges.length).toBe(1);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(1);

  // Notes: create, edit in the sidebar, drop into a group, delete.
  await page.getByRole("button", { name: "+ 分组" }).click();
  await expect.poll(async () => (await canvas()).groups.length).toBe(1);
  await page.getByRole("button", { name: "+ 便签" }).click();
  await expect(page.getByTestId("canvas-note")).toHaveCount(1);
  const note = page.getByRole("group", { name: "便签" });
  await note.getByLabel("便签内容").fill("先问策划掉落率");
  await note.getByLabel("便签内容").blur();
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.kind === "note")).toMatchObject({ text: "先问策划掉落率" });
  await expect(page.getByTestId("canvas-note")).toHaveText("先问策划掉落率");
  // The note is created in the middle of the view, where the new group also sits: it belongs to the group.
  const doc = await canvas();
  expect(doc.nodes.find((n) => n.kind === "note")!.groupId).toBe(doc.groups[0]!.id);
  await screenshot(studio.app, "stage-3", "S3-04-deps-notes", page);

  await page.getByTestId("canvas-note").click();
  await note.getByRole("button", { name: "删除便签" }).click();
  await expect.poll(async () => (await canvas()).nodes.filter((n) => n.kind === "note").length).toBe(0);
});
