import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
