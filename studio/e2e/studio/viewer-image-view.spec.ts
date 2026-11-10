import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";
import { exerciseImageView, png } from "../support/images.js";

// 图片缩放、拖拽 + 右键另存为 (2026-11-11, the user: review 的是一张图片时要能放大、缩小，放大后能拖动，像常规的图片查看器
// 一样；打开时默认显示全图，极窄或极宽的图例外；图片上按右键可以「另存为…」). Studio's viewer: a picture file fitted whole,
// wheel, drag, 适应窗口, 另存为… (the save dialog answered by the test); a long screenshot fitted to the width from its
// top; 看大图 over a rendered page takes the same.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openViewer(app: ElectronApplication, page: Page, target: Record<string, unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.evaluate((t) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(t), target);
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

test("a picture in the viewer opens fitted whole, zooms with the wheel, drags once larger, and saves through 另存为…", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("design");
  mkdirSync(join(dir, "shots"), { recursive: true });
  const board = png(1600, 1000, [80, 140, 210]);
  writeFileSync(join(dir, "shots", "board.png"), board);
  const long = png(1200, 7200, [217, 119, 87]);
  writeFileSync(join(dir, "shots", "long.png"), long);
  writeFileSync(join(dir, "shots", "page.md"), "# 截图\n\n![看板](board.png)\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  mkdirSync(join(studio.root, "saved"), { recursive: true });

  const viewer = await openViewer(app, page, { path: join(dir, "shots", "board.png"), workspaceId: ws.id });
  await expect(viewer.getByTestId("viewer-name")).toHaveText("board.png");
  await expect(viewer.getByTestId("image-view-tools")).toContainText("1600 × 1000");
  await screenshot(app, "studio", "viewer-image-fitted", viewer, "viewer");
  await exerciseImageView(app, viewer, { imgTestId: "file-preview-image", saveTo: join(studio.root, "saved", "board.png"), bytes: board, width: 1600 });
  // Zoomed in, for the screenshot.
  const pane = (await viewer.getByTestId("image-view").boundingBox())!;
  await viewer.mouse.move(pane.x + pane.width * 0.3, pane.y + pane.height * 0.2);
  for (let i = 0; i < 4; i++) await viewer.mouse.wheel(0, -120);
  await screenshot(app, "studio", "viewer-image-zoomed", viewer, "viewer");
  await viewer.getByTestId("file-preview-image").click({ button: "right" });
  await expect(viewer.getByTestId("image-view-menu")).toBeVisible();
  await screenshot(app, "studio", "viewer-image-menu", viewer, "viewer");
  await viewer.keyboard.press("Escape");
  await expect(viewer.getByTestId("image-view-menu")).toHaveCount(0);

  // A long screenshot (6 times taller than wide): fitted to the pane's width, from its top; dragged to see the rest.
  await page.evaluate((t) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(t), { path: join(dir, "shots", "long.png"), workspaceId: ws.id });
  await expect(viewer.getByTestId("viewer-name")).toHaveText("long.png");
  const img = viewer.getByTestId("file-preview-image");
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(1200);
  const view = viewer.getByTestId("image-view");
  await expect(view).toHaveAttribute("data-fitted", "true");
  await expect(view).toHaveClass(/pannable/);
  const lp = (await view.boundingBox())!;
  const li = (await img.boundingBox())!;
  expect(li.width).toBeGreaterThan(lp.width - 40);
  expect(li.y - lp.y).toBeCloseTo(12, -1);
  expect(li.height).toBeGreaterThan(lp.height * 3);
  // A picture this large is drawn a moment after it is laid out: the screenshot waits for it.
  await img.evaluate((el) => (el as HTMLImageElement).decode());
  await viewer.waitForTimeout(300);
  await screenshot(app, "studio", "viewer-image-long", viewer, "viewer");
  await viewer.mouse.move(lp.x + lp.width / 2, lp.y + lp.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(lp.x + lp.width / 2, lp.y + lp.height / 2 - 300, { steps: 6 });
  await viewer.mouse.up();
  expect((await img.boundingBox())!.y).toBeLessThan(li.y - 200);

  // 看大图 over a rendered Markdown: the same picture view (zoom, 另存为…).
  await page.evaluate((t) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(t), { path: join(dir, "shots", "page.md"), workspaceId: ws.id });
  await viewer.getByTestId("md-image").click();
  const zoom = viewer.getByTestId("image-zoom");
  await expect(zoom).toBeVisible();
  await exerciseImageView(app, viewer, { imgTestId: "image-zoom-img", saveTo: join(studio.root, "saved", "zoomed.png"), bytes: board, width: 1600 });
  // Esc closes the menu first, then the picture.
  await viewer.getByTestId("image-zoom-img").click({ button: "right" });
  await viewer.keyboard.press("Escape");
  await expect(viewer.getByTestId("image-view-menu")).toHaveCount(0);
  await expect(zoom).toBeVisible();
  await viewer.keyboard.press("Escape");
  await expect(zoom).toHaveCount(0);
});
