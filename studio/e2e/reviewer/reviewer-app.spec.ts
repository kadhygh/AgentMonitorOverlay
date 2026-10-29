import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { screenshot, studioRoot } from "../support/studio.js";

// AMO Reviewer on its own (2026-10-23): Git Review and the viewer for any tool, without AMO Studio. Started with a
// folder it opens its changes; amo-review --reviewer opens a file in it; comments are copied (复制注释); no bookmarks.

const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;
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

/** The head is the window's title bar: it drags the window and ends with 最小化 / 最大化 / 关闭 at the top right. */
async function expectTitleBar(win: Page, head: string) {
  const bar = win.locator(head);
  expect(await bar.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("drag");
  const controls = bar.getByTestId("win-controls");
  for (const name of ["最小化", "最大化", "关闭"]) await expect(controls.getByRole("button", { name, exact: true })).toBeVisible();
  const box = (await controls.boundingBox())!;
  expect(Math.round(box.x + box.width)).toBe(await win.evaluate(() => document.documentElement.clientWidth));
  expect(Math.round(box.y)).toBe(0);
}

test("started with a folder it reviews its changes; comments are copied; amo-review --reviewer opens a file; no bookmarks", async () => {
  root = mkdtempSync(join(tmpdir(), "amo-reviewer-e2e-"));
  const home = join(root, "home");
  const repo = join(root, "game");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.1\nreturn rate\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.25\nreturn rate\n");

  app = await _electron.launch({ executablePath: electronPath, args: [MAIN, repo], env: cleanEnv(home) });
  const review = await windowAt(app, "reviewer.html#review");
  await expect(review.getByTestId("review-file")).toHaveCount(1);
  await expect(review.getByTestId("review-file-head")).toContainText("drop.lua");
  // Bookmarks are Studio's: none here.
  await expect(review.getByRole("button", { name: /书签/ })).toHaveCount(0);

  // A comment, then 复制注释: the text on the clipboard (recorded in tests), the draft gone.
  await review.locator('[data-line="new:1"]').getByTestId("add-comment").click();
  await review.getByTestId("comment-draft").locator("textarea").fill("0.25 太高");
  await review.getByTestId("comment-draft").locator("textarea").press("Control+Enter");
  await expect(review.getByTestId("review-draft-count")).toHaveText("草稿批注 1 条");
  await screenshot(app, "reviewer", "R1-review", review, "review");
  // No system title bar (2026-10-29): the head drags the window and ends with its own window buttons.
  await expectTitleBar(review, ".gr-head");
  await screenshot(app, "reviewer", "titlebar-review-light", review, "review");
  await review.getByTestId("review-copy").click();
  await expect.poll(() => app!.evaluate(() => (globalThis as { __reviewerCopied?: string[] }).__reviewerCopied?.at(-1) ?? "")).toContain("0.25 太高");
  await expect(review.getByTestId("review-draft-count")).toHaveText("草稿批注 0 条");

  // The command line opens a file of the folder in the viewer of the program that runs.
  const out = await promisify(execFile)(process.execPath, [CLI, repo, "--reviewer", "--mode", "file", "--file", "drop.lua", "--line", "2"], { env: cleanEnv(home), encoding: "utf8", windowsHide: true });
  expect(out.stdout).toContain("已请求 AMO Reviewer 打开 Review");
  const viewer = await windowAt(app, "reviewer.html#viewer");
  await expect(viewer.getByTestId("viewer-code").locator('[data-line="new:2"]')).toContainText("return rate");
  await expect(viewer.getByRole("button", { name: /书签/ })).toHaveCount(0);
  await screenshot(app, "reviewer", "R2-viewer", viewer, "viewer");
  await expectTitleBar(viewer, ".vw-head");
  await screenshot(app, "reviewer", "titlebar-viewer-light", viewer, "viewer");

  // 主题 (2026-10-29): the program's own, one button in Git Review's head (浅色 → 深色 → 跟随系统); every window follows
  // (Playwright's pretend-light system switched off, so the pages see the one the program sets).
  const theme = review.getByTestId("review-theme");
  await expect(theme).toHaveText("浅色");
  await viewer.emulateMedia({ colorScheme: null });
  const viewerBg = () => viewer.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBg = await viewerBg();
  await theme.click();
  await expect(theme).toHaveText("深色");
  await expect.poll(() => app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  await expect.poll(viewerBg).not.toBe(lightBg);
  expect(JSON.parse(readFileSync(join(home, "theme.json"), "utf8"))).toEqual({ theme: "dark" });
  await screenshot(app, "reviewer", "R3-viewer-dark", viewer, "viewer");
  await screenshot(app, "reviewer", "titlebar-viewer-dark", viewer, "viewer");
  await review.emulateMedia({ colorScheme: null });
  await expect.poll(() => review.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(await viewerBg());
  await screenshot(app, "reviewer", "titlebar-review-dark", review, "review");
  await theme.click();
  await expect(theme).toHaveText("跟随系统");
  await theme.click();
  await expect(theme).toHaveText("浅色");

  // The viewer's × closes that window; Git Review stays.
  const closed = viewer.waitForEvent("close");
  await viewer.getByTestId("win-controls").getByRole("button", { name: "关闭" }).click();
  await closed;
  await expect(review.getByTestId("win-controls")).toBeVisible();
});
