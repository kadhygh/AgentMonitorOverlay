import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, longTurn, screenshot, showMainWindow, type Studio } from "../support/studio.js";

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
    workspaceId: ws.id,
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

test("jumps up reply by reply through long turns not drawn yet, each landing on its reply (2026-10-20)", async () => {
  // Shown and folded as for a person: the turns above are drawn only as the jumps bring them into view (chat.css).
  // Before: the fourth jump up ended 2,900px off and the next went nowhere.
  studio = await launchStudio({ transcriptView: "standard" });
  const { app, page } = studio;
  await showMainWindow(app);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "长对话",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: longTurn(1) },
  });
  await page.getByTestId("task-card").first().click();
  const replies = page.getByTestId("msg-agent");
  await expect(replies).toHaveCount(1, { timeout: 30_000 });
  for (let n = 2; n <= 9; n++) {
    await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: longTurn(n) });
    await expect(replies).toHaveCount(n, { timeout: 30_000 });
  }
  // Opened anew from the board: none of its turns drawn.
  await page.getByRole("button", { name: /返回看板|看板/ }).first().click();
  await page.getByTestId("task-card").first().click();
  const thread = page.getByTestId("thread");
  await expect.poll(() => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(40);

  const position = page.getByTestId("reply-position");
  const topOf = (i: number) => replies.nth(i).evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest(".thread")!.getBoundingClientRect().top));
  // The first ↑ goes to the top of the last reply (it is long), then one reply up each time.
  for (const at of [9, 8, 7, 6, 5, 4, 3]) {
    await page.keyboard.press("Alt+ArrowUp");
    await expect(position).toHaveText(`${at} / 9`);
    // Its top just below the top of the view, and still there once the turns around it are drawn.
    await expect.poll(() => topOf(at - 1)).toBeLessThan(40);
    await page.waitForTimeout(400);
    const top = await topOf(at - 1);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(40);
  }
});
