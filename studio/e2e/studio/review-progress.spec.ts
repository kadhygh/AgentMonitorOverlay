import { expect, test, type Page } from "@playwright/test";
import type { ReviewProgress, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 审阅进度 (2026-11-16, 设置 → 测试功能 → 审阅进度; plans/review-progress.md): each AI reply of a conversation is 没看 /
// 浏览过 / 审过, kept by the Host. Quiet by default (a 审过 button only on long replies or ones with approvals, questions,
// changes; a tick on 审过 ones); 复盘 colours the ones not 审过, counts them and goes to the next one.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const theme = (page: Page, which: "light" | "dark") => page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), which);

test("replies are 没看 / 浏览过 / 审过: a 审过 button on the long one, 复盘 colours and counts the rest, and it is kept", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表复盘", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "先看一下掉落表" } });
  await page.getByTestId("task-card").first().click();
  const replies = page.getByTestId("msg-agent");
  await expect(replies).toHaveCount(1, { timeout: 30_000 });
  // The mock repeats the message: a long one gives a reply longer than the conversation's view.
  const long = Array.from({ length: 70 }, (_, i) => `第 ${i + 1} 张表：Boss_Lv${i + 1} 的掉落概率和为 1`).join("\n");
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: long });
  await expect(replies).toHaveCount(2, { timeout: 30_000 });
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "好的，收到" });
  await expect(replies).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });

  // Off: nothing of it on the page.
  await expect(page.getByTestId("turn-review")).toHaveCount(0);
  await expect(page.getByTestId("review-open")).toHaveCount(0);

  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["review-progress"] });
  await expect(page.getByTestId("turn-review")).toHaveCount(3, { timeout: 15_000 });
  const turns = page.getByTestId("turn");
  // Only the long reply has its 审过 button; the short ones show nothing.
  await expect(turns.nth(1).getByTestId("review-mark")).toBeVisible();
  await expect(turns.nth(0).getByTestId("review-mark")).toHaveCount(0);
  await expect(turns.nth(2).getByTestId("review-mark")).toHaveCount(0);
  await expect(page.getByTestId("review-open")).toBeVisible();
  const ids = await replies.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.itemId!));
  const marks = async () => (await studio!.api<ReviewProgress>("GET", `/api/sessions/${session.id}/review-progress`)).marks;

  // The last reply's end is on screen with the window in front: 浏览过 after a moment, by itself.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.focus());
  await expect.poll(async () => (await marks())[ids[2]!], { timeout: 15_000 }).toBe("seen");

  await turns.nth(1).getByTestId("review-mark").scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "review-progress-button", page);
  await turns.nth(1).getByTestId("review-mark").click();
  await expect(turns.nth(1).getByTestId("review-undo")).toHaveText("✓ 审过");
  await expect.poll(async () => (await marks())[ids[1]!]).toBe("reviewed");
  // Taken back and given again.
  await turns.nth(1).getByTestId("review-undo").click();
  await expect(turns.nth(1).getByTestId("review-mark")).toBeVisible();
  await expect.poll(async () => (await marks())[ids[1]!]).toBe("seen");
  await turns.nth(1).getByTestId("review-mark").click();
  await expect.poll(async () => (await marks())[ids[1]!]).toBe("reviewed");

  // 复盘: the two not 审过 are coloured and say what they are; the count and 下一条没审的.
  await page.getByTestId("review-open").click();
  const bar = page.getByTestId("review-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId("review-left")).toHaveText("还有 2 条没审");
  await expect(turns.nth(1)).not.toHaveAttribute("data-review", /unseen|seen/);
  await expect(turns.nth(1)).toHaveAttribute("data-review", "reviewed");
  await expect(turns.nth(2)).toHaveAttribute("data-review", "seen");
  await expect(turns.nth(2).getByTestId("review-state")).toHaveText("◐ 浏览过");
  // Every reply has its buttons in 复盘.
  await expect(turns.nth(2).getByTestId("review-mark")).toBeVisible();
  await expect(page.getByTestId("review-upto")).toHaveCount(3);
  // The first reply's end was never on screen while it was on: 没看, the strongest colour.
  await expect(turns.nth(0)).toHaveAttribute("data-review", "unseen");
  await expect(turns.nth(0).getByTestId("review-state")).toHaveText("○ 没看");
  // The window in the background (as the page sees it; blurring an Electron window here does not reach document.hasFocus):
  // what is on screen does not count as 浏览过 meanwhile.
  await page.evaluate(() => Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true }));
  // 下一条没审的 from the long reply being read: the one below it, then (none further down) from the top again.
  await bar.getByTestId("review-next").click();
  await expect(replies.nth(2)).toBeInViewport();
  await bar.getByTestId("review-next").click();
  await expect(replies.nth(0)).toBeInViewport();
  await screenshot(app, "studio", "review-progress-review", page);
  await theme(page, "dark");
  await screenshot(app, "studio", "review-progress-review-dark", page);
  await theme(page, "light");
  // Seconds on screen, and still 没看; in front again, it becomes 浏览过.
  await expect(turns.nth(0)).toHaveAttribute("data-review", "unseen");
  await page.evaluate(() => delete (document as unknown as { hasFocus?: unknown }).hasFocus);
  await expect(turns.nth(0)).toHaveAttribute("data-review", "seen", { timeout: 10_000 });
  await expect(bar.getByTestId("review-left")).toHaveText("还有 2 条没审");

  // 到这里为止都审过 on the last reply: all of them at once.
  await turns.nth(2).getByTestId("review-upto").click();
  await expect(bar.getByTestId("review-left")).toHaveText("✓ 都审过了");
  await expect.poll(marks).toEqual({ [ids[0]!]: "reviewed", [ids[1]!]: "reviewed", [ids[2]!]: "reviewed" });
  await expect(page.locator('[data-testid="turn"][data-review="unseen"], [data-testid="turn"][data-review="seen"]')).toHaveCount(0);
  await bar.getByTestId("review-exit").click();
  await expect(bar).toHaveCount(0);
  // Out of 复盘 again: 审过 ones keep their tick, nothing else.
  await expect(page.getByTestId("review-undo")).toHaveCount(3);
  await expect(page.getByTestId("review-upto")).toHaveCount(0);

  // Opened again (the page reloaded, back on the same task): read back from the Host.
  await page.reload();
  await expect(replies).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId("review-undo")).toHaveCount(3, { timeout: 15_000 });
  await page.getByTestId("review-open").click();
  await expect(page.getByTestId("review-left")).toHaveText("✓ 都审过了");
});
