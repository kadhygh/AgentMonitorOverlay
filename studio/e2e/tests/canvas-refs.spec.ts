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
  // PUT-PLACEHOLDER
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
