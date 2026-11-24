import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ReviewProgress, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 审阅进度 (设置 → 测试功能 → 审阅进度; plans/review-progress.md). 第二版 (2026-11-16; the user: 右侧加一个竖线，左键点击是
// 标记读到哪里，右键则是标记那个感叹号有问题 … 没看的块做标注感受更好一些，然后审过的按钮可以去掉了): each finished reply has a
// line at its right; a left click on a block's height reads the reply down to it, a right click marks the block 「!」.
// Nothing is recorded by itself. The new 「!」 go to the AI with the person's next message, once. (复盘 went on
// 2026-11-16.)

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

test("a line at each reply's right: left click reads down to a block, right click marks 「!」; the 「!」 go to the AI once", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表复盘", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "先看一下掉落表" } });
  await page.getByTestId("task-card").first().click();
  const replies = page.getByTestId("msg-agent");
  await expect(replies).toHaveCount(1, { timeout: 30_000 });
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: LONG });
  await expect(replies).toHaveCount(2, { timeout: 30_000 });
  // The round over before the next message: sent while it still runs, 「好的，收到」 goes into that round, whose reply is
  // then not a finished round's and has no line (seen 2 of 3 runs on 11-25, plans/maintenance.md).
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "好的，收到" });
  await expect(replies).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });

  // Off: nothing of it on the page.
  await expect(page.getByTestId("read-rail")).toHaveCount(0);
  const textWidthOff = (await box(replies.nth(1).locator(".md"))).width;

  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["review-progress"] });
  await expect(page.getByTestId("read-rail")).toHaveCount(3, { timeout: 15_000 });
  const long = replies.nth(1);
  await expect(long.getByTestId("read-marks")).toHaveAttribute("data-of", "9");
  const segs = long.getByTestId("read-seg");
  await expect(segs).toHaveCount(9);
  const ids = await replies.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.itemId!));
  const progress = async () => (await studio!.api<ReviewProgress>("GET", `/api/sessions/${session.id}/review-progress`)).replies;

  // The line is at the conversation's right edge, beside the scrollbar (2026-11-16, the user: 这条线最好是在现有对话框的
  // 右侧，不应该影响中间主体的展示): not over the reply's text, inside the round's box (an off-screen round paints
  // nothing outside it), and the text about as wide as with the feature off (the conversation gives up 10px of padding).
  await long.scrollIntoViewIfNeeded();
  const text = await box(long.locator(".md"));
  const rail = await box(long.getByTestId("read-rail"));
  const round = await box(page.getByTestId("turn").nth(1));
  const edge = await page.getByTestId("thread").evaluate((el) => el.getBoundingClientRect().left + el.clientWidth);
  expect(rail.x).toBeGreaterThanOrEqual(text.x + text.width);
  expect(rail.x + rail.width).toBeLessThanOrEqual(round.x + round.width + 0.5);
  expect(edge - (rail.x + rail.width)).toBeGreaterThanOrEqual(0);
  expect(edge - (rail.x + rail.width)).toBeLessThanOrEqual(8);
  expect(text.width).toBeGreaterThanOrEqual(textWidthOff - 11);

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
  // The pointer off the line (it previews what a click would count as read).
  await page.mouse.move(5, 500);
  await screenshot(app, "studio", "review-progress-rail", page);

  // The pointer back up the line after a click (2026-11-16, the user: 如果鼠标拖回上面，竖线的颜色会变回去): what is read
  // stays green, the preview of what a click would read is green too (fainter), not the hover's grey.
  const lineColour = (i: number) => segs.nth(i).evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
  const readColour = await lineColour(0);
  const s8 = await box(segs.nth(8));
  await page.mouse.move(s8.x + s8.width / 2, s8.y + s8.height / 2, { steps: 4 });
  await expect(segs.nth(8)).toHaveAttribute("data-pre", "true");
  const s1 = await box(segs.nth(1));
  await page.mouse.move(s1.x + s1.width / 2, s1.y + s1.height / 2, { steps: 6 });
  expect(await lineColour(0)).toBe(readColour);
  expect(await lineColour(6)).toBe(readColour);
  // Pointer at the 2nd block: the 9th is neither read nor in the preview — the hover's grey.
  const hoverGrey = await lineColour(8);
  await page.mouse.move(s8.x + s8.width / 2, s8.y + s8.height / 2, { steps: 6 });
  expect(await lineColour(6)).toBe(readColour);
  const previewColour = await lineColour(8);
  expect(previewColour).not.toBe(hoverGrey);
  expect(previewColour).not.toBe(readColour);
  await page.mouse.move(5, 500);

  // No 复盘 any more (2026-11-16, the user: 现在的复盘我觉得可以删掉，因为本体已经有右侧的看到哪的线了).
  await expect(page.getByTestId("review-open")).toHaveCount(0);

  // Opened again (the page reloaded): read back from the Host.
  await page.reload();
  await expect(replies).toHaveCount(3, { timeout: 30_000 });
  await expect(long.getByTestId("read-marks")).toHaveAttribute("data-read", "7", { timeout: 15_000 });
  await expect(long.getByTestId("read-seg").nth(7)).toHaveAttribute("data-flag", "true");

  // A narrow conversation: the line still beside the text and inside the round, 读到这里 a notch on the line (no room for its words).
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
  expect(narrowRail.x + narrowRail.width).toBeLessThanOrEqual(narrowRound.x + narrowRound.width + 0.5);
  await narrowSeg.click();
  await expect(long.getByTestId("read-at")).toBeVisible();
  await page.mouse.move(5, 500);
  await expect(page.getByTestId("read-preview")).toHaveCount(0);
  await screenshot(app, "studio", "review-progress-narrow", page);
  // A wide one: 读到这里 written out on the tab beside the line.
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows().find((x) => x.isVisible())!.setSize(s.width + 480, s.height), size);
  await expect.poll(async () => (await box(page.getByTestId("thread"))).width).toBeGreaterThan(900);
  await long.getByTestId("read-at").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect.poll(async () => (await box(long.getByTestId("read-at"))).width).toBeGreaterThan(40);
  await page.mouse.move(5, 500);
  await screenshot(app, "studio", "review-progress-wide", page);
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
