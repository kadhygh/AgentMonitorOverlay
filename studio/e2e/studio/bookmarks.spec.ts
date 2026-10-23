import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Bookmark, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { selectAndRelease } from "../support/selection.js";
import { launchStudio, longTurn, screenshot, showMainWindow, type Studio, confirmBookmarkNote } from "../support/studio.js";

// 书签 (2026-10-19): a passage of a reply bookmarked from the selection bar goes under the task's topic; the bookmarks
// window groups by topic, a passage row drags out as a quote and 打开对话 brings the workbench back to it, flashing
// it; the topic page's 书签 tab lists the topic's bookmarks.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openMarksWindow(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.getByTestId("task-marks").click();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

/** The texts painted by a CSS highlight, sorted. */
const painted = (page: Page, name: string) => page.evaluate((n) => [...(CSS.highlights.get(n) ?? [])].map((r) => (r as Range).toString()).sort(), name);

test("bookmarks a passage under the task's topic, drags it out as a quote, goes back to it and lists it on the topic page", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落" });
  const created = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "校验掉落表",
    workspaceId: ws.id,
    topicId: topic.id,
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await page.getByTestId("task-card").first().click();
  const reply = page.getByTestId("msg-agent").first();
  await expect(reply.locator("table.md-table")).toBeVisible({ timeout: 30_000 });

  // 书签说明 can be closed without a bookmark (2026-10-23): Esc, or ×.
  await selectAndRelease(reply, "发现 3 张表");
  await page.getByTestId("selection-bookmark").click();
  await page.getByTestId("bookmark-note-text").press("Escape");
  await expect(page.getByTestId("bookmark-note")).toHaveCount(0);
  await selectAndRelease(reply, "发现 3 张表");
  await page.getByTestId("selection-bookmark").click();
  await page.getByTestId("bookmark-note-cancel").click();
  await expect(page.getByTestId("bookmark-note")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toHaveCount(0);
  expect(await studio.api<Bookmark[]>("GET", `/api/bookmarks?topic=${topic.id}`)).toHaveLength(0);

  // The selection bar's 书签: under the task's topic; the same passage again is not added twice.
  await selectAndRelease(reply, "发现 3 张表");
  // 书签说明 first (the note may stay empty), then the notice.
  await page.getByTestId("selection-bookmark").click();
  await page.getByTestId("bookmark-note-text").fill("三张表都从这里来");
  await screenshot(app, "stage-18", "S18-bookmark-note", page);
  await confirmBookmarkNote(page);
  await expect(page.getByTestId("toast")).toContainText("书签添加成功：已加到「掉落」");
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);
  // The same passage again: no note asked, nothing added.
  await selectAndRelease(reply, "发现 3 张表");
  await page.getByTestId("selection-bookmark").click();
  await expect(page.getByTestId("toast")).toContainText("这段已经在「掉落」的书签里");
  await expect(page.getByTestId("bookmark-note")).toHaveCount(0);
  const saved = await studio.api<Bookmark[]>("GET", `/api/bookmarks?topic=${topic.id}`);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ kind: "chat", sessionId: created.session.id, quote: "发现 3 张表", taskId: created.task.id, note: "三张表都从这里来" });

  // The bookmarks window opens on the task's topic; the passage reads with where it came from.
  const marks = await openMarksWindow(app, page);
  expect(marks.url()).toContain(`#marks?topic=${topic.id}`);
  const group = marks.getByTestId("marks-group").first();
  await expect(group).toContainText("掉落");
  await expect(group).toContainText("当前专题");
  const row = marks.locator('[data-testid="mark-row"][data-kind="chat"]');
  await expect(row.getByTestId("mark-quote")).toHaveText("发现 3 张表");
  await expect(row).toContainText("校验掉落表");
  await row.getByTestId("mark-note").fill("三张表都要修");
  await expect(row).toContainText("已保存");

  // Dragged out: a quote, where it came from, and the note, as plain text a composer takes where it is dropped.
  const carried = await row.getByTestId("mark-drag").evaluate((el) => {
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return dt.getData("text/plain");
  });
  expect(carried).toMatch(/^> 发现 3 张表\n\n（校验掉落表 · .+）\n三张表都要修\n$/);
  await screenshot(app, "stage-18", "S18-bookmarks-window", marks, "marks");

  // 打开对话: the workbench goes back to the task (from the board here) and flashes the passage itself.
  await page.getByRole("button", { name: /返回看板|看板/ }).first().click();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await row.getByTestId("mark-open-passage").click();
  await expect(page.getByTestId("task-title")).toHaveText("校验掉落表");
  await expect.poll(() => painted(page, "amo-annotation-flash"), { timeout: 5_000 }).toEqual(["发现 3 张表"]);

  // The topic page's 书签 tab lists the topic's bookmarks.
  await page.getByRole("button", { name: /返回看板|看板/ }).first().click();
  await page.getByTestId(`scope-topic-掉落`).click();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("tab", { name: "书签" }).click();
  const side = page.getByTestId("topic-bookmarks");
  await expect(side.getByTestId("mark-quote")).toHaveText("发现 3 张表");
  await expect(side.getByTestId("mark-note")).toHaveValue("三张表都要修");
  await screenshot(app, "stage-18", "S18-topic-bookmarks", page);

  // Moved to 未归专题 from the window: it leaves the topic's tab.
  await row.getByTestId("mark-topic").selectOption({ label: "未归专题" });
  await expect(side.getByTestId("mark-row")).toHaveCount(0);
  await expect(marks.getByTestId("marks-group").filter({ hasText: "未归专题" })).toContainText("发现 3 张表");
});

