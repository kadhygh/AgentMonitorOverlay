import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { OpenInApps, OpenInResult, Session, Task, Workspace } from "@amo-studio/protocol";
import { DEMO_FILE, DEMO_FILE_TEXT } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio, confirmBookmarkNote } from "../support/studio.js";

// S12-C: files in the conversation. Names in a reply, tool rows and file chips become links when the file exists. Stage
// 13 (S13-A): a click opens the viewer window (查看器: one preview window, reused until 固定), Ctrl+click VS Code, a
// right click the file menu (查看器打开 / 右栏快速查看 / 用 git diff 看 / … / 标记); a finished turn lists the files it
// changed and shows each one's diff in the quick look. Test mode records VS Code / Explorer launches (dryRun).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

/** The next open-in request: what was asked and what the Host answered. */
async function nextOpenIn(page: Page, act: () => Promise<void>): Promise<{ asked: { path: string; app: string; line?: number }; result: OpenInResult }> {
  const response = page.waitForResponse((r) => r.url().includes("/api/open-in") && r.request().method() === "POST");
  await act();
  const r = await response;
  return { asked: r.request().postDataJSON() as { path: string; app: string; line?: number }, result: (await r.json()) as OpenInResult };
}

/** The next window the app opens (a viewer, a review), once loaded. */
async function nextWindow(app: ElectronApplication, act: () => Promise<void>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await act();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

const viewers = (app: ElectronApplication) => app.windows().filter((w) => w.url().includes("#viewer"));

test("a web page named in the conversation opens in the browser on a click; the viewer stays on the menu (2026-10-26)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const dir = studio.workspace("alpha");
  writeFileSync(join(dir, "report.html"), "<!doctype html><title>报告</title><p>进度</p>\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "看报告",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: `看一下这份\n\n引用文件：\n- ${join(dir, "report.html")}` },
  });
  await page.getByTestId("task-card").first().click();
  const chip = page.getByTestId("msg-user").getByTestId("msg-file");
  await expect(chip).toHaveAttribute("data-file-link", "", { timeout: 30_000 });
  const open = await nextOpenIn(page, () => chip.click());
  expect(open.asked).toMatchObject({ path: join(dir, "report.html"), app: "default" });
  expect(open.result).toMatchObject({ app: "default", dryRun: true });
  await chip.click({ button: "right" });
  const menu = page.getByTestId("file-menu");
  await expect(menu.getByRole("menuitem").first()).toHaveText("浏览器打开");
  await expect(menu.getByRole("menuitem", { name: "查看器打开" })).toBeVisible();
});

