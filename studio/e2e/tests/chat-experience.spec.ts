import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { DEMO_FILE, DEMO_FILE_TEXT } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// The conversation as in DSH (stage 9): a turn's thinking and tool calls fold into one line once it is done,
// the answer stays, the footer has copy / time / usage; work rows open into terminal output and diffs.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** Approves whatever the running turn asks for until its answer is in. */
async function approveUntilAnswered(page: Page, answer: string) {
  const deadline = Date.now() + 90_000;
  while (!(await page.getByTestId("msg-agent").filter({ hasText: answer }).count())) {
    if (Date.now() > deadline) throw new Error("the turn did not finish");
    const approve = page.getByTestId("approval").filter({ has: page.getByRole("button", { name: "批准" }) }).first();
    if (await approve.count()) await approve.getByRole("button", { name: "批准" }).click().catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

test("a working turn folds into one line and opens into thinking, commands and diffs", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  const dir = studio.workspace("alpha");
  writeFileSync(join(dir, DEMO_FILE), DEMO_FILE_TEXT);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "导入重试",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[demo]] 给导入器加上重试" },
  });
  await page.getByTestId("task-card").first().click();

  // While it waits for an approval: the work so far, the approval card, the live status line.
  const card = page.getByTestId("approval").first();
  await expect(card).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  await expect(page.getByTestId("run-status")).toContainText("等待你的确认");
  await screenshot(app, "stage-9", "chat-approval", page);
  await approveUntilAnswered(page, "retries");

  // Done: the person's bubble, one fold line with the duration, the answer, the footer.
  const turn = page.getByTestId("turn").last();
  await expect(turn.getByTestId("msg-user")).toHaveText("[[demo]] 给导入器加上重试");
  const fold = turn.getByTestId("turn-fold");
  await expect(fold).toHaveText(/^已完成，用时 \d+秒/);
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(turn.getByTestId("tool")).toHaveCount(0);
  await expect(turn.getByTestId("msg-agent").locator("table")).toBeVisible();
  await expect(turn.getByTestId("turn-foot").getByRole("button", { name: /^用量 / })).toBeVisible();
  await expect(page.getByTestId("composer-stats")).toContainText("1 轮 3 步");
  await expect(page.getByTestId("run-status")).toHaveCount(0);
  await screenshot(app, "stage-9", "chat-folded", page);

  // Unfold: one group named after its work; open it, then a command and the edit.
  await fold.click();
  const group = turn.getByTestId("process-group");
  await expect(group).toHaveCount(1);
  await expect(group.getByRole("button").first()).toHaveText("已读取文件，修改了文件，执行了命令");
  await group.getByRole("button").first().click();
  await expect(group.getByTestId("reasoning").first()).toContainText("已思考");
  await expect(group.getByTestId("reasoning").first()).toContainText("用户想给导入器加上失败重试。");
  const read = group.locator('[data-testid="tool"][data-kind="read"]');
  await expect(read).toContainText("读取");
  await expect(read).toContainText(DEMO_FILE);
  const edit = group.locator('[data-testid="tool"][data-kind="edit"]');
  await expect(edit).toContainText("+12");
  await edit.getByRole("button").first().click();
  await expect(edit.locator(".pr-diff-line.add").first()).toBeVisible();
  const command = group.locator('[data-testid="tool"][data-kind="command"]');
  await command.getByRole("button").first().click();
  await expect(command.locator(".pr-term-out")).toContainText("3 passed");
  await expect(command.locator(".pr-term-foot")).toContainText("退出码 0");
  await group.getByTestId("reasoning").first().getByRole("button").click();
  await screenshot(app, "stage-9", "chat-expanded", page);

  // Usage of the turn.
  await turn.getByTestId("turn-foot").getByRole("button", { name: /^用量 / }).click();
  await expect(page.getByRole("dialog", { name: "本轮用量" })).toContainText("缓存命中");
  await screenshot(app, "stage-9", "chat-usage", page);
  await page.keyboard.press("Escape");

  // The light theme, folded again.
  await fold.click();
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("radio", { name: "浅色" }).click();
  await page.keyboard.press("Escape");
  await screenshot(app, "stage-9", "chat-folded-light", page);

  // 完全展开: every row shown, the fold line only states the duration.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("radio", { name: "完全展开" }).click();
  await dialog.getByRole("radio", { name: "深色" }).click();
  await page.keyboard.press("Escape");
  await expect(fold).not.toHaveAttribute("aria-expanded", /.+/);
  await expect(turn.getByTestId("tool")).toHaveCount(3);
  await expect(turn.getByTestId("process-group")).toHaveCount(1);
  await screenshot(app, "stage-9", "chat-verbose", page);
});

test("Claude thinking shows as its own row", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "思考", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "[[think]] hi" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: [[think]] hi", { timeout: 60_000 });
  // The finished turn is folded; its work holds the thought.
  await page.getByTestId("turn-fold").click();
  const thinking = page.getByTestId("reasoning");
  await expect(thinking).toContainText(/已思考/);
  await expect(thinking).toContainText("先想一想用户要什么。");
  await expect(page.getByTestId("turn-fold")).toHaveText(/^已完成/);
  await thinking.getByRole("button").click();
  await expect(thinking.locator(".pr-think-body")).toContainText("这是一条测试消息");
});
