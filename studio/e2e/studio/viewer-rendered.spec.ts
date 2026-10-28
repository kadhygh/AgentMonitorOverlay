import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 渲染批注 (2026-10-28): comments on passages of Markdown and HTML shown rendered in the viewer. HTML runs its scripts
// in a sandboxed frame and still takes comments; a comment on HTML made from Markdown names the Markdown to change.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>掉落调整</title>
<script>
document.addEventListener("DOMContentLoaded", () => {
  const s = document.getElementById("s");
  try { localStorage.setItem("theme", "dark"); s.textContent = "脚本已运行"; } catch (e) { s.textContent = "存储失败"; }
});
</script></head>
<body>
<h1>掉落调整</h1>
<p id="s">脚本未运行</p>
<details><summary>细节</summary><p>隐藏的段落里有一句要批注的话。</p></details>
<p>结论：掉率 0.15 比较合适，见下表。</p>
<button id="c" onclick="navigator.clipboard.writeText('复制的内容')">复制</button>
<footer>取材：plans/report.md</footer>
<p><a id="web" href="https://example.com/doc">外链</a> <a id="sec" href="#end">到结尾</a> <a id="src" href="../plans/report.md">源文件</a></p>
<div style="height: 3000px"></div>
<p id="end">结尾</p>
</body></html>
`;

const MD = "# 掉落调整\n\n先看数据。\n\n结论：掉率 **0.15** 比较合适，见下表。\n\n| 等级 | 掉率 |\n| --- | --- |\n| 1 | 0.15 |\n\n[外链](https://example.com/md) [看表格](#表格) [回到报告](../out/report.html)\n\n" + "填充。\n\n".repeat(80) + "## 表格\n\n尾巴\n";

async function openViewer(app: ElectronApplication, page: Page, target: Record<string, unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.evaluate((t) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(t), target);
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

/** Selects `words` in the first element holding them (in a document or the HTML's frame) and lets the mouse go. */
async function select(where: Page | Frame, root: string, words: string) {
  await where.evaluate(
    ([sel, w]) => {
      const scope = document.querySelector(sel)!;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const i = n.data.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
        const box = r.getBoundingClientRect();
        n.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: box.right, clientY: box.bottom }));
        return;
      }
      throw new Error(`no ${w}`);
    },
    [root, words] as const,
  );
}

const painted = (where: Page | Frame) => where.evaluate(() => (CSS.highlights.get("amo-passage") as Set<Range> | undefined)?.size ?? 0);

test("passages of rendered HTML and Markdown take comments; HTML keeps its scripts; HTML from Markdown names the Markdown", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("design");
  mkdirSync(join(dir, "plans"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "plans", "report.md"), MD);
  writeFileSync(join(dir, "out", "report.html"), HTML);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const copied = () => app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1));
  const opened = () => app.evaluate(() => (globalThis as { __amoOpenedUrls?: string[] }).__amoOpenedUrls ?? []);

  // HTML opens rendered, its script having run (storage stands in for the sandbox's); its Markdown is found by the footer.
  const viewer = await openViewer(app, page, { path: join(dir, "out", "report.html"), workspaceId: ws.id });
  await expect(viewer.getByTestId("viewer-rendered")).toHaveAttribute("data-kind", "html");
  await expect(viewer.frameLocator('[data-testid="viewer-html"]').locator("#s")).toHaveText("脚本已运行");
  await expect(viewer.getByTestId("passage-source")).toHaveText("源文件 plans/report.md");
  const frame = viewer.frames().find((f) => f !== viewer.mainFrame())!;

  // Its copy buttons reach the clipboard through the viewer.
  await viewer.frameLocator('[data-testid="viewer-html"]').locator("#c").click();
  await expect.poll(copied).toBe("复制的内容");

  // Select, 批注, write: listed, painted in the frame.
  await select(frame, "body", "掉率 0.15 比较合适");
  await viewer.getByTestId("passage-add").click();
  await expect(viewer.getByTestId("passage-draft")).toContainText("掉率 0.15 比较合适");
  await viewer.getByTestId("passage-draft").locator("textarea").fill("再低一点，0.12");
  await viewer.getByTestId("passage-draft").locator("textarea").press("Control+Enter");
  const notes = viewer.getByTestId("passage-note");
  await expect(notes).toHaveCount(1);
  await expect(notes.first()).toContainText("再低一点，0.12");
  await expect.poll(() => painted(frame)).toBe(1);

  // One inside a folded part: going to it from the list opens the part again.
  await frame.evaluate(() => (document.querySelector("details")!.open = true));
  await select(frame, "details p", "要批注的话");
  await viewer.getByTestId("passage-add").click();
  await viewer.getByTestId("passage-draft").locator("textarea").fill("这句删掉");
  await viewer.getByTestId("passage-draft").locator("textarea").press("Control+Enter");
  await expect(notes).toHaveCount(2);
  await expect.poll(() => painted(frame)).toBe(2);
  await frame.evaluate(() => (document.querySelector("details")!.open = false));
  await notes.filter({ hasText: "这句删掉" }).locator(".vw-note-quote").click();
  await expect.poll(() => frame.evaluate(() => document.querySelector("details")!.open)).toBe(true);
  await expect(notes.filter({ hasText: "这句删掉" })).toHaveAttribute("data-hot", "");
  await screenshot(app, "stage-18", "S25-rendered-html-notes", viewer, "viewer");

  // In 源码 the same comments sit on the lines the passages start on.
  await viewer.getByRole("group", { name: "HTML" }).getByRole("button", { name: "源码" }).click();
  await expect(viewer.getByTestId("viewer-code").getByTestId("review-comment")).toHaveCount(2);
  await expect(viewer.getByTestId("viewer-code").locator('[data-line="new:13"]')).toContainText("掉率");
  await viewer.getByRole("group", { name: "HTML" }).getByRole("button", { name: "渲染" }).click();

  // Copied: each passage with the source line, and the Markdown to change.
  await viewer.getByTestId("review-copy").click();
  await expect.poll(copied).toContain("文件批注");
  const text = (await copied())!;
  expect(text).toContain("这份 HTML 由 `plans/report.md` 生成：请改 `plans/report.md`，再重新生成这份 HTML。");
  expect(text).toContain("out/report.html（渲染后的段落，源码约第 13 行）\n> 掉率 0.15 比较合适\n再低一点，0.12");
  await expect(notes).toHaveCount(0);

  // Links: the web in the browser, an anchor in the page, a file in the viewer (relative to the HTML's folder).
  const inFrame = viewer.frameLocator('[data-testid="viewer-html"]');
  await inFrame.locator("#web").click();
  await expect.poll(opened).toContain("https://example.com/doc");
  await inFrame.locator("#sec").click();
  await expect.poll(() => inFrame.locator("body").evaluate(() => scrollY)).toBeGreaterThan(1000);
  await inFrame.locator("#src").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("report.md");
  await expect(viewer.getByTestId("viewer-rendered")).toHaveAttribute("data-kind", "markdown");
  await viewer.close();

  // Markdown: the same, painted in the page; found again after the file is rewritten, marked when its words are gone.
  const md = await openViewer(app, page, { path: join(dir, "plans", "report.md"), workspaceId: ws.id });
  await expect(md.getByTestId("viewer-rendered")).toHaveAttribute("data-kind", "markdown");
  await expect(md.getByTestId("passage-source")).toHaveCount(0);
  await select(md, '[data-testid="viewer-md"]', "先看数据");
  await md.getByTestId("passage-add").click();
  await md.getByTestId("passage-draft").locator("textarea").fill("哪些数据？");
  await md.getByTestId("passage-draft").locator("textarea").press("Control+Enter");
  await expect(md.getByTestId("passage-note")).toHaveCount(1);
  await expect.poll(() => painted(md)).toBe(1);
  writeFileSync(join(dir, "plans", "report.md"), MD.replace("先看数据。", "补一句开头。\n\n先看\n数据。"));
  await md.keyboard.press("r");
  await expect(md.getByTestId("viewer-md")).toContainText("补一句开头");
  await expect.poll(() => painted(md)).toBe(1);
  await expect(md.getByTestId("passage-note")).not.toHaveAttribute("data-lost", "");
  writeFileSync(join(dir, "plans", "report.md"), MD.replace("先看数据。", "直接看结论。"));
  await md.keyboard.press("r");
  await expect(md.getByTestId("passage-note")).toHaveAttribute("data-lost", "");
  await expect(md.getByTestId("passage-note")).toContainText("原文找不到了");
  await screenshot(app, "stage-18", "S25-rendered-md-notes", md, "viewer");

  // Markdown's links: the web, a heading of the file, another file.
  const mdDoc = md.getByTestId("viewer-md");
  await mdDoc.getByRole("link", { name: "外链" }).click();
  await expect.poll(opened).toContain("https://example.com/md");
  await mdDoc.getByRole("link", { name: "看表格" }).click();
  await expect.poll(() => mdDoc.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
  await mdDoc.getByRole("link", { name: "回到报告" }).click();
  await expect(md.getByTestId("viewer-name")).toHaveText("report.html");
  await expect(md.getByTestId("viewer-rendered")).toHaveAttribute("data-kind", "html");
});
