import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { selectAndRelease } from "../support/selection.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 2 acceptance: select → annotate in the bubble by the selection → send the summary back → the session receives
// it. (Stage 12: the bar and bubble by the selection, after the ChatGPT app; a highlighted passage opens its note.)

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function annotate(page: Page, quote: string, note: string) {
  const reply = page.getByTestId("msg-agent").first();
  await selectAndRelease(reply, quote);
  await page.getByTestId("selection-bar").getByRole("button", { name: "批注" }).click();
  const bubble = page.getByTestId("annotation-bubble");
  await expect(bubble.locator(".anno-bubble-quote")).toHaveText(quote);
  await expect(bubble.getByLabel("批注内容")).toBeFocused();
  await bubble.getByLabel("批注内容").fill(note);
  await bubble.getByLabel("批注内容").press("Control+Enter");
  await expect(bubble).toHaveCount(0);
}

/** The texts painted by a CSS highlight (review/highlights.ts), sorted. */
const painted = (page: Page, name = "amo-annotation") =>
  page.evaluate((n) => [...(CSS.highlights.get(n) ?? [])].map((r) => (r as Range).toString()).sort(), name);

/** Clicks the middle of the painted text that reads `text`. */
async function clickPainted(page: Page, text: string) {
  const at = await page.evaluate((t) => {
    const r = [...(CSS.highlights.get("amo-annotation") ?? [])].find((x) => (x as Range).toString() === t) as Range | undefined;
    const box = r?.getClientRects()[0];
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  }, text);
  expect(at, `painted "${text}"`).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
}

test("annotate replies, edit, locate, and refer to them from the next message (批注N)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "审阅闭环",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await page.getByTestId("task-card").first().click();
  const reply = page.getByTestId("msg-agent").first();
  await expect(reply.locator("table.md-table")).toBeVisible({ timeout: 30_000 });

  // Selecting shows the bar by the selection; 批注 turns it into the bubble.
  await selectAndRelease(reply, "发现 3 张表");
  await expect(page.getByTestId("selection-bar")).toBeVisible();
  await screenshot(studio.app, "stage-12", "S12-N-selection-bar", page);
  await page.getByTestId("selection-bar").getByRole("button", { name: "批注" }).click();
  await page.getByTestId("annotation-bubble").getByLabel("批注内容").fill("说明是哪三张");
  await screenshot(studio.app, "stage-12", "S12-N-annotation-bubble", page);
  await page.getByTestId("annotation-bubble").getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("annotation-bubble")).toHaveCount(0);
  await annotate(page, "先修正概率", "先确认策划的意图");
  await annotate(page, "Boss_Lv20", "这条删掉");
  const cards = page.getByTestId("annotation");
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId("annotation-count")).toHaveText("3");
  await expect(reply.locator("[data-annotated]")).toHaveCount(3);
  // Stage 13: only the quoted text is highlighted — one line of the list, one cell of the table — not their blocks.
  await expect.poll(() => painted(page)).toEqual(["Boss_Lv20", "先修正概率", "发现 3 张表"]);
  await screenshot(studio.app, "stage-13", "S13-C-annotation-precise", page);

  // A highlighted passage opens its note in the bubble, to change it there.
  await clickPainted(page, "先修正概率");
  const bubble = page.getByTestId("annotation-bubble");
  await expect(bubble.getByLabel("批注内容")).toHaveValue("先确认策划的意图");
  await screenshot(studio.app, "stage-12", "S12-N-annotation-bubble-edit", page);
  await bubble.getByLabel("批注内容").fill("先确认策划的意图（改过）");
  await bubble.getByRole("button", { name: "保存" }).click();
  // Newest first (2026-10-26).
  await expect(cards.nth(1)).toContainText("先确认策划的意图（改过）");
  await expect(cards.first()).toContainText("这条删掉");
  await expect(cards.last()).toContainText("说明是哪三张");

  // Edit and delete from the panel.
  await cards.nth(1).getByRole("button", { name: "编辑" }).click();
  await cards.nth(1).getByLabel("修改批注").fill("先和策划确认意图再改");
  await cards.nth(1).getByRole("button", { name: "保存" }).click();
  await expect(cards.nth(1)).toContainText("先和策划确认意图再改");
  await cards.filter({ hasText: "这条删掉" }).getByRole("button", { name: "删除" }).click();
  await expect(cards).toHaveCount(2);
  await expect(reply.locator("[data-annotated]")).toHaveCount(2);
  await expect.poll(() => painted(page)).toEqual(["先修正概率", "发现 3 张表"]);

  // Clicking the quote locates and flashes the annotated text.
  await cards.filter({ hasText: "说明是哪三张" }).getByTitle("定位到原文").click();
  await expect.poll(() => painted(page, "amo-annotation-flash")).toEqual(["发现 3 张表"]);
  await screenshot(studio.app, "stage-2", "S2-04-annotations", page);

  // 2026-10-15: each annotation ends with a 批注N mark; the next message carries them as tags, nothing is sent alone.
  await expect(page.getByTestId("annotation-mark")).toHaveText(["批注1", "批注2"]);
  const tags = page.getByTestId("annotation-ref");
  await expect(tags).toHaveText(["批注1×", "批注2×"]);
  await expect(page.getByRole("button", { name: /汇总发回会话/ })).toHaveCount(0);
  // Take 批注2 off the message, then back on from its card.
  await page.getByRole("button", { name: "不引用批注2" }).click();
  await expect(tags).toHaveText(["批注1×"]);
  await expect(cards.filter({ hasText: "批注2" }).getByTestId("annotation-refer")).toHaveText("不引用");
  await cards.filter({ hasText: "批注2" }).getByTestId("annotation-refer").click();
  await expect(tags).toHaveText(["批注1×", "批注2×"]);
  await page.getByLabel("输入消息").fill("按这两条批注改一下");
  await screenshot(studio.app, "stage-14", "S14-Q-annotation-refs", page);
  await page.getByLabel("输入消息").press("Enter");

  // The message shows the person's text with two tags; the model gets the quotes and notes after the text.
  const message = page.getByTestId("msg-user").filter({ hasText: "按这两条批注改一下" });
  await expect(message).toBeVisible({ timeout: 30_000 });
  await expect(message.getByTestId("msg-annotation-ref")).toHaveText(["批注1", "批注2"]);
  await expect(message).not.toContainText("【引用的批注】");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 按这两条批注改一下", { timeout: 30_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("【批注1】针对你回复中的这段：");
  await expect(tags).toHaveCount(0);
  await expect(cards).toHaveCount(0);
  await expect(page.getByTestId("annotation-count")).toHaveText("0");
  await expect(reply.locator("[data-annotated]")).toHaveCount(0);
  await expect.poll(() => painted(page)).toEqual([]);

  // A sent one can be referred to again: back as a tag and a highlight, and the next message carries it.
  await page.getByRole("button", { name: /已发送 2/ }).click();
  await expect(page.getByTestId("annotation-sent")).toHaveCount(2);
  await page.getByTestId("annotation-sent").filter({ hasText: "批注1" }).getByTestId("annotation-refer-again").click();
  await expect(tags).toHaveText(["批注1×"]);
  await expect.poll(() => painted(page)).toEqual(["发现 3 张表"]);
  await screenshot(studio.app, "stage-2", "S2-04-sent", page);
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("msg-user").last().getByTestId("msg-annotation-ref")).toHaveText(["批注1"], { timeout: 30_000 });
  await expect(tags).toHaveCount(0);

  // 2026-10-19: a pinned annotation stays at the top of the panel, outside the folded 已发送, sent or not.
  const sentCards = page.getByTestId("annotation-sent");
  await sentCards.filter({ hasText: "批注2" }).getByTestId("annotation-pin").click();
  await page.getByRole("button", { name: /已发送 1/ }).click();
  await expect(sentCards).toHaveCount(1);
  await expect(sentCards.first()).toContainText("批注2");
  await expect(sentCards.first().getByTestId("annotation-pin")).toHaveAttribute("aria-pressed", "true");
  await annotate(page, "Boss_Lv20", "再看看这条");
  await cards.first().getByTestId("annotation-pin").click();
  await expect(cards.first()).toHaveClass(/pinned/);
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("msg-user").last().getByTestId("msg-annotation-ref")).toHaveText(["批注4"], { timeout: 30_000 });
  await expect(cards).toHaveCount(0);
  await expect(sentCards).toHaveCount(2);
  await expect(sentCards.first()).toContainText("批注4");
  await expect(page.getByRole("button", { name: /已发送 1/ })).toBeVisible();
  await screenshot(studio.app, "stage-18", "S18-annotation-pins", page);
});

