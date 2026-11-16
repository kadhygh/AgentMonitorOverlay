import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ReviewProgress, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 审阅进度 (设置 → 测试功能 → 审阅进度; plans/review-progress.md). 第二版 (2026-11-16; the user: 右侧加一个竖线，左键点击是
// 标记读到哪里，右键则是标记那个感叹号有问题 … 没看的块做标注感受更好一些，然后审过的按钮可以去掉了): each finished reply has a
// line at its right; a left click on a block's height reads the reply down to it, a right click marks the block 「!」.
// Nothing is recorded by itself. 复盘 tints the blocks not read, counts and goes to the next place. The new 「!」 go to
// the AI with the person's next message, once.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const theme = (page: Page, which: "light" | "dark") => page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), which);

/** The mock answers `MOCK: <the message>`: this one makes a reply of 9 blocks (the heading goes with the item below it). */
const LONG = [
  "先说结论：可以合成一张表，不用动存档。",
  "",
  "## 一、表怎么合",
  "",
  "- 等级段按 10 级一档，共 7 档",
  "- Boss 专属掉落留在 BossDrop",
  "- 通用掉落只留一份",
  "",
  "| 位置 | 改法 |",
  "| --- | --- |",
  "| DropService.Roll | 改成查 BossDrop |",
  "| DropPreviewPanel | 改成走 DropService |",
  "",
  "```cs",
  "var rows = BossDrop.Query(bossId);",
  "```",
  "",
  "有一处我拿不准：30 级和 31 级的 Boss 有 3 件掉落的概率不一样。",
  "",
  "你定一下：抹平，还是加例外行？",
].join("\n");
const FLAGGED = "有一处我拿不准：30 级和 31 级的 Boss 有 3 件掉落的概率不一样。";

const box = async (l: Locator) => (await l.boundingBox())!;

test("a line at each reply's right: left click reads down to a block, right click marks 「!」; 复盘 tints what is not read; the 「!」 go to the AI once", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表复盘", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "先看一下掉落表" } });
  await page.getByTestId("task-card").first().click();
  const replies = page.getByTestId("msg-agent");
  await expect(replies).toHaveCount(1, { timeout: 30_000 });
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: LONG });
  await expect(replies).toHaveCount(2, { timeout: 30_000 });
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "好的，收到" });
  await expect(replies).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });

  // Off: nothing of it on the page.
  await expect(page.getByTestId("read-rail")).toHaveCount(0);
  await expect(page.getByTestId("review-open")).toHaveCount(0);

  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["review-progress"] });
  await expect(page.getByTestId("read-rail")).toHaveCount(3, { timeout: 15_000 });
  const long = replies.nth(1);
  await expect(long.getByTestId("read-marks")).toHaveAttribute("data-of", "9");
  const segs = long.getByTestId("read-seg");
  await expect(segs).toHaveCount(9);
  const ids = await replies.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.itemId!));
  const progress = async () => (await studio!.api<ReviewProgress>("GET", `/api/sessions/${session.id}/review-progress`)).replies;

  // The line is beside the reply's text, not over it, and inside the round.
  await long.scrollIntoViewIfNeeded();
  const text = await box(long.locator(".md"));
  const rail = await box(long.getByTestId("read-rail"));
  const round = await box(page.getByTestId("turn").nth(1));
  expect(rail.x).toBeGreaterThanOrEqual(text.x + text.width);
  expect(rail.x + rail.width).toBeLessThanOrEqual(round.x + round.width);

  // Nothing is recorded by itself: replies on screen, the window in front, seconds go by.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.focus());
  await page.waitForTimeout(3000);
  expect(await progress()).toEqual({});

  // Left click on the 4th block (the last item of the list): read down to it, 「读到这里」 under it.
  await segs.nth(3).click();
  await expect.poll(async () => (await progress())[ids[1]!]).toEqual({ read: 4, of: 9, at: "通用掉落只留一份", flags: [] });
  await expect(long.getByTestId("read-marks")).toHaveAttribute("data-read", "4");
  await expect(long.getByTestId("read-at")).toBeVisible();
  await expect(segs.nth(3)).toHaveAttribute("data-read", "true");
  await expect(segs.nth(4)).not.toHaveAttribute("data-read", /.*/);
  // Elsewhere: the place follows. On the same place again: taken back.
  await segs.nth(5).click();
  await expect.poll(async () => (await progress())[ids[1]!]?.read).toBe(6);
  await segs.nth(5).click();
  await expect.poll(progress).toEqual({});
  await expect(long.getByTestId("read-at")).toHaveCount(0);
  await segs.nth(6).click();
  await expect.poll(async () => (await progress())[ids[1]!]?.read).toBe(7);

  // Right click: a block's 「!」, on and off again; apart from how far it was read.
  await segs.nth(2).click({ button: "right" });
  await expect(segs.nth(2)).toHaveAttribute("data-flag", "true");
  await segs.nth(2).click({ button: "right" });
  await expect(segs.nth(2)).not.toHaveAttribute("data-flag", /.*/);
  await segs.nth(7).click({ button: "right" });
  await expect(segs.nth(7)).toHaveAttribute("data-flag", "true");
  await expect.poll(async () => (await progress())[ids[1]!]).toEqual({ read: 7, of: 9, at: "var rows = BossDrop.Query(bossId);", flags: [{ block: 7, quote: FLAGGED }] });
  // No tint off 复盘: only the line, 读到这里 and the 「!」.
  await expect(page.getByTestId("read-unread")).toHaveCount(0);
  await expect(page.getByTestId("read-flag-tint")).toHaveCount(0);
  // The pointer off the line (it previews what a click would count as read).
  await page.mouse.move(5, 500);
  await screenshot(app, "studio", "review-progress-rail", page);

  // 复盘: the blocks not read are tinted (from the 8th block down), the ones read are not; the 「!」 one in its colour.
  await page.getByTestId("review-open").click();
  const bar = page.getByTestId("review-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId("review-left")).toHaveText("还有 3 条回复没读完");
  await expect(bar.getByTestId("review-flags")).toContainText("1 处有问题");
  const tint = await box(long.getByTestId("read-unread"));
  const code = await box(long.locator(".md > *").nth(4));
  const doubt = await box(long.locator(".md > *").nth(5));
  const end = await box(long.locator(".md > *").nth(6));
  expect(tint.y).toBeGreaterThan(code.y + code.height - 1);
  expect(tint.y).toBeLessThanOrEqual(doubt.y + 1);
  expect(tint.y + tint.height).toBeGreaterThanOrEqual(end.y + end.height - 1);
  await expect(long.getByTestId("read-flag-tint")).toHaveCount(1);
  // The short replies, never marked, are tinted whole.
  await expect(replies.nth(0).getByTestId("read-unread")).toHaveCount(1);
  await expect(replies.nth(2).getByTestId("read-unread")).toHaveCount(1);
  // Each reply's end says how far it was read.
  const feet = page.getByTestId("read-foot");
  await expect(feet).toHaveCount(3);
  await expect(feet.nth(1).getByTestId("read-line")).toHaveText("读到第 7 / 9 块");
  await expect(feet.nth(1).getByTestId("read-foot-flags")).toHaveText("! 1 处有问题");
  await expect(feet.nth(0).getByTestId("read-line")).toHaveText("还没读");
  await long.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "review-progress-review", page);
  await theme(page, "dark");
  await screenshot(app, "studio", "review-progress-review-dark", page);
  await theme(page, "light");

  // 下一处没读的 from the top: the first reply, then the first block not read of the long one.
  await page.getByTestId("thread").evaluate((el) => (el.scrollTop = 0));
  await bar.getByTestId("review-next").click();
  await expect(replies.nth(0)).toBeInViewport();
  await bar.getByTestId("review-next").click();
  await expect(long.locator(".md > *").nth(5)).toBeInViewport();

  // 到这里为止都读过 on the long reply: it and the one before, its 「!」 kept.
  await feet.nth(1).getByTestId("read-upto").click();
  await expect(bar.getByTestId("review-left")).toHaveText("还有 1 条回复没读完");
  await expect.poll(progress).toEqual({ [ids[0]!]: { read: "all", flags: [] }, [ids[1]!]: { read: "all", of: 9, flags: [{ block: 7, quote: FLAGGED }] } });
  await expect(long.getByTestId("read-unread")).toHaveCount(0);
  await expect(feet.nth(1).getByTestId("read-line")).toHaveText("读到底了");
  await bar.getByTestId("review-exit").click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("read-foot")).toHaveCount(0);
  await expect(page.getByTestId("read-unread")).toHaveCount(0);

  // Opened again (the page reloaded): read back from the Host.
  await page.reload();
  await expect(replies).toHaveCount(3, { timeout: 30_000 });
  await expect(long.getByTestId("read-marks")).toHaveAttribute("data-read", "9", { timeout: 15_000 });
  await expect(long.getByTestId("read-seg").nth(7)).toHaveAttribute("data-flag", "true");
  await page.getByTestId("review-open").click();
  await expect(page.getByTestId("review-left")).toHaveText("还有 1 条回复没读完");
  await page.getByTestId("review-exit").click();

  // A narrow conversation: the line still beside the text and inside the round, 读到这里 stood up beside the line.
  const size = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.isVisible())!;
    const [width, height] = w.getSize();
    w.setSize(width! - 180, height!);
    return { width: width!, height: height! };
  });
  await expect.poll(async () => (await box(page.getByTestId("thread"))).width).toBeLessThan(600);
  const narrowSeg = long.getByTestId("read-seg").nth(4);
  await narrowSeg.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const narrowText = await box(long.locator(".md"));
  const narrowRail = await box(long.getByTestId("read-rail"));
  const narrowRound = await box(page.getByTestId("turn").nth(1));
  expect(narrowRail.x).toBeGreaterThanOrEqual(narrowText.x + narrowText.width);
  expect(narrowRail.x + narrowRail.width).toBeLessThanOrEqual(narrowRound.x + narrowRound.width);
  await narrowSeg.click();
  await expect(long.getByTestId("read-at")).toBeVisible();
  await page.mouse.move(5, 500);
  await expect(page.getByTestId("read-preview")).toHaveCount(0);
  await screenshot(app, "studio", "review-progress-narrow", page);
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows().find((x) => x.isVisible())!.setSize(s.width, s.height), size);

  // The next message carries the new 「!」 to the AI — and the one after it does not again.
  const lastAsk = async () => (await studio!.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!.text ?? "";
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "看一下我标的地方" });
  await expect(replies).toHaveCount(4, { timeout: 30_000 });
  const told = await lastAsk();
  expect(told).toContain("人在你的回复上标了 1 处「有问题」");
  expect(told).toContain(`第 8 段「${FLAGGED}」`);
  await expect.poll(async () => (await progress())[ids[1]!]?.flags).toEqual([{ block: 7, quote: FLAGGED, told: true }]);
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "再看一下" });
  await expect(replies).toHaveCount(5, { timeout: 30_000 });
  expect(await lastAsk()).not.toContain("有问题");
});
