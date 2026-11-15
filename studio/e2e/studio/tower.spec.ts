/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import type { Annotation, Session, Task, TowerData, Workspace } from "@amo-studio/protocol";
import { selectAndRelease } from "../support/selection.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 脉络的楼 (2026-11-15; 设置 → 测试功能 → 脉络): a session marked 脉络会话 opens as its building (tower.html in an iframe
// in the conversation's place, the composer still under it) — a floor per round, the session it started as a region, its
// report as a card; its AI titles a round with track_note.
// 会话弹窗 (2026-11-16, the user: 点击某个卡片时，不要用侧边栏展示应该改成会话弹窗。弹窗开启时，下面的输入栏先隐藏，且输入栏的内容
// 也展示到弹窗里。弹窗应该能拖动，能 pin。弹窗也能加批注。): a card picked in the building (tower.pick) opens that session's
// conversation and the composer in a window over the building. Here the building's messages are sent as its page sends
// them (from its window: the task page checks where they come from), so this tests the task page's side on its own.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** Says `m` to the task page as the building's page does (window.parent.postMessage from the iframe). */
async function fromTower(page: Page, m: Record<string, unknown>) {
  const frame = page.frames().find((f) => f.url().includes("tower.html"));
  expect(frame, "the building's iframe").toBeTruthy();
  await frame!.evaluate((msg) => window.parent.postMessage(msg, "*"), m);
}

