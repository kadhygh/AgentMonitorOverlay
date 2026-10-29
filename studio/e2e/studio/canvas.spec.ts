import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CanvasDoc, Session, Task, Workspace, Topic } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(40, box.width / 2);
  const y = box.y + Math.min(20, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("canvas: tasks appear, cards move and persist, pan and zoom", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  for (const title of ["整理导入流程", "掉落表校验"]) {
    const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true }); // shown on the canvas (S11-A: not automatic)
  }

  await page.getByRole("button", { name: "画布", exact: true }).click();
  const cards = page.getByTestId("canvas-card");
  await expect(cards).toHaveCount(2);
  await expect.poll(async () => (await studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes.length).toBe(2);
  await page.getByRole("button", { name: "复位" }).click();
  await expect(page.getByTestId("zoom-label")).toHaveText("100%");

  // Drag a card: the new position is saved in the Host.
  const card = cards.filter({ hasText: "掉落表校验" });
  const nodeId = (await card.getAttribute("data-node-id"))!;
  const before = (await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes.find((n) => n.id === nodeId)!.pos;
  await dragBy(page, card, 120, 160);
  await expect
    .poll(async () => (await studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes.find((n) => n.id === nodeId)!.pos)
    .toEqual({ x: before.x + 120, y: before.y + 160 });

  // Pan by dragging empty space; zoom with the wheel and the buttons; reset (the dragged card's 详情框 put away first:
  // the wheel over it scrolls the box, not the canvas).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  const world = page.getByTestId("canvas-world");
  const viewport = page.getByTestId("canvas-viewport");
  const vbox = (await viewport.boundingBox())!;
  await page.mouse.move(vbox.x + vbox.width - 120, vbox.y + vbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(vbox.x + vbox.width - 220, vbox.y + vbox.height / 2 + 50, { steps: 5 });
  await page.mouse.up();
  await expect(world).toHaveAttribute("style", /translate\(-100px, 50px\) scale\(1\)/);
  await page.mouse.move(vbox.x + vbox.width / 2, vbox.y + vbox.height / 2);
  await page.mouse.wheel(0, -120);
  await expect(page.getByTestId("zoom-label")).toHaveText("110%");
  await page.getByRole("button", { name: "缩小" }).click();
  await expect(page.getByTestId("zoom-label")).toHaveText("92%");
  await page.getByRole("button", { name: "复位" }).click();
  await expect(world).toHaveAttribute("style", /translate\(0px, 0px\) scale\(1\)/);
  await screenshot(studio.app, "stage-3", "S3-02-canvas", page);

  // A task created elsewhere is not placed by itself (S11-A); shown while the canvas is open, it appears. Double-click
  // opens it.
  const { task: late } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "新来的任务", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
  await expect(cards).toHaveCount(2);
  await studio.api("PUT", `/api/tasks/${late.id}/canvas`, { onCanvas: true });
  await expect(cards).toHaveCount(3);
  await cards.filter({ hasText: "新来的任务" }).dblclick();
  await expect(page.getByTestId("task-title")).toHaveText("新来的任务");
});

test("an archived task keeps its card on the canvas, greyed and marked 已归档, with its dependency (2026-10-22)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const ids: string[] = [];
  for (const title of ["拆掉旧的掉落表", "改导入流程"]) {
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id });
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
    ids.push(task.id);
  }
  const doc = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...doc, edges: [{ id: "e-dep", kind: "depends", from: ids[0], to: ids[1] }] });
  await studio.api("POST", `/api/tasks/${ids[0]}/archive`);

  await page.getByRole("button", { name: "画布", exact: true }).click();
  const cards = page.getByTestId("canvas-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(1);
  const gone = cards.filter({ hasText: "拆掉旧的掉落表" });
  await expect(gone).toHaveClass(/is-archived/);
  await expect(gone.getByTestId("canvas-card-archived")).toHaveText("已归档");
  await expect(cards.filter({ hasText: "改导入流程" })).not.toHaveClass(/is-archived/);

  // Its menu: read-only, so no description and no new dependency.
  await gone.click({ button: "right" });
  const menu = page.getByTestId("canvas-menu");
  await expect(menu.getByRole("menuitem", { name: "打开任务（只读）" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /添加说明|连依赖/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await screenshot(app, "stage-18", "S18-canvas-archived-card", page);
  await gone.dblclick();
  await expect(page.getByTestId("task-archived-banner")).toContainText("已归档 · 只读");
});
