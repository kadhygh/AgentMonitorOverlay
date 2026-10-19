import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Bookmark, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { selectAndRelease } from "./selection.js";
import { launchStudio, screenshot, type Studio } from "./studio.js";

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

  // The selection bar's 书签: under the task's topic; the same passage again is not added twice.
  await selectAndRelease(reply, "发现 3 张表");
  await page.getByTestId("selection-bookmark").click();
  await expect(page.getByTestId("toast")).toContainText("已加到「掉落」的书签");
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);
  await selectAndRelease(reply, "发现 3 张表");
  await page.getByTestId("selection-bookmark").click();
  await expect(page.getByTestId("toast")).toContainText("这段已经在「掉落」的书签里");
  const saved = await studio.api<Bookmark[]>("GET", `/api/bookmarks?topic=${topic.id}`);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ kind: "chat", sessionId: created.session.id, quote: "发现 3 张表", taskId: created.task.id });

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
