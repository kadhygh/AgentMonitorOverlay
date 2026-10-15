import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 2026-10-15 evening: 「按 ↑ 回到本轮回复开始」 after a turn ends with its start out of sight, and Focus listing replies
// that ended (「回复完了」) until the person looks at them.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const composer = (page: Page) => page.getByLabel("输入消息");
/** A message the mock model echoes back, long enough that its reply starts far above the bottom. */
const LONG = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段`).join("\n\n");

/** How far the last turn's reply start is from the top of the conversation, in pixels. */
const replyStartOffset = (page: Page) =>
  page.getByTestId("thread").evaluate((el) => {
    const turns = el.querySelectorAll("section.turn");
    const last = turns[turns.length - 1]!;
    const start = [...last.children].find((c) => !c.classList.contains("msg-user-row"))!;
    return Math.round(start.getBoundingClientRect().top - el.getBoundingClientRect().top);
  });
const scrollTop = (page: Page) => page.getByTestId("thread").evaluate((el) => Math.round(el.scrollTop));

test("after a long reply, ↑ goes back to where the turn's reply begins; anything else puts the hint away", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "长回复", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "第一轮" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").filter({ hasText: "MOCK: 第一轮" })).toBeVisible({ timeout: 60_000 });
  // A short reply that ended in sight: nothing to go back to.
  await expect(page.getByTestId("turn-start-hint")).toHaveCount(0);

  await composer(page).fill(LONG);
  await composer(page).press("Enter");
  const hint = page.getByTestId("turn-start-hint");
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await expect(hint).toHaveText("按 ↑ 回到本轮回复开始");
  expect(await replyStartOffset(page)).toBeLessThan(0);
  await screenshot(app, "stage-14", "turn-start-hint", page);

  // ↑ (focus is still in the empty composer): back to the reply's start, the hint goes away.
  await composer(page).press("ArrowUp");
  await expect(hint).toHaveCount(0);
  await expect.poll(() => replyStartOffset(page)).toBeGreaterThanOrEqual(0);
  expect(await replyStartOffset(page)).toBeLessThan(40);
  await expect(composer(page)).toHaveValue("");

  // Next turn: typing something first puts the hint away, and ↑ is then the composer's own again.
  await composer(page).fill(LONG);
  await composer(page).press("Enter");
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await composer(page).press("a");
  await expect(hint).toHaveCount(0);
  const before = await scrollTop(page);
  await composer(page).press("ArrowUp");
  expect(await scrollTop(page)).toBe(before);
  await expect(composer(page)).toHaveValue("a");

  // A click on the hint itself goes back too.
  await composer(page).fill(LONG);
  await composer(page).press("Enter");
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await hint.click();
  await expect(hint).toHaveCount(0);
  await expect.poll(() => replyStartOffset(page)).toBeGreaterThanOrEqual(0);
});

test("Focus lists replies that ended while the session was not on screen, until it is looked at", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });

  // The board is showing, not the session: its reply ends unseen.
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "后台跑完", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "在后台回复" } });
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toHaveCount(1, { timeout: 60_000 });
  await expect(entry).toContainText("后台跑完");
  await expect(entry).toContainText("回复完了");
  await expect(entry).toHaveAttribute("data-finished", "true");
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1");
  await expect(focus.getByTestId("focus-snippet")).toContainText("MOCK: 在后台回复");
  await screenshot(app, "stage-14", "focus-replied", focus, "focus");

  // Opened in the workbench: seen, gone from Focus.
  await focus.getByRole("button", { name: "在工作台打开" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("后台跑完");
  await expect(focus.getByTestId("focus-entry")).toHaveCount(0, { timeout: 15_000 });
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理");

  // Another one, looked at in Focus itself: clicking its row counts as seen too.
  await page.getByRole("button", { name: /返回|看板/ }).first().click();
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "另一个", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "再回复一次" } });
  await expect(focus.getByTestId("focus-entry")).toHaveCount(1, { timeout: 60_000 });
  await focus.getByTestId("focus-entry").getByRole("button").first().click();
  await expect(focus.getByTestId("focus-entry")).toHaveCount(0, { timeout: 15_000 });
});