test("a 脉络会话 opens as its building; a card picked opens its conversation in a window that moves, pins and annotates", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["tracks"] });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const start = `[[mcp: session_start ${JSON.stringify({ text: "数一下掉落表有几张", title: "数表", model: "codex-mock", report: true })}]]`;
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: start } });
  const tower = () => studio!.api<TowerData>("GET", `/api/sessions/${session.id}/tracks`);
  // The sub-session's report comes back: a round of its own (the report began it).
  await expect.poll(async () => (await tower()).reports.length, { timeout: 60_000 }).toBe(1);
  await expect.poll(async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id).every((s) => s.status === "idle"), { timeout: 60_000 }).toBe(true);
  const sub = (await studio.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.find((s) => s.taskId === task.id && s.id !== session.id)!;

  await page.getByTestId("task-card").first().click();
  const thread = page.getByTestId("thread");
  await expect(thread.getByTestId("msg-origin").filter({ hasText: "子会话「数表」回报" })).toBeVisible({ timeout: 30_000 });
  // Not a 脉络会话 yet: the conversation as ever, with the switch above it.
  await expect(page.getByTestId("tower-switch")).toBeVisible();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(page.getByLabel("输入消息")).toBeVisible();
  await expect(page.getByTestId("tower-popup")).toHaveCount(0);
  const frame = page.frameLocator('[data-testid="tower-frame"]');
  const built = await tower();
  expect(built.on).toBe(true);
  expect(built.sessions).toMatchObject([{ key: "A", title: "数表", at: 1, sessionId: sub.id }]);
  // A button per floor and the roof; the session it started is a pin on the front.
  await expect(frame.locator("#rail button[data-f]")).toHaveCount(built.rounds.length + 1);
  await expect(frame.locator(".pin.sess").first()).toBeVisible();
  await page.waitForTimeout(1200);
  await screenshot(studio.app, "studio", "tower-session", page);

  // The session list's width is dragged across the building (2026-11-16, the user: 脉络开启之后，如果我拖拽 sessionlist 的
  // 宽度，会卡住): the pointer goes over the building's iframe, and the column still follows it and lets go.
  const handle = page.getByRole("separator", { name: "调整会话列表宽度" });
  const listWidth = async () => Number(await handle.getAttribute("aria-valuenow"));
  const before = await listWidth();
  const listGrip = (await handle.boundingBox())!;
  await page.mouse.move(listGrip.x + listGrip.width / 2, listGrip.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(listGrip.x + listGrip.width / 2 + i * 20, listGrip.y + 200);
  await expect.poll(listWidth).toBe(before + 120);
  await page.mouse.up();
  await expect(page.locator("body.col-resizing")).toHaveCount(0);
  await page.mouse.move(listGrip.x + 300, listGrip.y + 260);
  expect(await listWidth()).toBe(before + 120);
  await handle.dblclick();
  expect(await listWidth()).toBe(before);

  // A draft written under the building goes with the composer into the window.
  await page.getByLabel("输入消息").fill("草稿：弹窗里还在");
  const firstRow = built.rounds[0]!.itemId!;
  expect(firstRow).toBeTruthy();
  await fromTower(page, { type: "tower.pick", sessionId: session.id, itemId: firstRow, title: built.rounds[0]!.title });
  const popup = page.getByTestId("tower-popup");
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId("tower-popup-title")).toContainText(built.rounds[0]!.title.slice(0, 6));
  await expect(popup.locator(`[data-row-id="${firstRow}"], [data-item-id="${firstRow}"]`).first()).toBeInViewport();
  // One composer, in the window (none left under the building), with the draft; the window is inside the building's area.
  await expect(page.getByLabel("输入消息")).toHaveCount(1);
  await expect(popup.getByLabel("输入消息")).toHaveValue("草稿：弹窗里还在");
  const cover = (await page.getByTestId("thread-cover").boundingBox())!;
  const pane = (await popup.boundingBox())!;
  expect(pane.y + pane.height).toBeLessThanOrEqual(cover.y + cover.height + 1);
  expect(pane.x).toBeGreaterThanOrEqual(cover.x - 1);
  await page.waitForTimeout(600);
  // Nothing in it runs out of its sides (the composer's bar wraps in a narrow window).
  expect(await popup.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await screenshot(studio.app, "studio", "tower-popup", page);

  // Sent from the window: the AI is told about 脉络 with that message and titles the round and notes a point (the mock
  // model calls the tool it is told to); the window stays.
  const note = `[[mcp: track_note ${JSON.stringify({ title: "核对掉落表数量", desc: "一共 3 张，和策划表对上了", points: ["数值一律按策划表来"] })}]]`;
  await popup.getByLabel("输入消息").fill(note);
  await popup.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(async () => (await tower()).rounds.at(-1)?.title, { timeout: 60_000 }).toBe("核对掉落表数量");
  const after = await tower();
  expect(after.rounds.at(-1)).toMatchObject({ labelled: true, desc: "一共 3 张，和策划表对上了" });
  expect(after.points).toMatchObject([{ text: "数值一律按策划表来", round: after.rounds.length }]);
  const sent = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!;
  expect(sent.text).toContain("这个会话开了「脉络」");
  await expect(popup).toBeVisible();
  // The building is drawn anew with the new floor.
  await expect(frame.locator("#rail button[data-f]")).toHaveCount(after.rounds.length + 1, { timeout: 30_000 });

  // Sized by its corner, moved by its head; never out of the building's area.
  const corner = (await popup.getByTestId("tower-popup-resize").boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8);
  await page.mouse.down();
  await page.mouse.move(corner.x + 8, corner.y + 8 - 140, { steps: 5 });
  await page.mouse.up();
  const sized = (await popup.boundingBox())!;
  expect(sized.height).toBeLessThan(pane.height - 50);
  const grip = (await popup.getByTestId("tower-popup-head").boundingBox())!;
  await page.mouse.move(grip.x + 40, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 40 - 160, grip.y + grip.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  const moved = (await popup.boundingBox())!;
  expect(moved.x).toBeLessThan(sized.x - 120);
  expect(moved.y).toBeGreaterThan(sized.y + 30);
  // Dragged far past the edge: it stops at the building's area.
  const grip2 = (await popup.getByTestId("tower-popup-head").boundingBox())!;
  await page.mouse.move(grip2.x + 40, grip2.y + grip2.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip2.x + 40 - 3000, grip2.y + grip2.height / 2, { steps: 6 });
  await page.mouse.up();
  const edge = (await popup.boundingBox())!;
  expect(edge.x).toBeGreaterThanOrEqual(cover.x);
  expect(edge.x).toBeLessThan(cover.x + 20);
  // …and back to where it was put before.
  const grip3 = (await popup.getByTestId("tower-popup-head").boundingBox())!;
  await page.mouse.move(grip3.x + 40, grip3.y + grip3.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip3.x + 40 + (moved.x - edge.x), grip3.y + grip3.height / 2, { steps: 6 });
  await page.mouse.up();
  const placed = (await popup.boundingBox())!;

  // Not pinned: the building's empty space closes it, the composer is back under the building.
  await fromTower(page, { type: "tower.unpick" });
  await expect(popup).toHaveCount(0);
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(page.getByLabel("输入消息")).toBeVisible();
  // Opened again where it was left; pinned, the empty space leaves it.
  await fromTower(page, { type: "tower.pick", sessionId: session.id, itemId: after.rounds.at(-1)!.itemId, title: "核对掉落表数量" });
  await expect(popup).toBeVisible();
  const again = (await popup.boundingBox())!;
  expect(Math.abs(again.x - placed.x)).toBeLessThan(2);
  expect(Math.abs(again.y - placed.y)).toBeLessThan(2);
  await popup.getByTestId("tower-popup-pin").click();
  await expect(popup.getByTestId("tower-popup-pin")).toHaveAttribute("aria-pressed", "true");
  await fromTower(page, { type: "tower.unpick" });
  await page.waitForTimeout(300);
  await expect(popup).toBeVisible();
  await page.waitForTimeout(400);
  await screenshot(studio.app, "studio", "tower-popup-pinned", page);

  // A card of the session it started: that session's conversation in the window (still pinned, where it was); the
  // building and the head stay the main session's.
  const subRow = built.sessions[0]!.rounds[0]!.itemId!;
  await fromTower(page, { type: "tower.pick", sessionId: sub.id, itemId: subRow, title: built.sessions[0]!.rounds[0]!.title });
  await expect(popup.getByTestId("tower-popup-title")).toContainText("子会话「数表」");
  // Its first message is the one its starter sent (a folded 「…开启了这个会话」 row, not the person's bubble).
  await expect(popup.getByTestId("msg-origin").first()).toContainText("数一下掉落表有几张", { timeout: 15_000 });
  await expect(popup.getByTestId("msg-origin").first()).toBeInViewport();
  await expect(popup.getByTestId("tower-popup-pin")).toHaveAttribute("aria-pressed", "true");
  const onSub = (await popup.boundingBox())!;
  expect(Math.abs(onSub.x - placed.x)).toBeLessThan(2);
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(page.getByTestId("tower-on")).toBeChecked();
  // Annotated in the window, as in the conversation: select in its reply, 批注, write, save.
  const reply = popup.getByTestId("msg-agent").first();
  await expect(reply).toBeVisible();
  const quote = ((await reply.locator("[data-src-start]").first().textContent()) ?? "").trim().slice(0, 4);
  expect(quote.length).toBe(4);
  await selectAndRelease(reply, quote);
  await expect(page.getByTestId("selection-bar")).toBeVisible();
  const inPane = (await popup.boundingBox())!;
  const bar = (await page.getByTestId("selection-bar").boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(inPane.x - 1);
  expect(bar.x + bar.width).toBeLessThanOrEqual(inPane.x + inPane.width + 1);
  await page.getByTestId("selection-bar").getByRole("button", { name: "批注" }).click();
  const bubble = page.getByTestId("annotation-bubble");
  await expect(bubble.getByLabel("批注内容")).toBeFocused();
  const bubbleBox = (await bubble.boundingBox())!;
  expect(bubbleBox.x).toBeGreaterThanOrEqual(inPane.x - 1);
  expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(inPane.x + inPane.width + 1);
  await bubble.getByLabel("批注内容").fill("这句在弹窗里批注");
  await page.waitForTimeout(300);
  await screenshot(studio.app, "studio", "tower-popup-annotate", page);
  await bubble.getByLabel("批注内容").press("Control+Enter");
  await expect(bubble).toHaveCount(0);
  await expect.poll(async () => (await studio!.api<Annotation[]>("GET", `/api/sessions/${sub.id}/annotations`)).map((a) => [a.quote, a.note])).toEqual([[quote, "这句在弹窗里批注"]]);
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId("annotation-mark")).toHaveCount(1);

  // ×: closed (pinned or not), the main session is in front again.
  await popup.getByTestId("tower-popup-close").click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(page.getByLabel("输入消息")).toHaveValue("");
  await expect(page.getByTestId("annotation-mark")).toHaveCount(0);

  // 对话 in the row above while a session it started is in the window: the window goes, the main session's conversation.
  await fromTower(page, { type: "tower.pick", sessionId: sub.id, itemId: subRow });
  await expect(popup.getByTestId("tower-popup-title")).toContainText("子会话「数表」");
  await page.getByTestId("tower-view-chat").click();
  await expect(page.getByTestId("tower-popup")).toHaveCount(0);
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await expect(thread.getByTestId("msg-origin").filter({ hasText: "子会话「数表」回报" })).toBeVisible();
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(frame.locator("#rail button[data-f]").first()).toBeVisible({ timeout: 30_000 });

  // 切到对话: the conversation of the window's session, at the row read there.
  const lastRow = after.rounds.at(-1)!.itemId!;
  await fromTower(page, { type: "tower.pick", sessionId: session.id, itemId: lastRow });
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId("tower-popup-pin")).toHaveAttribute("aria-pressed", "false");
  await popup.getByTestId("tower-popup-chat").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await expect(page.getByTestId("tower-popup")).toHaveCount(0);
  await expect(page.getByTestId("tower-view-chat")).toHaveAttribute("aria-selected", "true");
  await expect(thread.locator(`[data-row-id="${lastRow}"], [data-item-id="${lastRow}"]`).first()).toBeInViewport();
  // Back to the building with the switch; unticking 脉络会话 returns the session to a plain conversation.
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  expect((await tower()).on).toBe(false);
});
