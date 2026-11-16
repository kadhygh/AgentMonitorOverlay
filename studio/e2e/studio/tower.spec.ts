/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Annotation, Session, Task, TowerData, Workspace } from "@amo-studio/protocol";
import { selectAndRelease } from "../support/selection.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 脉络的楼 (2026-11-15; 设置 → 测试功能 → 脉络): a session marked 脉络会话 opens as its building (tower.html in an iframe
// in the conversation's place, the composer still under it) — a floor per round, the session it started as a region, its
// report as a card; its AI titles a round with track_note.
// 会话弹窗 (2026-11-16; a window of its own since 2026-11-16, the user: 脉络点击的弹窗要独立弹窗，不然会被限制拖动范围): a card
// picked in the building (tower.pick) opens that session's conversation and its composer in a window of its own (#round?…),
// owned by the workbench; the one not pinned is reused for the next card, a pinned one stays. Here the building's
// messages are mostly sent as its page sends them (from its frame), and the building's own select() where its marking
// of the card matters.

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

/** The 会话弹窗 windows open now. */
const rounds = (app: ElectronApplication) => app.windows().filter((w) => w.url().includes("#round"));

/** Picks a card (as the building says it) and waits for the window that opens for it. */
async function openRound(app: ElectronApplication, page: Page, m: Record<string, unknown>): Promise<Page> {
  const opened = app.waitForEvent("window", { predicate: (w) => w.url().includes("#round") });
  await fromTower(page, { type: "tower.pick", ...m });
  const win = await opened;
  await expect(win.getByTestId("round-window")).toBeVisible({ timeout: 30_000 });
  return win;
}

