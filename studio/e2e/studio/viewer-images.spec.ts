import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 看大图 + 返回 (2026-11-06): the user clicked a screenshot linked from an HTML report and the viewer replaced the page
// with the picture, with no way back. Now a picture shows enlarged over the page (Esc / × / a click beside it closes
// it), and the viewer window keeps the files it showed for ← (Alt+←), the page back where it was scrolled.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** A picture the page has inlined: 2×2 red pixels. */
const DATA_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>报告</title></head>
<body>
<h1>报告</h1>
<p><a id="shot" href="../shots/board.png"><img src="${DATA_PNG}" width="120" alt="看板截图"></a></p>
<p><a id="text-shot" href="../shots/board.png?v=2">看截图</a></p>
<p><img id="inline" src="${DATA_PNG}" width="60" alt="内嵌的图"></p>
<div style="height: 2400px"></div>
<p id="low"><a id="src" href="../plans/report.md">源文件</a></p>
<div style="height: 1200px"></div>
</body></html>
`;

const MD = "# 源文件\n\n![看板](../shots/board.png)\n\n[回到报告](../out/report.html)\n";

async function openViewer(app: ElectronApplication, page: Page, target: Record<string, unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.evaluate((t) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(t), target);
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

test("a picture of a rendered page shows enlarged over it, and ← brings the page back where it was", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("design");
  for (const d of ["plans", "out", "shots"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "out", "report.html"), HTML);
  writeFileSync(join(dir, "plans", "report.md"), MD);
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "screenshots", "platform", "P46-changelog.png"), join(dir, "shots", "board.png"));
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });

  const viewer = await openViewer(app, page, { path: join(dir, "out", "report.html"), workspaceId: ws.id });
  await expect(viewer.getByTestId("viewer-rendered")).toHaveAttribute("data-kind", "html");
  const inFrame = viewer.frameLocator('[data-testid="viewer-html"]');
  await expect(viewer.getByTestId("viewer-back")).toHaveCount(0);

  // A picture linked from the page: over the page, the file loaded through the Host; the page stays.
  await inFrame.locator("#shot").click();
  const zoom = viewer.getByTestId("image-zoom");
  await expect(zoom).toBeVisible();
  await expect(zoom).toContainText("board.png");
  await expect.poll(() => viewer.getByTestId("image-zoom-img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
  await expect(viewer.getByTestId("image-zoom-open")).toBeVisible();
  await expect(viewer.getByTestId("image-zoom-reveal")).toBeVisible();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("report.html");
  await screenshot(app, "studio", "viewer-image-zoom", viewer, "viewer");
  // The wheel zooms in; 适应窗口 fits it again.
  await zoom.hover();
  await viewer.mouse.wheel(0, -300);
  await expect(zoom.getByRole("button", { name: "适应窗口" })).toBeVisible();
  await viewer.keyboard.press("Escape");
  await expect(zoom).toHaveCount(0);
  await expect(viewer.getByTestId("viewer-name")).toHaveText("report.html");

  // A text link to a picture (with a query) zooms too; × closes it.
  await inFrame.locator("#text-shot").click();
  await expect(zoom).toContainText("board.png");
  await viewer.getByTestId("image-zoom-close").click();
  await expect(zoom).toHaveCount(0);

  // A picture that is no link: what the page loaded (inlined), without the file's buttons; a click beside it closes it.
  await inFrame.locator("#inline").click();
  await expect(zoom).toContainText("内嵌的图");
  await expect(viewer.getByTestId("image-zoom-open")).toHaveCount(0);
  await zoom.click({ position: { x: 10, y: 200 } });
  await expect(zoom).toHaveCount(0);

  // A link to a file still opens it in the viewer, and ← comes back to the page, scrolled where it was left.
  await inFrame.locator("#low").scrollIntoViewIfNeeded();
  const left = await inFrame.locator("body").evaluate(() => scrollY);
  expect(left).toBeGreaterThan(1500);
  await inFrame.locator("#src").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("report.md");
  await expect(viewer.getByTestId("viewer-back")).toBeVisible();

  // In Markdown: a picture zooms over it as well.
  await viewer.getByTestId("md-image").click();
  await expect(zoom).toContainText("board.png");
  await viewer.keyboard.press("Escape");
  await expect(zoom).toHaveCount(0);

  await viewer.getByTestId("viewer-back").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("report.html");
  await expect.poll(() => inFrame.locator("body").evaluate(() => scrollY)).toBeGreaterThan(left - 50);
  await expect(viewer.getByTestId("viewer-back")).toHaveCount(0);

  // 在查看器中打开 shows the picture alone; Alt+← comes back to the page.
  await inFrame.locator("#text-shot").click();
  await viewer.getByTestId("image-zoom-open").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("board.png");
  await viewer.keyboard.press("Alt+ArrowLeft");
  await expect(viewer.getByTestId("viewer-name")).toHaveText("report.html");
  await viewer.close();
});
