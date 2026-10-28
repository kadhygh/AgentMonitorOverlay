import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 外部打开 Review (2026-10-18): another tool runs amo-review (scripts/amo-review.mjs) while Studio is open; the main
// window opens the review window on the project, with a base or a range, and 发回 aimed at the given session.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "scripts", "amo-review.mjs");
const amoReview = (dataDir: string, ...args: string[]) => promisify(execFile)(process.execPath, [SCRIPT, ...args, "--data", dataDir], { encoding: "utf8", windowsHide: true });

async function nextWindow(app: ElectronApplication, act: () => Promise<unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await act();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

test("another tool opens Review on a folder: the working tree against a base, and a range", async () => {
  studio = await launchStudio();
  const { app, dataDir } = studio;
  const dir = studio.workspace("agent-work");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), "return 0.1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "agent");
  writeFileSync(join(dir, "boss.lua"), "return 'Lv20'\n");
  writeFileSync(join(dir, "alpha.lua"), "return 'first in list'\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "agent: boss");
  writeFileSync(join(dir, "drop.lua"), "return 0.25\n");

  // A session to send the comments to, in another project.
  const other = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("other") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "审阅 agent 的改动", workspaceId: other.id, firstSession: { profileId: "codex-mock", text: "hello" } });

  // The working tree against main: comments allowed, 发回 aimed at that session; the folder becomes a project.
  let out = "";
  const review = await nextWindow(app, async () => (out = (await amoReview(dataDir, dir, "--base", "main", "--session", session.id, "--file", "drop.lua")).stdout));
  expect(out).toContain("工作区对比 main");
  expect(out).toContain("新登记了这个项目");
  await expect(review.getByTestId("review-branch")).toContainText("对比 main");
  await expect(review.getByTestId("review-file")).toHaveCount(3);
  await expect(review.getByTestId("review-file").filter({ hasText: "drop.lua" })).toHaveAttribute("aria-current", /true|page/);
  await screenshot(app, "stage-18", "S18-review-open-base", review, "review");

  // A range: read-only, against the first ref.
  const ranged = await nextWindow(app, () => amoReview(dataDir, dir, "--range", "main..agent"));
  await expect(ranged.getByTestId("review-file")).toHaveText([/alpha\.lua/, /boss\.lua/]);
  await expect(ranged.getByTestId("review-commit-footer")).toContainText(`对比 ${git(dir, "rev-parse", "--short=7", "main")}`);

  // A committed file is selected too, even if it is not first in the range's list. Reuse that commit's window.
  await amoReview(dataDir, dir, "--range", "main..agent", "--file", "boss.lua");
  await expect(ranged.getByTestId("review-file").filter({ hasText: "boss.lua" })).toHaveAttribute("aria-current", /true|page/);

  // The already open working-tree review rereads a file saved again by the agent.
  writeFileSync(join(dir, "drop.lua"), "return 0.75 -- updated after review opened\n");
  await amoReview(dataDir, dir, "--base", "main", "--session", session.id, "--file", "drop.lua");
  await expect(review.getByTestId("review-file-head")).toContainText("drop.lua");
  await expect(review.locator(".gr-line.add")).toContainText("updated after review opened");
  writeFileSync(join(dir, "drop.lua"), "return 0.9 -- reopened whole project\n");
  await amoReview(dataDir, dir, "--base", "main");
  await expect(review.locator(".gr-line.add")).toContainText("reopened whole project");

  // A ref that is not there: refused, exit 1, nothing opened.
  const bad = await amoReview(dataDir, dir, "--commit", "nope").catch((e: { code: number; stderr: string }) => e);
  expect(bad).toMatchObject({ code: 1 });
  expect((bad as { stderr: string }).stderr).toContain("没有打开");
});

