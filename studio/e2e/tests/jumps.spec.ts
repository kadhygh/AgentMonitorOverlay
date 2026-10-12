import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("jumps between replies with the buttons and Alt+arrows", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "长对话",
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await page.getByTestId("task-card").first().click();
  const replies = page.getByTestId("msg-agent");
  await expect(replies).toHaveCount(1, { timeout: 30_000 });
  for (const n of [2, 3]) {
    await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
    await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "[[markdown]]" });
    await expect(replies).toHaveCount(n, { timeout: 30_000 });
    await expect(replies.nth(n - 1).locator("table.md-table")).toBeVisible({ timeout: 30_000 });
  }

  const thread = page.getByTestId("thread");
  const position = page.getByTestId("reply-position");
  await thread.evaluate((el) => (el.scrollTop = 0));
  await expect(position).toHaveText("1 / 3");

  await page.getByRole("button", { name: "下一条回复" }).click();
  await expect(position).toHaveText("2 / 3");
  await expect(replies.nth(1)).toHaveClass(/md-flash/);

  await page.keyboard.press("Alt+ArrowDown");
  await expect(position).toHaveText("3 / 3");
  await expect(replies.nth(2)).toHaveClass(/md-flash/);
  await screenshot(studio.app, "stage-2", "S2-06-jumps", page);

  await page.getByRole("button", { name: "上一条回复" }).click();
  await expect(position).toHaveText("2 / 3");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(position).toHaveText("1 / 3");
  await expect(replies.nth(0)).toHaveClass(/md-flash/);
});