test("a 脉络会话 opens as its building; a card picked opens its conversation in a window of its own that sends, pins, is reused and annotates", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
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
  const frame = page.frameLocator('[data-testid="tower-frame"]');
  const built = await tower();
  expect(built.on).toBe(true);
  expect(built.sessions).toMatchObject([{ key: "A", title: "数表", at: 1, sessionId: sub.id }]);
  // A button per floor and the roof; the session it started is a pin on the front.
  await expect(frame.locator("#rail button[data-f]")).toHaveCount(built.rounds.length + 1);
  await expect(frame.locator(".pin.sess").first()).toBeVisible();
  await page.waitForTimeout(1200);
  await screenshot(app, "studio", "tower-session", page);

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
  const win = await openRound(app, page, { sessionId: session.id, itemId: firstRow, title: built.rounds[0]!.title });
  expect(rounds(app)).toHaveLength(1);
  await expect(win.getByTestId("round-title")).toContainText(built.rounds[0]!.title.slice(0, 6));
  await expect(win.locator(`[data-row-id="${firstRow}"], [data-item-id="${firstRow}"]`).first()).toBeInViewport();
  await expect(win.getByLabel("输入消息")).toHaveValue("草稿：弹窗里还在");
  // A window of its own, owned by the workbench (above it, never above other programs; it goes with it).
  expect(
    await app.evaluate(({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows();
      const round = all.find((w) => w.webContents.getURL().includes("#round"))!;
      return round.getParentWindow() === all.find((w) => !w.webContents.getURL().includes("#")) && !round.isAlwaysOnTop();
    }),
  ).toBe(true);
  // Under the building, the composer stepped aside: a faint line says where it is.
  await expect(page.getByLabel("输入消息")).toHaveCount(0);
  await expect(page.getByTestId("composer-away")).toContainText("输入栏在会话弹窗里");
  await page.getByTestId("composer-away-show").click();
  await win.waitForTimeout(600);
  // Nothing in it runs out of its sides (the composer's bar wraps in a narrow window).
  expect(await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await screenshot(app, "studio", "tower-popup", win, "round");
  await screenshot(app, "studio", "tower-popup-main", page);

  // Sent from the window: the AI is told about 脉络 with that message and titles the round and notes a point (the mock
  // model calls the tool it is told to); the workbench's conversation has it too, and the window stays.
  const note = `[[mcp: track_note ${JSON.stringify({ title: "核对掉落表数量", desc: "一共 3 张，和策划表对上了", points: ["数值一律按策划表来"] })}]]`;
  await win.getByLabel("输入消息").fill(note);
  await win.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(async () => (await tower()).rounds.at(-1)?.title, { timeout: 60_000 }).toBe("核对掉落表数量");
  const after = await tower();
  expect(after.rounds.at(-1)).toMatchObject({ labelled: true, desc: "一共 3 张，和策划表对上了" });
  expect(after.points).toMatchObject([{ text: "数值一律按策划表来", round: after.rounds.length }]);
  const sent = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!;
  expect(sent.text).toContain("这个会话开了「脉络」");
  await expect(thread.getByTestId("msg-user").last()).toContainText("核对掉落表数量");
  await expect(win.getByTestId("round-window")).toBeVisible();
  // The building is drawn anew with the new floor.
  await expect(frame.locator("#rail button[data-f]")).toHaveCount(after.rounds.length + 1, { timeout: 30_000 });

  // A draft written in the window comes back to the composer under the building when it closes.
  await win.getByLabel("输入消息").fill("窗口里写的草稿");
  await win.waitForTimeout(700);
  await win.getByTestId("round-close").click();
  await expect.poll(() => rounds(app).length).toBe(0);
  await expect(page.getByTestId("composer-away")).toHaveCount(0);
  await expect(page.getByLabel("输入消息")).toHaveValue("窗口里写的草稿");
  await page.getByLabel("输入消息").fill("");

  // The building's own card picked: closing its window (not pinned) lets the card go there.
  const opened = app.waitForEvent("window", { predicate: (w) => w.url().includes("#round") });
  await frame.locator("body").evaluate(() => (window as unknown as { __tower: { select(k: string): void } }).__tower.select("m1"));
  const marked = await opened;
  await expect(marked.getByTestId("round-window")).toBeVisible({ timeout: 30_000 });
  const sel = () => frame.locator("body").evaluate(() => (window as unknown as { __tower: { S: { sel: string | null } } }).__tower.S.sel);
  expect(await sel()).toBe("m1");
  await marked.getByTestId("round-close").click();
  await expect.poll(sel).toBeNull();
  // Not pinned: the building's empty space closes it (tower.unpick).
  const again = await openRound(app, page, { sessionId: session.id, itemId: after.rounds.at(-1)!.itemId, title: "核对掉落表数量" });
  await fromTower(page, { type: "tower.unpick" });
  await expect.poll(() => rounds(app).length).toBe(0);
  await expect(page.getByLabel("输入消息")).toBeVisible();

  // Pinned, the empty space leaves it; the next card opens a second window.
  const pinned = await openRound(app, page, { sessionId: session.id, itemId: after.rounds.at(-1)!.itemId, title: "核对掉落表数量" });
  expect(pinned).not.toBe(again);
  await pinned.getByTestId("round-pin").click();
  await expect(pinned.getByTestId("round-pin")).toHaveAttribute("aria-pressed", "true");
  await fromTower(page, { type: "tower.unpick" });
  await page.waitForTimeout(300);
  expect(rounds(app)).toHaveLength(1);
  await screenshot(app, "studio", "tower-popup-pinned", pinned, "round");
  await pinned.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await screenshot(app, "studio", "tower-popup-dark", pinned, "round");
  await pinned.evaluate(() => (document.documentElement.dataset.theme = "light"));
  // A card of the session it started: that session's conversation, in a new window (the pinned one stays as it was).
  const subRow = built.sessions[0]!.rounds[0]!.itemId!;
  const subWin = await openRound(app, page, { sessionId: sub.id, itemId: subRow, title: built.sessions[0]!.rounds[0]!.title });
  expect(rounds(app)).toHaveLength(2);
  await expect(subWin.getByTestId("round-title")).toContainText("子会话「数表」");
  await expect(pinned.getByTestId("round-title")).toContainText("核对掉落表数量");
  // Its first message is the one its starter sent (a folded 「…开启了这个会话」 row, not the person's bubble).
  await expect(subWin.getByTestId("msg-origin").first()).toContainText("数一下掉落表有几张", { timeout: 15_000 });
  await expect(subWin.getByTestId("msg-origin").first()).toBeInViewport();
  // The workbench stays on the building, its composer still in the pinned window (a sub-session's leaves it be).
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(page.getByTestId("tower-on")).toBeChecked();
  await expect(page.getByTestId("composer-away")).toBeVisible();
  // Not pinned: the next card is shown in it (no third window), and back.
  await fromTower(page, { type: "tower.pick", sessionId: session.id, itemId: firstRow, title: built.rounds[0]!.title });
  await expect(subWin.getByTestId("round-title")).toContainText(built.rounds[0]!.title.slice(0, 6));
  expect(rounds(app)).toHaveLength(2);
  await fromTower(page, { type: "tower.pick", sessionId: sub.id, itemId: subRow, title: built.sessions[0]!.rounds[0]!.title });
  await expect(subWin.getByTestId("round-title")).toContainText("子会话「数表」");
  await expect(subWin.getByTestId("msg-origin").first()).toContainText("数一下掉落表有几张", { timeout: 15_000 });

  // Annotated in the window, as in the conversation: select in its reply, 批注, write, save.
  const reply = subWin.getByTestId("msg-agent").first();
  await expect(reply).toBeVisible();
  const quote = ((await reply.locator("[data-src-start]").first().textContent()) ?? "").trim().slice(0, 4);
  expect(quote.length).toBe(4);
  await selectAndRelease(reply, quote);
  await expect(subWin.getByTestId("selection-bar")).toBeVisible();
  const width = await subWin.evaluate(() => window.innerWidth);
  const bar = (await subWin.getByTestId("selection-bar").boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(-1);
  expect(bar.x + bar.width).toBeLessThanOrEqual(width + 1);
  await subWin.getByTestId("selection-bar").getByRole("button", { name: "批注" }).click();
  const bubble = subWin.getByTestId("annotation-bubble");
  await expect(bubble.getByLabel("批注内容")).toBeFocused();
  const bubbleBox = (await bubble.boundingBox())!;
  expect(bubbleBox.x).toBeGreaterThanOrEqual(-1);
  expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(width + 1);
  await bubble.getByLabel("批注内容").fill("这句在弹窗里批注");
  await subWin.waitForTimeout(300);
  await screenshot(app, "studio", "tower-popup-annotate", subWin, "round");
  await bubble.getByLabel("批注内容").press("Control+Enter");
  await expect(bubble).toHaveCount(0);
  await expect.poll(async () => (await studio!.api<Annotation[]>("GET", `/api/sessions/${sub.id}/annotations`)).map((a) => [a.quote, a.note])).toEqual([[quote, "这句在弹窗里批注"]]);
  await expect(subWin.getByTestId("annotation-mark")).toHaveCount(1);
  // Ctrl+F finds in the window's conversation (Esc in its box closes the box, not the window).
  await subWin.keyboard.press("Control+f");
  await expect(subWin.getByTestId("find-bar")).toBeVisible();
  await subWin.getByTestId("find-input").press("Escape");
  await expect(subWin.getByTestId("find-bar")).toHaveCount(0);
  expect(rounds(app)).toHaveLength(2);

  // Esc closes the one not pinned; the pinned one stays.
  // (The window goes on the key going down: the press's key-up finds no page.)
  await subWin.locator("body").press("Escape").catch(() => undefined);
  await expect.poll(() => rounds(app).length).toBe(1);
  expect(rounds(app)[0]).toBe(pinned);

  // 对话 in the row above: the building goes, and its windows with it (the pinned one too); the composer is back.
  await page.getByTestId("tower-view-chat").click();
  await expect.poll(() => rounds(app).length).toBe(0);
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await expect(page.getByLabel("输入消息")).toBeVisible();
  await expect(thread.getByTestId("msg-origin").filter({ hasText: "子会话「数表」回报" })).toBeVisible();
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(frame.locator("#rail button[data-f]").first()).toBeVisible({ timeout: 30_000 });

  // 到对话里看: the window closes, the workbench shows the conversation of its session at the row read there.
  const lastRow = after.rounds.at(-1)!.itemId!;
  const toChat = await openRound(app, page, { sessionId: session.id, itemId: lastRow });
  await expect(toChat.getByTestId("round-pin")).toHaveAttribute("aria-pressed", "false");
  await toChat.getByTestId("round-chat").click();
  await expect.poll(() => rounds(app).length).toBe(0);
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await expect(page.getByTestId("tower-view-chat")).toHaveAttribute("aria-selected", "true");
  await expect(thread.locator(`[data-row-id="${lastRow}"], [data-item-id="${lastRow}"]`).first()).toBeInViewport();
  // Back to the building with the switch; unticking 脉络会话 returns the session to a plain conversation.
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  expect((await tower()).on).toBe(false);
});

test("Studio quits with 会话弹窗 windows open, a pinned one and one not", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["tracks"] });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "关窗", firstSession: { profileId: "claude-mock", text: "你好" } });
  await expect.poll(async () => (await studio!.api<TowerData>("GET", `/api/sessions/${session.id}/tracks`)).rounds.length, { timeout: 60_000 }).toBe(1);
  await page.getByTestId("task-card").first().click();
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect.poll(() => page.frames().some((f) => f.url().includes("tower.html"))).toBe(true);
  const first = await openRound(app, page, { sessionId: session.id });
  await first.getByTestId("round-pin").click();
  await expect(first.getByTestId("round-pin")).toHaveAttribute("aria-pressed", "true");
  await openRound(app, page, { sessionId: session.id });
  expect(rounds(app)).toHaveLength(2);
  // Left to go with the workbench, they kept quitting from finishing (app.close() hung, 2026-11-16).
  const s = studio;
  studio = undefined;
  await expect(Promise.race([s.close().then(() => "closed"), new Promise((r) => setTimeout(() => r("still running"), 30_000))])).resolves.toBe("closed");
});