async function approveUntilAnswered(page: Page, answer: string) {
  const deadline = Date.now() + 90_000;
  while (!(await page.getByTestId("msg-agent").filter({ hasText: answer }).count())) {
    if (Date.now() > deadline) throw new Error("the turn did not finish");
    const approve = page.getByTestId("approval").filter({ has: page.getByRole("button", { name: "批准" }) }).first();
    if (await approve.count()) await approve.getByRole("button", { name: "批准" }).click().catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

test("names of existing files in a reply open the viewer, the quick look, VS Code and Explorer", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const dir = studio.workspace("alpha");
  writeFileSync(join(dir, DEMO_FILE), DEMO_FILE_TEXT);
  writeFileSync(join(dir, "README.md"), "# 导入器\n\n从接口拉数据，**失败时重试**。\n\n- `importer.py`：入口\n- 接口文档见 [API 说明](https://example.com/api)\n\n> 重试间隔用 *指数退避*。\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { vscode } = await studio.api<OpenInApps>("GET", "/api/open-in/apps");
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "看文件",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: `[[files]] 入口在哪\n\n引用文件：\n- ${join(dir, "README.md")}` },
  });
  await page.getByTestId("task-card").first().click();
  const reply = page.getByTestId("msg-agent").filter({ hasText: "入口在" });
  await expect(reply).toBeVisible({ timeout: 60_000 });

  // Only names of files that exist are links: importer.py:4 and the README link, not missing/nope.ts or the command.
  const links = reply.getByTestId("file-link");
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveText("importer.py:4");
  await expect(links.first()).toHaveAttribute("data-path", join(dir, DEMO_FILE));
  await expect(reply.locator("code", { hasText: "missing/nope.ts" })).toBeVisible();
  // The code block is coloured.
  await expect(reply.locator(".md-pre span[style]").first()).toBeVisible();

  // The person's file chip is a link too.
  const chip = page.getByTestId("msg-user").getByTestId("msg-file");
  await expect(chip).toHaveAttribute("data-file-link", "");

  // Click: the viewer window, scrolled to line 4 and marking it, with colours; the conversation keeps its right column.
  const viewer = await nextWindow(app, () => links.first().click());
  await expect(viewer.getByTestId("viewer-name")).toHaveText(DEMO_FILE);
  await expect(viewer.getByTestId("viewer-lines")).toHaveText("第 4 行");
  await expect(viewer.getByTestId("viewer-code")).toHaveAttribute("data-highlighted", "");
  await expect(viewer.locator(".gr-line.marked")).toHaveAttribute("data-line", "new:4");
  await expect(viewer.locator(".gr-line.marked")).toContainText("def fetch(url):");
  await expect(page.getByTestId("file-preview")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "批注" })).toBeVisible();
  await screenshot(app, "stage-13", "S13-A-viewer-code", viewer, "viewer");

  // VS Code at the line (when this machine has it), Explorer with the file selected; 标记 marks it.
  if (vscode) {
    const open = await nextOpenIn(viewer, () => viewer.getByTestId("viewer-vscode").click());
    expect(open.asked).toMatchObject({ path: join(dir, DEMO_FILE), app: "vscode", line: 4 });
    expect(open.result.dryRun).toBe(true);
  } else await expect(viewer.getByTestId("viewer-vscode")).toHaveCount(0);
  const reveal = await nextOpenIn(viewer, () => viewer.getByTestId("viewer-reveal").click());
  expect(reveal.asked).toMatchObject({ path: join(dir, DEMO_FILE), app: "explorer" });
  expect(reveal.result).toMatchObject({ app: "explorer", dryRun: true });
  await viewer.getByTestId("mark-file").click();
  await confirmBookmarkNote(viewer, "demo 的入口");
  await expect(viewer.getByTestId("toast")).toContainText("书签添加成功");
  await expect(viewer.getByTestId("mark-file")).toHaveText("已加书签");

  // The README link (#L2) goes to the same window: the source with line 2 marked, then rendered.
  await links.last().click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("README.md");
  await expect(viewer.locator(".gr-line.marked")).toHaveAttribute("data-line", "new:2");
  await viewer.getByRole("button", { name: "渲染" }).click();
  await expect(viewer.locator(".fp-md strong")).toHaveText("失败时重试");
  await expect(viewer.locator(".fp-md .md-link")).toHaveText("API 说明");
  expect(viewers(app)).toHaveLength(1);
  await screenshot(app, "stage-13", "S13-A-viewer-markdown", viewer, "viewer");

  // 固定: that window stays as it is, and the next file opens in a new preview window, which the chip then reuses.
  await viewer.getByTestId("viewer-pin").click();
  await expect(viewer.getByTestId("viewer-pin")).toHaveText("已固定");
  const second = await nextWindow(app, () => links.first().click());
  await expect(second.getByTestId("viewer-name")).toHaveText(DEMO_FILE);
  await expect(second.getByTestId("viewer-pin")).toHaveText("固定");
  await chip.click();
  await expect(second.getByTestId("viewer-name")).toHaveText("README.md");
  await expect(viewer.getByTestId("viewer-name")).toHaveText("README.md");
  await expect(viewer.locator(".fp-md strong")).toBeVisible();
  expect(viewers(app)).toHaveLength(2);

  // Ctrl+click goes straight to VS Code.
  if (vscode) {
    const open = await nextOpenIn(page, () => links.first().click({ modifiers: ["Control"] }));
    expect(open.asked).toMatchObject({ app: "vscode", line: 4 });
  }

  // Right click: the file menu. 右栏快速查看 the README (linked at #L2): source first, marking line 2; then rendered.
  await links.last().click({ button: "right" });
  const menu = page.getByTestId("file-menu");
  const items = ["查看器打开", "右栏快速查看", "用 git diff 看", ...(vscode ? ["VS Code 打开"] : []), "在资源管理器中显示", "复制路径", "加书签"];
  await expect(menu.getByRole("menuitem")).toHaveText(items);
  await screenshot(app, "stage-13", "S13-A-file-menu", page);
  await menu.getByRole("menuitem", { name: "右栏快速查看" }).click();
  await expect(menu).toHaveCount(0);
  const preview = page.getByTestId("file-preview");
  await expect(preview.getByTestId("file-preview-name")).toHaveText("README.md:2");
  await expect(preview.locator(".fp-row.marked")).toHaveAttribute("data-line", "2");
  await expect(page.getByRole("complementary", { name: "批注" })).toHaveCount(0);
  await preview.getByRole("button", { name: "渲染" }).click();
  await expect(preview.locator(".fp-md strong")).toHaveText("失败时重试");
  // 标记 from the quick look: marks the file at the line; then "已标记" (accent).
  await preview.getByTestId("mark-file").click();
  await confirmBookmarkNote(page);
  await expect(preview.getByTestId("mark-file")).toHaveText("已加书签");
  await expect(preview.getByTestId("mark-file")).toHaveAttribute("data-marked", "");

  // Esc closes it; the right column comes back.
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "批注" })).toBeVisible();

  // The header: the working directory with Explorer (and VS Code) next to it.
  const workdir = page.getByTestId("workdir");
  await expect(workdir).toBeVisible();
  const folder = await nextOpenIn(page, () => workdir.getByRole("button", { name: "在资源管理器中显示" }).click());
  expect(folder.asked).toMatchObject({ path: ws.path, app: "explorer" });
  if (vscode) await expect(workdir.getByRole("button", { name: "VS Code 打开文件夹" })).toBeVisible();
});

