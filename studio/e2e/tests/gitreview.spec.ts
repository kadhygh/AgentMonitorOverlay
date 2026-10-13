import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

// S11-D acceptance: a project under git → Review from the task page → file list and both diff views → a comment on
// a line → "发给会话" → the session receives the summary. The window is reused per project; folders without git
// cannot be reviewed.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

/** A repository with a feature branch (one commit) and working changes: a modified CRLF file, a deleted and an untracked one. */
function makeRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), ["local M = {}", "M.rate = 0.1", "M.boss = 'Lv20'", "M.items = { 'sword', 'shield' }", "M.gold = 100", "M.exp = 50", "M.limit = 3", "M.note = 'base'", "return M", ""].join("\r\n"));
  writeFileSync(join(dir, "old.txt"), "to be removed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "feature.lua"), "return { on = true }\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "feature");
  writeFileSync(join(dir, "drop.lua"), ["local M = {}", "M.rate = 0.25", "M.items = { 'sword', 'shield' }", "M.gold = 100", "M.exp = 50", "M.limit = 3", "M.note = 'base'", "return M", "-- tuned", ""].join("\r\n"));
  git(dir, "rm", "-q", "old.txt");
  writeFileSync(join(dir, "notes.md"), "# 调整说明\n\n概率提高\n");
}

