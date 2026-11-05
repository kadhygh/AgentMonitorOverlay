import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { programLaunch } from "../support/packed.js";
import { screenshot, studioRoot } from "../support/studio.js";

// Ctrl+A in AMO Reviewer (2026-11-05, the user: 查看脚本文件时按全选会选到下面的快捷键内容): it selects the file's text
// only, and Ctrl+C on that copies the whole file (lines far from the view are not drawn), without line numbers. Git
// Review's diff, rendered Markdown and HTML keep it to their text too; a box being typed in keeps its own Ctrl+A.
// Copies are read from a copy event dispatched in the page, so the system clipboard is left alone.

const MAIN = join(studioRoot, "packages", "reviewer", "dist", "main.js");
const CLI = join(studioRoot, "scripts", "amo-review.mjs");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC_|AMO_)/.test(k)) env[k] = v;
  return { ...env, AMO_REVIEWER_TEST: "1", AMO_REVIEWER_HOME: home };
}

let app: ElectronApplication | undefined;
let root = "";

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root) removeTempDir(root);
});

async function windowAt(a: ElectronApplication, part: string): Promise<Page> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const w = a.windows().find((p) => p.url().includes(part));
    if (w) {
      await w.waitForLoadState("domcontentloaded");
      return w;
    }
    if (Date.now() > deadline) throw new Error(`no window at ${part}`);
    await a.waitForEvent("window", { timeout: 2000 }).catch(() => undefined);
  }
}

/** What a Ctrl+C now would put on the clipboard: a copy event in the page, as the browser sends one. */
const copied = (page: Page) =>
  page.evaluate(() => {
    const data = new DataTransfer();
    const e = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented ? data.getData("text/plain") : (getSelection()?.toString() ?? "");
  });

/** The selection lies inside `selector` (and is not empty). */
const selectedIn = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const s = getSelection();
    const el = document.querySelector(sel);
    if (!s || !s.rangeCount || s.isCollapsed || !el) return false;
    const r = s.getRangeAt(0);
    return el.contains(r.startContainer) && el.contains(r.endContainer);
  }, selector);

test("Ctrl+A selects the file's text only, and Ctrl+C copies all of it; boxes keep their own Ctrl+A", async () => {
  root = mkdtempSync(join(tmpdir(), "amo-reviewer-selectall-"));
  const home = join(root, "home");
  const repo = join(root, "game");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  // Long enough that most of its lines are not drawn (LazyChunks draws near the view only).
  const script = Array.from({ length: 3000 }, (_, i) => `local v${i + 1} = ${i + 1} -- 第 ${i + 1} 行`).join("\n") + "\n";
  writeFileSync(join(repo, "big.lua"), script);
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.1\nreturn rate\n");
  writeFileSync(join(repo, "notes.md"), "# 掉落\n\n掉率改成 **0.25**。\n\n- 第一条\n- 第二条\n");
  writeFileSync(join(repo, "page.html"), "<!doctype html><html><body><h1>页面标题</h1><p>页面里的一段话。</p></body></html>\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.25\nreturn rate\n");

  const launched = programLaunch("reviewer", MAIN);
  app = await _electron.launch({ executablePath: launched.executablePath, args: [...launched.args, repo], env: cleanEnv(home) });
  const review = await windowAt(app, "reviewer.html#review");
  await expect(review.getByTestId("review-file-head")).toContainText("drop.lua");

  // Git Review: the diff only — not the file list's key hints — and its rows as a diff, marked + / -.
  await expect(review.locator('[data-line="new:1"]')).toContainText("0.25");
  await review.keyboard.press("Control+A");
  expect(await selectedIn(review, ".gr-scroll .gr-lines")).toBe(true);
  expect(await review.evaluate(() => getSelection()?.toString() ?? "")).not.toContain("切换文件");
  const diffCopy = await copied(review);
  expect(diffCopy).toContain("-local rate = 0.1");
  expect(diffCopy).toContain("+local rate = 0.25");
  expect(diffCopy).not.toMatch(/切换文件|草稿批注/);

  const open = (file: string, ...more: string[]) => promisify(execFile)(process.execPath, [CLI, repo, "--reviewer", "--mode", "file", "--file", file, ...more], { env: cleanEnv(home), encoding: "utf8", windowsHide: true });

  // The viewer, a long script: Ctrl+A selects the code, not the keys under it; Ctrl+C is the whole file.
  await open("big.lua", "--line", "1");
  const viewer = await windowAt(app, "reviewer.html#viewer");
  const code = viewer.getByTestId("viewer-code");
  await expect(code.locator('[data-line="new:1"]')).toContainText("local v1 = 1");
  expect(await code.locator(".gr-line").count()).toBeLessThan(3000);
  await viewer.keyboard.press("Control+A");
  expect(await selectedIn(viewer, '[data-testid="viewer-code"] .gr-lines')).toBe(true);
  const shown = await viewer.evaluate(() => getSelection()?.toString() ?? "");
  expect(shown).not.toMatch(/翻页|跳到行|查找/);
  await screenshot(app, "reviewer", "select-all-viewer", viewer, "viewer");
  expect(await copied(viewer)).toBe(script);
  // Clicking elsewhere drops the select-all: a copy is the browser's again (nothing selected, nothing copied).
  await code.locator('[data-line="new:2"] .gr-text').click();
  expect(await copied(viewer)).not.toBe(script);

  // Ctrl+F's box keeps its own Ctrl+A: its words are selected, and a copy is not the whole file.
  await viewer.keyboard.press("Control+F");
  const find = viewer.getByTestId("find-input");
  await find.fill("local v2");
  await find.press("Control+A");
  expect(await find.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, "local v2".length]);
  expect(await copied(viewer)).not.toBe(script);
  await find.press("Escape");

  // Rendered Markdown: the document, not the comments beside it or the window's buttons.
  await open("notes.md");
  await expect(viewer.getByTestId("viewer-md")).toContainText("掉率改成");
  await viewer.keyboard.press("Control+A");
  expect(await selectedIn(viewer, '[data-testid="viewer-md"]')).toBe(true);
  const md = await viewer.evaluate(() => getSelection()?.toString() ?? "");
  expect(md).toContain("掉率改成");
  expect(md).toContain("第二条");
  expect(md).not.toMatch(/重新载入|复制路径|源文件|批注/);

  // HTML: its page, in its frame (which takes the focus, so Ctrl+C copies there); nothing of the viewer's.
  await open("page.html");
  const frame = viewer.frameLocator('[data-testid="viewer-html"]');
  await expect(frame.locator("h1")).toHaveText("页面标题");
  await viewer.locator("body").focus();
  await viewer.keyboard.press("Control+A");
  await expect.poll(() => frame.locator("body").evaluate(() => getSelection()?.toString() ?? "")).toContain("页面里的一段话");
  expect(await viewer.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
  expect(await viewer.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("viewer-html");
});
