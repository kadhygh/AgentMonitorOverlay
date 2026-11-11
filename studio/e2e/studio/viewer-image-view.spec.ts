import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";
import { copiedImages, exerciseImageView, png } from "../support/images.js";

// 图片缩放、拖拽 + 右键另存为 (2026-11-11, the user: review 的是一张图片时要能放大、缩小，放大后能拖动，像常规的图片查看器
// 一样；打开时默认显示全图，极窄或极宽的图例外；图片上按右键可以「另存为…」). Studio's viewer: a picture file fitted whole,
// wheel, drag, 适应窗口, 另存为… (the save dialog answered by the test); a long screenshot fitted to the width from its
// top; 看大图 over a rendered page takes the same. 复制图片 (the same day, the user: 按 Ctrl+C 直接把这张图片复制到剪贴板…
// 图片旁边的按键附近也加一个复制按钮，并且标出快捷键): Ctrl+C, the button and the menu copy the picture (checked in
// exerciseImageView); an SVG is copied as a PNG of its size; in the quick look beside the conversation, Ctrl+C with
// text selected or the message box focused is the text's.

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
  writeFileSync(join(dir, "shots", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="#d97757"/><circle cx="150" cy="100" r="60" fill="#fff"/></svg>');
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  mkdirSync(join(studio.root, "saved"), { recursive: true });

  const viewer = await openViewer(app, page, { path: join(dir, "shots", "board.png"), workspaceId: ws.id });
  await expect(viewer.getByTestId("viewer-name")).toHaveText("board.png");
  await expect(viewer.getByTestId("image-view-tools")).toContainText("1600 × 1000");
  await screenshot(app, "studio", "viewer-image-fitted", viewer, "viewer");
  await exerciseImageView(app, viewer, { imgTestId: "file-preview-image", saveTo: join(studio.root, "saved", "board.png"), bytes: board, width: 1600, height: 1000 });
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

  // Ctrl+C again (the window has no text of its own beside the picture: its title bar takes no selection), for the screenshot.
  const copies = (await copiedImages(app)).length;
  await viewer.keyboard.press("Control+C");
  await expect.poll(async () => (await copiedImages(app)).length).toBe(copies + 1);
  await screenshot(app, "studio", "viewer-image-copied", viewer, "viewer");

  // An SVG: nativeImage does not read it, so the page draws it as a PNG of its own size first.
  await page.evaluate((t) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(t), { path: join(dir, "shots", "icon.svg"), workspaceId: ws.id });
  await expect(viewer.getByTestId("viewer-name")).toHaveText("icon.svg");
  await expect.poll(() => viewer.getByTestId("file-preview-image").evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(300);
  await viewer.getByTestId("image-view-copy").click();
  await expect.poll(async () => (await copiedImages(app)).at(-1)).toEqual({ width: 300, height: 200 });
  await expect(viewer.getByTestId("toast").last()).toContainText("已复制图片（300 × 200）");

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
  await exerciseImageView(app, viewer, { imgTestId: "image-zoom-img", saveTo: join(studio.root, "saved", "zoomed.png"), bytes: board, width: 1600, height: 1000 });
  // Esc closes the menu first, then the picture.
  await viewer.getByTestId("image-zoom-img").click({ button: "right" });
  await viewer.keyboard.press("Escape");
  await expect(viewer.getByTestId("image-view-menu")).toHaveCount(0);
  await expect(zoom).toBeVisible();
  await viewer.keyboard.press("Escape");
  await expect(zoom).toHaveCount(0);
});

test("Ctrl+C beside a picture in the quick look: text selected in the conversation, or the message box focused, copies the text; otherwise the picture", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("design");
  writeFileSync(join(dir, "board.png"), png(640, 400, [80, 140, 210]));
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await studio.api("POST", "/api/tasks", { title: "看图", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "看一下这张图的配色：`board.png`" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 60_000 });
  // 在侧栏预览 the picture the reply names: beside the conversation.
  await page.getByTestId("msg-agent").last().getByTestId("file-link").filter({ hasText: "board.png" }).click({ button: "right" });
  await page.getByTestId("file-menu").getByRole("menuitem", { name: /在侧栏预览/ }).click();
  const preview = page.getByTestId("file-preview");
  await expect.poll(() => preview.getByTestId("file-preview-image").evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(640);

  // A listener after the page's own: whether the page left Ctrl+C alone; it stops the browser's copy (the clipboard stays untouched).
  await page.evaluate(() => {
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.code === "KeyC") {
        const w = window as unknown as { __left?: boolean[] };
        w.__left = [...(w.__left ?? []), !e.defaultPrevented];
        e.preventDefault();
      }
    });
  });
  const left = () => page.evaluate(() => (window as unknown as { __left?: boolean[] }).__left ?? []);
  const copies = (await copiedImages(app)).length;

  // Text selected in the conversation: the text's.
  await page.getByTestId("msg-user").getByText("看一下这张图的配色").first().selectText();
  await page.keyboard.press("Control+C");
  await expect.poll(left).toEqual([true]);
  // The focus in the message box: the box's.
  await page.getByLabel("输入消息").fill("草稿");
  await page.getByLabel("输入消息").press("Control+C");
  await expect.poll(left).toEqual([true, true]);
  expect((await copiedImages(app)).length).toBe(copies);

  // Neither: the picture.
  await preview.getByTestId("file-preview-image").click();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.keyboard.press("Control+C");
  await expect.poll(left).toEqual([true, true, false]);
  await expect.poll(async () => (await copiedImages(app)).at(-1)).toEqual({ width: 640, height: 400 });
  await screenshot(app, "studio", "quicklook-image-copied", page);
});
