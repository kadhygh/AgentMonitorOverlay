import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTaskWithReply(s: Studio) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "整理导入流程",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "先看看现状" },
  });
  await s.page.getByTestId("task-card").filter({ hasText: "整理导入流程" }).click();
  await expect(s.page.getByTestId("task-title")).toHaveText("整理导入流程");
  await expect(s.page.getByTestId("msg-agent")).toContainText("MOCK: 先看看现状", { timeout: 30_000 });
  return created;
}

test("task page: column, fork, new session, terminal and archive", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { task } = await openTaskWithReply(studio);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(1);
  // 仅工作台 is the usual writer and is not shown.
  await expect(page.getByTestId("writer")).toHaveCount(0);

  // Task status is set by the person and moves the card: the status under the title opens a small menu.
  await page.getByTestId("task-status").click();
  await page.getByTestId("status-review").click();
  await expect(page.getByTestId("task-status")).toHaveText("待审阅");
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).tasks[0]!.column).toBe("review");

  // Fork: indented under its parent, same model, and selected afterwards.
  await page.getByRole("button", { name: "分支", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-kind", "fork");
  await expect(rows.nth(1)).toHaveAttribute("data-depth", "1");
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(1)).toContainText("分支 · Mock Model");

  // A second independent session in the same task.
  await page.getByTestId("new-session-toggle").click();
  await page.getByRole("button", { name: "开始新会话" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toHaveAttribute("data-depth", "0");

  // Open in terminal: test mode records the launch instead of opening a window.
  await rows.first().click();
  await page.getByRole("button", { name: "在终端打开" }).click();
  await expect(page.getByTestId("toast")).toContainText("已在新终端窗口接入同一会话");
  await expect(page.getByTestId("toast").locator("code")).toHaveText(/^codex --remote ws:\/\/127\.0\.0\.1:\d+ --remote-auth-token-env AMO_STUDIO_CODEX_TOKEN resume \S+$/);
  await expect(page.getByTestId("writer")).toHaveText("终端已接入 · 共享");
  await expect(rows.first()).toContainText("终端");
  await screenshot(studio.app, "stage-1", "S1-11a-task-page", page);

  // Archive the main session: its fork goes with it; restore brings both back.
  await page.getByTestId("session-more").click();
  await page.getByTestId("session-archive").click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: /已归档 1/ }).click();
  await expect(page.getByTestId("archived-row")).toHaveCount(1);
  await page.getByTestId("archived-row").hover();
  await page.getByTestId("archived-row").getByRole("button", { name: "查看" }).click();
  await expect(page.getByTestId("session-archived-banner")).toContainText("已归档 · 只读");
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 先看看现状");
  await page.getByTestId("archived-row").hover();
  await page.getByTestId("archived-row").getByRole("button", { name: "恢复", exact: true }).click();
  await expect(rows).toHaveCount(3);
  const sessions = (await studio.api<StateSnapshot>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id);
  expect(sessions.every((s) => !s.archivedAt)).toBe(true);
});