test("a finished turn lists the files it changed; each opens its diff, then the file; 用 git diff 看", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  const dir = studio.workspace("alpha");
  writeFileSync(join(dir, DEMO_FILE), DEMO_FILE_TEXT);
  writeFileSync(join(dir, "notes.md"), "# 笔记\n\n没有改动的文件。\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await studio.api("POST", "/api/tasks", {
    title: "导入重试",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: `[[demo]] 给导入器加上重试\n\n引用文件：\n- ${join(dir, "notes.md")}` },
  });
  await page.getByTestId("task-card").first().click();
  await approveUntilAnswered(page, "retries");

  const turn = page.getByTestId("turn").last();
  const changes = turn.getByTestId("turn-changes");
  await expect(changes).toBeVisible();
  await expect(changes).toContainText("改动了 1 个文件");
  const row = changes.getByTestId("turn-change");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(DEMO_FILE);
  await expect(row).toContainText("+12");
  await expect(changes.getByTestId("turn-changes-review")).toHaveText("在 Review 里看");

  // The turn's diff in the quick look; a click on 打开文件 shows the file as it is now (patched).
  await row.click();
  const preview = page.getByTestId("file-preview");
  const diff = preview.getByTestId("file-preview-diff");
  await expect(diff).toBeVisible();
  await expect(diff.locator(".fp-diff-row.add").first()).toBeVisible();
  await expect(diff).toContainText("retries=3");
  await screenshot(app, "stage-12", "S12-C-turn-changes", page);
  await preview.getByRole("button", { name: "打开文件" }).click();
  await expect(preview.getByTestId("file-preview-code")).toContainText("def fetch(url, retries=3, backoff=0.5):");
  await preview.getByRole("button", { name: "本轮改动" }).click();
  await expect(diff).toBeVisible();

  // The work rows: the read row's file name opens the viewer; the diff card's header is a link too.
  await turn.getByTestId("turn-fold").click();
  await turn.getByTestId("process-group").getByRole("button").first().click();
  const read = turn.locator('[data-testid="tool"][data-kind="read"]');
  const viewer = await nextWindow(app, () => read.getByTestId("file-link").click());
  await expect(viewer.getByTestId("viewer-name")).toHaveText(DEMO_FILE);
  await expect(viewer.getByTestId("viewer-code")).toContainText("def fetch(url, retries=3, backoff=0.5):");
  const edit = turn.locator('[data-testid="tool"][data-kind="edit"]');
  await edit.locator(".pr-title").click();
  await expect(edit.locator(".pr-diff-head").getByTestId("file-link")).toHaveText(DEMO_FILE);
  await screenshot(app, "stage-12", "S12-C-tool-rows", page);

  // The viewer's 改动 mode: the project's Git Review inside the window, at this file.
  await viewer.getByTestId("viewer-mode-changes").click();
  await expect(viewer.getByTestId("review-file-head")).toContainText(DEMO_FILE);
  await expect(viewer.locator(".gr-line.add").filter({ hasText: "retries=3" }).first()).toBeVisible();
  await screenshot(app, "stage-13", "S13-A-viewer-changes", viewer, "viewer");
  await viewer.getByTestId("viewer-mode-file").click();
  await expect(viewer.getByTestId("viewer-code")).toBeVisible();

  // 用 git diff 看 (right click): the project's Review window, at the file.
  await read.getByTestId("file-link").click({ button: "right" });
  const review = await nextWindow(app, () => page.getByTestId("file-menu").getByRole("menuitem", { name: "用 git diff 看" }).click());
  await expect(review.getByTestId("review-file-head")).toContainText(DEMO_FILE);
  // A file without uncommitted changes (the person's chip, notes.md): the same window says so.
  await page.getByTestId("msg-user").getByTestId("msg-file").click({ button: "right" });
  await page.getByTestId("file-menu").getByRole("menuitem", { name: "用 git diff 看" }).click();
  await expect(review.getByTestId("toast")).toHaveText(/这个文件没有未提交的改动/);
  await expect(review.getByTestId("review-file-head")).toContainText(DEMO_FILE);
  // Review's 查看文件 opens the viewer at the file.
  await review.getByTestId("review-open-viewer").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText(DEMO_FILE);

  // The dark theme, with the turn's diff open again.
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("dialog", { name: "设置" }).getByRole("radio", { name: "深色" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
  await row.click();
  await expect(diff).toBeVisible();
  await screenshot(app, "stage-12", "S12-C-turn-changes-dark", page);
});