test("review a project's changes, comment a line and send it to the session", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("game");
  makeRepo(dir);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const plain = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("plain") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "调整掉落",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "调掉落概率" },
  });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 调掉落概率", { timeout: 30_000 });

  // Open from the task: a window of its own, off-screen and never focused in tests.
  const opened = app.waitForEvent("window");
  await page.getByTestId("task-review").click();
  const review = await opened;
  await review.waitForLoadState("domcontentloaded");
  expect(review.url()).toContain(`#review?workspace=${ws.id}&session=${session.id}`);
  await expect.poll(() => windowState(app, "review")).toMatchObject({ visible: true, onScreen: false, anyFocused: false });
  await expect(review.getByTestId("review-branch")).toHaveText("feature");

  // 工作区改动: modified, deleted and untracked files with their counts.
  const files = review.getByTestId("review-file");
  await expect(files).toHaveCount(3);
  await expect(files.nth(0)).toContainText("drop.lua");
  await expect(files.nth(0)).toContainText("+2 −2");
  await expect(files.nth(1)).toContainText("notes.md");
  await expect(files.nth(2)).toContainText("old.txt");
  await expect(files.nth(2)).toContainText("D");

  // 只看改动 shows the hunk; 完整文件 the whole file with its deleted line in place.
  await expect(review.getByTestId("review-file-head")).toContainText("drop.lua");
  await expect(review.getByTestId("diff-hunk")).toHaveCount(1);
  await expect(review.locator('[data-line="new:2"]')).toContainText("M.rate = 0.25");
  await expect(review.locator('[data-line="old:3"]')).toContainText("M.boss = 'Lv20'");
  await review.getByRole("button", { name: "完整文件" }).click();
  await expect(review.getByTestId("diff-hunk")).toHaveCount(0);
  await expect(review.getByTestId("diff-line")).toHaveCount(11);

  // Comment the changed line; it shows under the line and can be edited.
  await review.locator('[data-line="new:2"]').hover();
  await review.locator('[data-line="new:2"]').getByTestId("add-comment").click();
  await review.getByTestId("comment-draft").getByLabel("批注内容").fill("概率太高，先改成 0.15");
  await review.getByTestId("comment-draft").getByRole("button", { name: "保存" }).click();
  const comments = review.getByTestId("review-comment");
  await expect(comments).toHaveCount(1);
  await expect(comments.first()).toContainText("概率太高");
  await comments.first().getByRole("button", { name: "编辑" }).click();
  await review.getByLabel("修改批注").fill("概率太高，先改成 0.15，再看留存");
  await review.getByRole("button", { name: "保存" }).click();
  await expect(comments.first()).toContainText("再看留存");
  // A second one on a deleted line, then j / n move between files and changes.
  await review.locator('[data-line="old:3"]').hover();
  await review.locator('[data-line="old:3"]').getByTestId("add-comment").click();
  await review.getByLabel("批注内容").fill("Boss 掉落为什么删掉");
  await review.getByLabel("批注内容").press("Control+Enter");
  await expect(comments).toHaveCount(2);
  await expect(review.getByTestId("review-draft-count")).toHaveText("草稿批注 2 条");
  await expect(files.nth(0).locator(".gr-badge")).toHaveText("2");
  await screenshot(app, "stage-11", "S11-D-review-full", review, "review");
  await review.locator("body").press("n");
  await expect(review.locator(".gr-line.active")).toHaveCount(1);
  await review.locator("body").press("j");
  await expect(review.getByTestId("review-file-head")).toContainText("notes.md");
  await review.locator("body").press("k");
  await expect(review.getByTestId("review-file-head")).toContainText("drop.lua");
  await expect(review.getByTestId("diff-line")).toHaveCount(11);

  // 本分支全部 adds the branch's commit.
  await review.getByRole("button", { name: "本分支全部" }).click();
  await expect(files).toHaveCount(4);
  await expect(files.filter({ hasText: "feature.lua" })).toHaveCount(1);
  await expect(review.getByTestId("review-branch")).toContainText("对比 main");
  await review.getByRole("button", { name: "只看改动" }).click();
  await screenshot(app, "stage-11", "S11-D-review-branch", review, "review");

  // Send: the task's session is picked already.
  await expect(review.getByTestId("review-session")).toHaveValue(session.id);
  await review.getByTestId("review-send").click();
  await expect(review.getByTestId("toast")).toContainText("已把 2 条批注发给");
  await expect(review.getByTestId("review-draft-count")).toHaveText("草稿批注 0 条");
  await expect(comments).toHaveCount(0);
  await review.getByText("显示已发送（2）").click();
  await expect(comments).toHaveCount(2);

  const summary = page.getByTestId("msg-user").filter({ hasText: "Git Review 批注" });
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).toContainText("drop.lua:2");
  await expect(summary).toContainText("M.rate = 0.25");
  await expect(summary).toContainText("再看留存");
  await expect(summary).toContainText("drop.lua（旧版第 3 行，已删除）");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: Git Review 批注", { timeout: 30_000 });

  // The session header opens the same window again (one per project), pointed at that session.
  const windows = app.windows().length;
  await page.getByTestId("session-review").click();
  await expect.poll(() => review.url()).toContain(`session=${session.id}`);
  expect(app.windows().length).toBe(windows);
  await review.close();
  await screenshot(app, "stage-11", "S11-D-sent", page);

  // The left column: a project under git offers Git Review, a plain folder does not.
  await page.getByTestId("scope-ws-plain").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "项目" }).getByRole("menuitem")).toHaveText("Git Review（不是 git 仓库）");
  await expect(page.getByRole("menu", { name: "项目" }).getByRole("menuitem")).toBeDisabled();
  await page.keyboard.press("Escape");
  const reopened = app.waitForEvent("window");
  await page.getByTestId("scope-ws-game").click({ button: "right" });
  await page.getByRole("menu", { name: "项目" }).getByRole("menuitem", { name: "Git Review" }).click();
  const fromProject = await reopened;
  expect(fromProject.url()).toContain(`#review?workspace=${ws.id}`);
  expect(fromProject.url()).not.toContain("session=");
  await expect(fromProject.getByTestId("review-session")).toHaveValue("");
  await expect(fromProject.getByTestId("review-file")).toHaveCount(3);

  // A plain folder: the Host says why.
  expect((await studio.api<{ repo: boolean; reason?: string }>("GET", `/api/workspaces/${plain.id}/git/status`)).reason).toBe("不是 git 仓库");
});
