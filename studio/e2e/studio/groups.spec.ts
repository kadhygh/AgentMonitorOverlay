import { expect, test, type Page } from "@playwright/test";
import type { CanvasDoc, Workspace, Topic } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

test("canvas groups: create, rename, bind, move with members, resize, membership, delete", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const { task } = await studio.api<{ task: { id: string } }>("POST", "/api/tasks", { title: "整理导入流程", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
  await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true }); // shown on the canvas (S11-A: not automatic)
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
  await expect.poll(async () => (await canvas()).nodes.length).toBe(1);

  // Create, rename and bind through the settings panel.
  await page.getByRole("button", { name: "+ 分组" }).click();
  await expect.poll(async () => (await canvas()).groups.length).toBe(1);
  const panel = page.getByRole("group", { name: "分组设置" });
  await panel.getByLabel("分组名称").fill("导入");
  await panel.getByLabel("分组名称").press("Enter");
  await expect.poll(async () => (await canvas()).groups[0]!.title).toBe("导入");
  await panel.getByLabel("绑定项目").selectOption({ label: "alpha" });
  await expect.poll(async () => (await canvas()).groups[0]!.workspaceId).toBe(ws.id);
  await expect(page.getByTestId("canvas-group")).toContainText("导入");
  await expect(page.getByTestId("canvas-group")).toContainText("alpha");

  // Screen position of a world point (view is reset: origin at the viewport's top-left, scale 1).
  const vbox = (await page.getByTestId("canvas-viewport").boundingBox())!;
  const screen = (x: number, y: number) => ({ x: vbox.x + 1 + x, y: vbox.y + 1 + y });

  // Drag the card into the group.
  let doc = await canvas();
  const group = doc.groups[0]!;
  const node = doc.nodes[0]!;
  await drag(page, screen(node.pos.x + 40, node.pos.y + 20), screen(group.rect.x + 80, group.rect.y + 80));
  await expect.poll(async () => (await canvas()).nodes[0]!.groupId).toBe(group.id);

  // Move the group by its title bar: the card moves along.
  doc = await canvas();
  const inGroup = doc.nodes[0]!.pos;
  await drag(page, screen(group.rect.x + 120, group.rect.y + 15), screen(group.rect.x + 220, group.rect.y + 75));
  await expect.poll(async () => (await canvas()).groups[0]!.rect).toMatchObject({ x: group.rect.x + 100, y: group.rect.y + 60 });
  await expect.poll(async () => (await canvas()).nodes[0]!.pos).toEqual({ x: inGroup.x + 100, y: inGroup.y + 60 });

  // Resize from the bottom-right corner.
  doc = await canvas();
  const r = doc.groups[0]!.rect;
  await drag(page, screen(r.x + r.w - 6, r.y + r.h - 6), screen(r.x + r.w + 74, r.y + r.h + 54));
  await expect.poll(async () => (await canvas()).groups[0]!.rect).toMatchObject({ w: r.w + 80, h: r.h + 60 });

  // Drag the card out again, then put it back and delete the group: the card stays where it is.
  doc = await canvas();
  const p = doc.nodes[0]!.pos;
  await drag(page, screen(p.x + 40, p.y + 20), screen(Math.max(20, r.x - 280), r.y + 40));
  await expect.poll(async () => (await canvas()).nodes[0]!.groupId).toBeNull();
  doc = await canvas();
  const q = doc.nodes[0]!.pos;
  await drag(page, screen(q.x + 40, q.y + 20), screen(r.x + 100, r.y + 100));
  await expect.poll(async () => (await canvas()).nodes[0]!.groupId).toBe(group.id);
  const kept = (await canvas()).nodes[0]!.pos;
  await page.getByTestId("canvas-group").locator(".canvas-group-bar").click();
  await page.getByRole("group", { name: "分组设置" }).getByRole("button", { name: "删除分组…" }).click();
  // Asked whether its card goes too (2026-10-29); left unticked, the card stays.
  await expect(page.getByTestId("delete-group-cards")).not.toBeChecked();
  await page.getByTestId("delete-group-confirm").getByTestId("confirm-action").click();
  await expect.poll(async () => (await canvas()).groups.length).toBe(0);
  expect((await canvas()).nodes[0]).toMatchObject({ groupId: null, pos: kept });
  await screenshot(studio.app, "stage-3", "S3-03-groups", page);
});