for (const profileId of ["claude-mock", "codex-mock"]) {
  test(`review_open from ${profileId}: file, lines, latest content and comments back to the caller`, async () => {
    studio = await launchStudio();
    const { app } = studio;
    const dir = studio.workspace("plain project");
    const file = "中文 file.ts";
    writeFileSync(join(dir, file), "const first = 1;\nconst second = 2;\nconst third = 3;\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
    const prompt = `[[mcp: review_open ${JSON.stringify({ mode: "file", file, line: 2, endLine: 3 })}]]`;
    let sessionId = "";
    const viewer = await nextWindow(app, async () => {
      const started = await studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
        title: "请打开文件审阅", workspaceId: ws.id, firstSession: { profileId, text: prompt },
      });
      sessionId = started.session.id;
    });
    // One file to look at is a 查看包 of one item (2026-10-23): the line range is its first mark.
    const code = viewer.getByTestId("viewer-code");
    await expect(viewer.getByTestId("viewpack-title")).toHaveText(file);
    await expect(code.locator(".gr-line.marked")).toHaveCount(2);
    await expect(code.locator('[data-line="new:2"]')).toContainText("second = 2");
    await code.locator('[data-line="new:2"] [data-testid="add-comment"]').click();
    await code.getByTestId("comment-draft").locator("textarea").fill("请再检查第二行");
    await code.getByTestId("comment-draft").locator("textarea").press("Control+Enter");

    // Reopen via CLI after an edit: one reused window, freshly read content, drafts still available.
    const before = app.windows().length;
    writeFileSync(join(dir, file), "const first = 1;\nconst second = 200;\nconst third = 3;\n");
    const result = await amoReview(studio.dataDir, dir, "--mode", "file", "--file", file, "--line", "2", "--end-line", "3", "--session", sessionId, "--json");
    expect(JSON.parse(result.stdout).target).toMatchObject({ mode: "file", line: 2, endLine: 3, sessionId });
    await expect(code.locator('[data-line="new:2"]')).toContainText("second = 200");
    await expect(code.getByTestId("review-comment")).toContainText("请再检查第二行");
    expect(app.windows()).toHaveLength(before);
    if (profileId === "claude-mock") await screenshot(app, "stage-18", "S18-review-mcp-file", viewer, "viewer");

    // 复制注释 (2026-10-23): the person pastes them back; nothing goes to the conversation by itself.
    await code.getByTestId("review-copy").click();
    await expect.poll(() => studio!.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1) ?? "")).toContain("请再检查第二行");
    expect(await studio!.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1) ?? "")).toContain(`${file}:2`);
    await expect.poll(async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.find((s) => s.id === sessionId)?.status).toBe("idle");
    // The model can also open the saved edits of that file as a diff (a 查看包's git item, in the same window), with
    // the same receiving conversation.
    await studio.api("POST", `/api/sessions/${sessionId}/messages`, { text: `[[mcp: review_open ${JSON.stringify({ file })}]]` });
    const changes = viewer.getByTestId("viewpack-git");
    await expect(changes.getByTestId("review-file-head")).toContainText(file);
    await expect(changes.locator(".gr-line.add")).toContainText("second = 200");
    expect(app.windows()).toHaveLength(before);
  });
}

test("review_open on a whole project opens Review; the conversation's row opens it again (2026-10-23)", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("proj");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  writeFileSync(join(dir, "a.txt"), "2\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const review = await nextWindow(app, () => studio!.api<{ task: Task }>("POST", "/api/tasks", { title: "看改动", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[mcp: review_open {}]]" } }));
  await expect(review.getByTestId("review-file")).toHaveCount(1);

  await review.close();

  await page.getByTestId("task-card").first().click();
  const again = page.getByTestId("tool-open-review");
  await expect(again).toBeVisible({ timeout: 30_000 });
  const reopened = await nextWindow(app, () => again.click());
  expect(reopened.url()).toContain(`#review?workspace=${ws.id}`);
  await expect(reopened.getByTestId("review-file")).toHaveCount(1);
});

test("amo-review says when AMO Studio is not running", async () => {
  const r = await promisify(execFile)(process.execPath, [SCRIPT, ".", "--data", join(HERE, "no-such-data")], { encoding: "utf8", windowsHide: true }).catch((e: { code: number; stderr: string }) => e);
  expect(r).toMatchObject({ code: 2 });
  expect((r as { stderr: string }).stderr).toContain("没有在运行");
});

test("Review's file menu opens a web page in the browser (2026-10-27)", async () => {
  studio = await launchStudio();
  const { app, dataDir } = studio;
  const dir = studio.workspace("pages");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "notes.md"), "# 记录\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "report.html"), "<!doctype html><title>报告</title><p>进度</p>\n");
  writeFileSync(join(dir, "notes.md"), "# 记录\n\n第二行\n");
  const review = await nextWindow(app, () => amoReview(dataDir, dir));
  const files = review.getByTestId("review-file");
  await expect(files).toHaveCount(2);
  const menu = review.getByRole("menu", { name: "文件" });
  await files.filter({ hasText: "notes.md" }).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "用浏览器打开" })).toHaveCount(0);
  await review.keyboard.press("Escape");
  await files.filter({ hasText: "report.html" }).click({ button: "right" });
  await expect(menu.getByRole("menuitem").first()).toHaveAccessibleName("在查看器中打开");
  const posted = review.waitForResponse((r) => r.url().endsWith("/api/open-in") && r.request().method() === "POST");
  await menu.getByRole("menuitem", { name: "用浏览器打开" }).click();
  const res = await posted;
  expect(res.request().postDataJSON()).toMatchObject({ path: "report.html", app: "default" });
  expect(await res.json()).toMatchObject({ app: "default", dryRun: true });
  await expect(menu).toHaveCount(0);
});
