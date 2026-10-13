import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { OpenInApps, OpenInResult, Session, Task, Workspace } from "@amo-studio/protocol";
import { DEMO_FILE, DEMO_FILE_TEXT } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// S12-C: files in the conversation. Names in a reply, tool rows and file chips become links when the file exists; a
// click opens the quick look beside the conversation, Ctrl+click VS Code, a right click the file menu; a finished turn
// lists the files it changed and shows each one's diff. Test mode records VS Code / Explorer launches (dryRun).

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

async function approveUntilAnswered(page: Page, answer: string) {
  const deadline = Date.now() + 90_000;
  while (!(await page.getByTestId("msg-agent").filter({ hasText: answer }).count())) {
    if (Date.now() > deadline) throw new Error("the turn did not finish");
    const approve = page.getByTestId("approval").filter({ has: page.getByRole("button", { name: "批准" }) }).first();
    if (await approve.count()) await approve.getByRole("button", { name: "批准" }).click().catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

test("names of existing files in a reply open the quick look, VS Code and Explorer", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const dir = studio.workspace("alpha");
  writeFileSync(join(dir, DEMO_FILE), DEMO_FILE_TEXT);
  writeFileSync(join(dir, "README.md"), "# 导入器\n\n从接口拉数据，**失败时重试**。\n\n- `importer.py`：入口\n");
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

  // Click: the quick look beside the conversation, scrolled to line 4 and marking it, with colours.
  await links.first().click();
  const preview = page.getByTestId("file-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("file-preview-name")).toHaveText("importer.py:4");
  await expect(preview.getByTestId("file-preview-code")).toHaveAttribute("data-highlighted", "");
  await expect(preview.locator(".fp-row.marked")).toHaveAttribute("data-line", "4");
  await expect(preview.locator(".fp-row.marked")).toContainText("def fetch(url):");
  await expect(page.getByRole("complementary", { name: "批注" })).toHaveCount(0);
  await screenshot(app, "stage-12", "S12-C-quick-look", page);

  // VS Code at the line (when this machine has it), Explorer with the file selected.
  if (vscode) {
    const open = await nextOpenIn(page, () => preview.getByTestId("fp-vscode").click());
    expect(open.asked).toMatchObject({ path: join(dir, DEMO_FILE), app: "vscode", line: 4 });
    expect(open.result.dryRun).toBe(true);
  } else await expect(preview.getByTestId("fp-vscode")).toHaveCount(0);
  const reveal = await nextOpenIn(page, () => preview.getByRole("button", { name: "在资源管理器中显示" }).click());
  expect(reveal.asked).toMatchObject({ path: join(dir, DEMO_FILE), app: "explorer" });
  expect(reveal.result).toMatchObject({ app: "explorer", dryRun: true });

  // Esc closes it; the right column comes back.
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "批注" })).toBeVisible();

  // Ctrl+click goes straight to VS Code.
  if (vscode) {
    const open = await nextOpenIn(page, () => links.first().click({ modifiers: ["Control"] }));
    expect(open.asked).toMatchObject({ app: "vscode", line: 4 });
    await expect(preview).toHaveCount(0);
  }

  // Right click: the file menu. 快速查看 the README (linked at #L2): source first, marking line 2; then rendered.
  await links.last().click({ button: "right" });
  const menu = page.getByTestId("file-menu");
  await expect(menu.getByRole("menuitem")).toHaveText(vscode ? ["快速查看", "VS Code 打开", "在资源管理器中显示", "复制路径"] : ["快速查看", "在资源管理器中显示", "复制路径"]);
  await menu.getByRole("menuitem", { name: "快速查看" }).click();
  await expect(menu).toHaveCount(0);
  await expect(preview.getByTestId("file-preview-name")).toHaveText("README.md:2");
  await expect(preview.locator(".fp-row.marked")).toHaveAttribute("data-line", "2");
  await preview.getByRole("button", { name: "渲染" }).click();
  await expect(preview.locator(".fp-md strong")).toHaveText("失败时重试");
  await screenshot(app, "stage-12", "S12-C-markdown", page);

  // The header: the working directory with Explorer (and VS Code) next to it.
  const workdir = page.getByTestId("workdir");
  await expect(workdir).toBeVisible();
  const folder = await nextOpenIn(page, () => workdir.getByRole("button", { name: "在资源管理器中显示" }).click());
  expect(folder.asked).toMatchObject({ path: ws.path, app: "explorer" });
  if (vscode) await expect(workdir.getByRole("button", { name: "VS Code 打开文件夹" })).toBeVisible();

  // The chip in the person's message opens the same quick look.
  await chip.click();
  await expect(preview.getByTestId("file-preview-name")).toHaveText("README.md");
  await preview.getByRole("button", { name: "关闭预览" }).click();
  await expect(preview).toHaveCount(0);
});

test("a finished turn lists the files it changed; each opens its diff, then the file", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  const dir = studio.workspace("alpha");
  writeFileSync(join(dir, DEMO_FILE), DEMO_FILE_TEXT);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await studio.api("POST", "/api/tasks", { title: "导入重试", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[demo]] 给导入器加上重试" } });
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

  // The work rows: the read row's file name and the diff card's header are links too.
  await turn.getByTestId("turn-fold").click();
  await turn.getByTestId("process-group").getByRole("button").first().click();
  const read = turn.locator('[data-testid="tool"][data-kind="read"]');
  await read.getByTestId("file-link").click();
  await expect(preview.getByTestId("file-preview-name")).toHaveText(DEMO_FILE);
  await expect(preview.getByTestId("file-preview-code")).toBeVisible();
  const edit = turn.locator('[data-testid="tool"][data-kind="edit"]');
  await edit.locator(".pr-title").click();
  await expect(edit.locator(".pr-diff-head").getByTestId("file-link")).toHaveText(DEMO_FILE);
  await screenshot(app, "stage-12", "S12-C-tool-rows", page);

  // The dark theme, with the turn's diff open again.
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("dialog", { name: "设置" }).getByRole("radio", { name: "深色" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
  await row.click();
  await expect(diff).toBeVisible();
  await screenshot(app, "stage-12", "S12-C-turn-changes-dark", page);
});