test("定位到原文 brings a quote late in a long paragraph into the middle of the view (2026-10-19)", async () => {
  studio = await launchStudio({ taskSidebar: true });
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `第${i}句话用来把这一段撑得很长，看看定位会不会偏。`).join("");
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "定位", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: `${filler(70)}目标短语就在这里${filler(30)}` } });
  await page.getByTestId("task-card").first().click();
  const reply = page.getByTestId("msg-agent").first();
  await expect(reply).toContainText("目标短语", { timeout: 30_000 });
  for (const t of ["第二条", "第三条"]) {
    await page.getByLabel("输入消息").fill(`${t} ${filler(25)}`);
    await page.getByLabel("输入消息").press("Enter");
    await expect(page.getByTestId("msg-agent").last()).toContainText(t, { timeout: 30_000 });
  }
  await annotate(page, "目标短语就在这里", "看这里");
  await page.getByTestId("thread").evaluate((el) => (el.scrollTop = el.scrollHeight));

  // The paragraph is taller than the view: the quote itself, not the paragraph, goes to the middle.
  await page.getByTitle("定位到原文").first().click();
  await expect.poll(() => painted(page, "amo-annotation-flash")).toEqual(["目标短语就在这里"]);
  const at = await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".thread")!.getBoundingClientRect();
    const box = ([...CSS.highlights.get("amo-annotation-flash")!][0] as Range).getBoundingClientRect();
    return { off: box.top + box.height / 2 - (view.top + view.height / 2), inside: box.top >= view.top && box.bottom <= view.bottom };
  });
  expect(at.inside).toBe(true);
  expect(Math.abs(at.off)).toBeLessThan(40);
});
