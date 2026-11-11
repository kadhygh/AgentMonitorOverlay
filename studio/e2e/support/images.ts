import { existsSync, readFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { expect, type ElectronApplication, type Page } from "@playwright/test";

// 图片缩放、拖拽 + 右键另存为 (2026-11-11): what the e2e tests of the viewer's pictures share — a PNG made here, and the
// checks of ImageView (viewer/ImageView.tsx) any window showing a picture file goes through: fitted whole when it
// opens, the wheel zooms, a drag moves it, 适应窗口 fits it again, a right-click offers 另存为… (the save dialog replaced),
// and 复制图片 (Ctrl+C, the 复制 button, the menu) puts the picture on the clipboard — in tests the main process records
// the picture's size instead of taking the person's clipboard.

/** A PNG of one colour, with a darker band across its top (so a picture moved is seen moved). */
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = (c: [number, number, number]) => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from(c))]);
  const plain = row(rgb);
  const band = row([Math.round(rgb[0] / 3), Math.round(rgb[1] / 3), Math.round(rgb[2] / 3)]);
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => (y < height / 10 ? band : plain)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** The system's save dialog answers `filePath` (the program's main process; nothing shows). */
export async function answerSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    const answer = async () => ({ canceled: false, filePath: p });
    (dialog as unknown as { showSaveDialog: typeof answer }).showSaveDialog = answer;
  }, filePath);
}

/** The pictures the program put on the clipboard so far (their sizes; tests record them instead). */
export const copiedImages = (app: ElectronApplication) => app.evaluate(() => (globalThis as { __amoCopiedImages?: Array<{ width: number; height: number }> }).__amoCopiedImages ?? []);

const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;

/**
 * The picture shown in `page` (img `imgTestId` inside the ImageView `viewTestId`): fitted whole, zoomed by the wheel,
 * dragged, fitted again, and saved by 另存为… to `saveTo`, which then holds `bytes`.
 */
export async function exerciseImageView(app: ElectronApplication, page: Page, { imgTestId, viewTestId = "image-view", saveTo, bytes, width, height }: { imgTestId: string; viewTestId?: string; saveTo: string; bytes: Buffer; width: number; height: number }): Promise<void> {
  const view = page.getByTestId(viewTestId);
  const img = page.getByTestId(imgTestId);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(width);
  // Opened: the whole picture in the pane.
  await expect(view).toHaveAttribute("data-fitted", "true");
  await expect.poll(async () => Number(await view.getAttribute("data-scale"))).toBeLessThan(1);
  const pane = await box(page, viewTestId);
  const fitted = await box(page, imgTestId);
  expect(fitted.x).toBeGreaterThanOrEqual(pane.x - 1);
  expect(fitted.y).toBeGreaterThanOrEqual(pane.y - 1);
  expect(fitted.x + fitted.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  expect(fitted.y + fitted.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
  const fitPct = await page.getByTestId("image-view-pct").textContent();

  // The wheel zooms in where the pointer is: larger than the pane, it can be dragged.
  const cx = pane.x + pane.width / 2;
  const cy = pane.y + pane.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  await expect(view).toHaveAttribute("data-fitted", "false");
  await expect(view).toHaveClass(/pannable/);
  const zoomed = await box(page, imgTestId);
  expect(zoomed.width).toBeGreaterThan(fitted.width * 2);
  expect(await page.getByTestId("image-view-pct").textContent()).not.toBe(fitPct);

  // Dragged: it follows the pointer.
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 4 });
  await page.mouse.move(cx + 120, cy + 80, { steps: 4 });
  await page.mouse.up();
  const moved = await box(page, imgTestId);
  expect(moved.x - zoomed.x).toBeCloseTo(120, -1);
  expect(moved.y - zoomed.y).toBeCloseTo(80, -1);
  // The button zooms out too; 适应窗口 shows it whole again.
  await page.getByTestId("image-view-out").click();
  expect((await box(page, imgTestId)).width).toBeLessThan(moved.width);
  await page.getByTestId("image-view-fit").click();
  await expect(view).toHaveAttribute("data-fitted", "true");
  expect(Math.round((await box(page, imgTestId)).width)).toBe(Math.round(fitted.width));

  // Right-click: 另存为… → the system's save dialog (answered here) → the file written there.
  await img.click({ button: "right" });
  const menu = page.getByTestId("image-view-menu");
  await expect(menu).toBeVisible();
  // 复制图片 first, 另存为… next (2026-11-11).
  await expect(menu.getByRole("menuitem").nth(0)).toHaveText(/复制图片/);
  await expect(menu.getByRole("menuitem").nth(1)).toHaveText(/另存为…/);
  await answerSaveDialog(app, saveTo);
  await menu.getByRole("menuitem", { name: /另存为/ }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => existsSync(saveTo), { timeout: 10_000 }).toBe(true);
  expect(readFileSync(saveTo).equals(bytes)).toBe(true);
  await expect(page.getByTestId("toast").last()).toContainText("已保存");

  // 复制图片: Ctrl+C, the 复制 button (its key shown on it), and the menu's 复制图片 (Ctrl+C) — the picture itself each time.
  const before = (await copiedImages(app)).length;
  const toast = page.getByTestId("toast").last();
  await page.keyboard.press("Control+C");
  await expect.poll(async () => (await copiedImages(app)).length).toBe(before + 1);
  await expect(toast).toContainText(`已复制图片（${width} × ${height}）`);
  const button = page.getByTestId("image-view-copy");
  await expect(button).toContainText("Ctrl+C");
  await button.click();
  await expect.poll(async () => (await copiedImages(app)).length).toBe(before + 2);
  await img.click({ button: "right" });
  const item = menu.getByRole("menuitem", { name: /复制图片/ });
  await expect(item).toContainText("Ctrl+C");
  await item.click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await copiedImages(app)).length).toBe(before + 3);
  expect((await copiedImages(app)).slice(before)).toEqual([{ width, height }, { width, height }, { width, height }]);
}
