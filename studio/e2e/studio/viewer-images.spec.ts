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

// 页面旁边的文件 (2026-11-06; the user: DSH's pages keep their CSS beside them): a page's stylesheet, script, pictures
// (also from a folder up, in the project) load through the Host; a file outside the project does not.
test("an HTML page's stylesheet, script and pictures beside it load in the viewer", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("design");
  for (const d of ["out", "shots"]) mkdirSync(join(dir, d), { recursive: true });
  const outside = join(dir, "..", "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "evil.css"), "body { background: rgb(255, 0, 0); }");
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "screenshots", "platform", "P46-changelog.png"), join(dir, "shots", "board.png"));
  writeFileSync(join(dir, "out", "style.css"), "h1 { color: rgb(1, 2, 3); } .card { background-image: url(../shots/board.png); width: 40px; height: 40px; }");
  writeFileSync(join(dir, "out", "app.js"), "document.addEventListener('DOMContentLoaded', () => { document.getElementById('js').textContent = '脚本已加载'; });");
  writeFileSync(
    join(dir, "out", "page.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>页面</title><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="../../outside/evil.css"><script src="app.js"></script></head>
<body><h1>旁边的样式</h1><p id="js">脚本没加载</p><div class="card"></div><img id="pic" src="../shots/board.png" width="200"><p><a id="sec" href="#end">到结尾</a></p><div style="height:2000px"></div><p id="end">结尾</p></body></html>`,
  );
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });

  const viewer = await openViewer(app, page, { path: join(dir, "out", "page.html"), workspaceId: ws.id });
  const inFrame = viewer.frameLocator('[data-testid="viewer-html"]');
  await expect(inFrame.locator("h1")).toHaveText("旁边的样式");
  await expect.poll(() => inFrame.locator("h1").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(1, 2, 3)");
  await expect(inFrame.locator("#js")).toHaveText("脚本已加载");
  await expect.poll(() => inFrame.locator("#pic").evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
  expect(await inFrame.locator(".card").evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("/api/fs/page/");
  // Outside the project: not served, the page's own background stays.
  expect(await inFrame.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 0, 0)");
  // An in-page anchor still moves within the page (the <base> does not send it away).
  await inFrame.locator("#sec").click();
  await expect.poll(() => inFrame.locator("body").evaluate(() => scrollY)).toBeGreaterThan(1000);
  await expect(viewer.getByTestId("viewer-name")).toHaveText("page.html");
  // The picture loaded beside the page zooms as its file (with its buttons).
  await inFrame.locator("#pic").click();
  await expect(viewer.getByTestId("image-zoom")).toContainText("board.png");
  await expect(viewer.getByTestId("image-zoom-reveal")).toBeVisible();
  await inFrame.locator("body").evaluate(() => scrollTo(0, 0));
  await viewer.keyboard.press("Escape");
  await screenshot(app, "studio", "viewer-page-assets", viewer, "viewer");
  await viewer.close();
});

// 查找 (2026-11-06; the user: 查看渲染时，无法用 ctrl+f 搜索具体的文字): Ctrl+F on a rendered HTML page — from inside the page
// (the frame passes it on) or from the window — opens the find bar; the page's visible text and what folded <details>
// hold are searched (not its scripts or hidden parts), matches painted, Enter steps and scrolls, Esc clears.
test("Ctrl+F finds text in a rendered HTML page", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("design");
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(
    join(dir, "out", "find.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>查找</title><script>const note = "苹果 in a script";</script></head>
<body><h1>水果</h1><p id="first">第一个苹果。Apple and apple.</p><div style="display:none">藏起来的苹果</div><div style="height:2400px"></div>
<p id="far">很远的苹果</p><details><summary>折起来</summary><p id="folded">折起来的苹果</p></details><div style="height:600px"></div></body></html>`,
  );
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const viewer = await openViewer(app, page, { path: join(dir, "out", "find.html"), workspaceId: ws.id });
  const inFrame = viewer.frameLocator('[data-testid="viewer-html"]');
  await expect(inFrame.locator("h1")).toHaveText("水果");

  // From inside the page.
  await inFrame.locator("#first").click();
  await inFrame.locator("body").press("Control+f");
  const bar = viewer.getByTestId("find-bar");
  await expect(bar).toBeVisible();
  // The page's focus (toBeFocused also asks the window to be in front, which two at once are not).
  await expect.poll(() => viewer.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("find-input");
  await viewer.getByTestId("find-input").fill("苹果");
  await expect(viewer.getByTestId("find-count")).toHaveText("第 1 / 共 3 个");
  expect(await inFrame.locator("body").evaluate(() => CSS.highlights.get("amo-find")?.size ?? 0)).toBe(3);
  await viewer.getByTestId("find-input").press("Enter");
  await expect(viewer.getByTestId("find-count")).toHaveText("第 2 / 共 3 个");
  await expect.poll(() => inFrame.locator("body").evaluate(() => scrollY)).toBeGreaterThan(1500);
  await screenshot(app, "studio", "viewer-html-find", viewer, "viewer");
  await viewer.getByTestId("find-input").press("Enter");
  await expect(viewer.getByTestId("find-count")).toHaveText("第 3 / 共 3 个");
  await expect(inFrame.locator("details")).toHaveAttribute("open", "");
  await viewer.getByTestId("find-input").press("Shift+Enter");
  await expect(viewer.getByTestId("find-count")).toHaveText("第 2 / 共 3 个");

  // Case.
  await viewer.getByTestId("find-input").fill("apple");
  await expect(viewer.getByTestId("find-count")).toHaveText(/共 2 个/);
  await viewer.getByTestId("find-case").click();
  await expect(viewer.getByTestId("find-count")).toHaveText("第 1 / 共 1 个");
  await viewer.getByTestId("find-input").fill("没有的字");
  await expect(viewer.getByTestId("find-count")).toHaveText("无结果");

  // Esc closes it and the page's highlights go.
  await viewer.getByTestId("find-input").press("Escape");
  await expect(bar).toHaveCount(0);
  await expect.poll(() => inFrame.locator("body").evaluate(() => CSS.highlights.has("amo-find") || CSS.highlights.has("amo-find-current"))).toBe(false);

  // From the window (the focus outside the page), with the search kept.
  await viewer.getByTestId("viewer-name").click();
  await viewer.keyboard.press("Control+f");
  await expect(bar).toBeVisible();
  await expect(viewer.getByTestId("find-input")).toHaveValue("没有的字");
  await viewer.close();
});