test("打开对话 on a passage far up a long conversation scrolls it into view and keeps it there (2026-10-19)", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落" });
  const created = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "很长的对话",
    workspaceId: ws.id,
    topicId: topic.id,
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await page.getByTestId("task-card").first().click();
  const first = page.getByTestId("msg-agent").first();
  await expect(first.locator("table.md-table")).toBeVisible({ timeout: 30_000 });
  await selectAndRelease(first, "发现 3 张表");
  await page.getByTestId("selection-bookmark").click();
  await confirmBookmarkNote(page);
  await expect(page.getByTestId("toast")).toContainText("书签添加成功：已加到「掉落」");
  // Many more turns after it, each with code and a table, so the passage ends far above the end.
  for (let i = 0; i < 8; i++) {
    await studio.api("POST", `/api/sessions/${created.session.id}/messages`, { text: `[[markdown]] 第 ${i} 轮` });
    await expect(page.getByTestId("msg-agent")).toHaveCount(i + 2, { timeout: 30_000 });
  }
  const thread = page.getByTestId("thread");
  await expect.poll(() => thread.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(2000);

  const marks = await openMarksWindow(app, page);
  await page.getByRole("button", { name: /返回看板|看板/ }).first().click();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await marks.locator('[data-testid="mark-row"][data-kind="chat"]').getByTestId("mark-open-passage").click();
  await expect(page.getByTestId("task-title")).toHaveText("很长的对话");
  await expect.poll(() => painted(page, "amo-annotation-flash"), { timeout: 5_000 }).toEqual(["发现 3 张表"]);
  // On screen, and still there once everything has settled (code highlighting, folded turns).
  const passage = page.getByTestId("msg-agent").first().getByText("发现 3 张表");
  const onScreen = async () => {
    const view = (await thread.boundingBox())!;
    const box = await passage.boundingBox();
    if (!box) return "not rendered";
    return box.y >= view.y && box.y + box.height <= view.y + view.height ? "visible" : `off by ${Math.round(box.y - view.y)}px`;
  };
  await expect.poll(onScreen, { timeout: 3_000 }).toBe("visible");
  await page.waitForTimeout(1500);
  expect(await onScreen()).toBe("visible");
});

test("打开对话 on a passage with long turns above it, none drawn yet, still lands on it (2026-10-20)", async () => {
  // As people see it: shown, and turns folded as by default. Turns off screen are drawn only once in view (chat.css,
  // content-visibility), standing in at 300px before; the jump has to follow them as they take their real height
  // (the person's bookmark ended 12,000px below the view).
  studio = await launchStudio({ transcriptView: "standard" });
  const { app, page } = studio;
  await showMainWindow(app);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落" });
  const created = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "很长的对话",
    workspaceId: ws.id,
    topicId: topic.id,
    firstSession: { profileId: "codex-mock", text: longTurn(1) },
  });
  await page.getByTestId("task-card").first().click();
  const replies = page.getByTestId("msg-agent");
  const say = async (text: string) => {
    const n = await replies.count();
    await studio!.api("POST", `/api/sessions/${created.session.id}/messages`, { text });
    await expect(replies).toHaveCount(n + 1, { timeout: 30_000 });
  };
  await expect(replies).toHaveCount(1, { timeout: 30_000 });
  for (let i = 2; i <= 6; i++) await say(longTurn(i));
  // The passage in the 7th reply of 11: six long turns above it, four below.
  await say("[[markdown]]");
  const reply = replies.nth(6);
  await expect(reply.locator("table.md-table")).toBeVisible();
  await selectAndRelease(reply, "发现 3 张表");
  await page.getByTestId("selection-bookmark").click();
  await confirmBookmarkNote(page);
  await expect(page.getByTestId("toast")).toContainText("书签添加成功：已加到「掉落」");
  for (let i = 8; i <= 11; i++) await say(longTurn(i));

  const marks = await openMarksWindow(app, page);
  // From the board: the task page comes anew, none of its turns drawn yet.
  await page.getByRole("button", { name: /返回看板|看板/ }).first().click();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await marks.locator('[data-testid="mark-row"][data-kind="chat"]').getByTestId("mark-open-passage").click();
  await expect(page.getByTestId("task-title")).toHaveText("很长的对话");
  const thread = page.getByTestId("thread");
  const passage = reply.getByText("发现 3 张表");
  const onScreen = async () => {
    const view = (await thread.boundingBox())!;
    const box = await passage.boundingBox();
    if (!box) return "not rendered";
    return box.y >= view.y && box.y + box.height <= view.y + view.height ? "visible" : `off by ${Math.round(box.y - view.y)}px`;
  };
  await expect.poll(onScreen, { timeout: 3_000 }).toBe("visible");
  await page.waitForTimeout(1500);
  expect(await onScreen()).toBe("visible");
});
