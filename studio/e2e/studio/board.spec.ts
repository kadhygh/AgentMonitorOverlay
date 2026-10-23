import { expect, test } from "@playwright/test";
import type { Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("registers a sandbox workspace and shows tasks on the board", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await expect(page.getByTestId("host-status")).toHaveText("Host 运行中");

  // Register through the UI (path input; the native folder picker is not driven in tests).
  const alpha = studio.workspace("alpha");
  await page.getByRole("button", { name: "+ 添加项目" }).click();
  await page.getByLabel("项目路径").fill(alpha);
  await page.getByRole("button", { name: "登记", exact: true }).click();
  await expect(page.getByTestId("scope-ws-alpha")).toBeVisible();
  // The common space is a project nobody picks: never listed.
  await expect(page.locator('[data-testid^="scope-ws-"]')).toHaveCount(1);
  await expect(page.locator(".brand")).toContainText("alpha");

  // Tasks are created through the API here; the new-task page arrives in S1-10.
  const ws = (await studio.api<{ workspaces: Workspace[] }>("GET", "/api/state")).workspaces.find((w) => !w.builtin)!;
  const waiting = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "校验掉落表",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo check]]" },
  });
  const quiet = await studio.api<{ task: Task }>("POST", "/api/tasks", {
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "整理一下配置项命名" },
  });
  await studio.api("PATCH", `/api/tasks/${quiet.task.id}`, { column: "review" });

  await page.getByTestId("scope-all").click();
  const doing = page.getByTestId("column-doing");
  const review = page.getByTestId("column-review");
  await expect(doing.getByTestId("task-card")).toHaveCount(1);
  await expect(doing).toContainText("校验掉落表");
  await expect(doing).toContainText("待批准", { timeout: 30_000 });
  await expect(review).toContainText("整理一下配置项命名");
  await expect(review).toContainText("空闲", { timeout: 30_000 });
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await expect(page.getByTestId("column-todo")).toContainText("空");

  // Scope filter: a topic holds only its own tasks.
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落表重构" });
  await page.getByTestId("scope-topic-掉落表重构").click();
  await expect(page.getByTestId("task-card")).toHaveCount(0);
  await studio.api("PATCH", `/api/tasks/${quiet.task.id}`, { topicId: topic.id });
  await expect(page.getByTestId("task-card")).toHaveCount(1);
  await page.getByTestId("scope-all").click();
  await expect(page.getByTestId("task-card")).toHaveCount(2);
  // 按专题分组 (on by default, 2026-10-19): the card sits under its topic; the one in none under 未归专题, last.
  await expect(page.getByTestId("board-group-topics")).toBeChecked();
  const reviewGroup = page.getByTestId("column-review").getByTestId("topic-group");
  await expect(reviewGroup).toHaveAttribute("data-topic", "掉落表重构");
  await expect(reviewGroup.getByTestId("task-card").getByTestId("card-where")).toHaveText("alpha");
  await expect(page.getByTestId("column-doing").getByTestId("topic-group")).toHaveAttribute("data-topic", "");
  await expect(page.getByTestId("column-doing").getByTestId("topic-group")).toContainText("未归专题");
  await screenshot(studio.app, "stage-18", "S18-board-groups", page);
  // Off: no groups; each card says 「专题 › 项目」 above its title.
  await page.getByTestId("board-group-topics").uncheck();
  await expect(page.getByTestId("topic-group")).toHaveCount(0);
  await expect(page.getByTestId("column-review").getByTestId("card-where")).toHaveText("掉落表重构›alpha");
  await expect(page.getByTestId("column-doing").getByTestId("card-where")).toHaveText("未归专题›alpha");
  await screenshot(studio.app, "stage-18", "S18-board-where", page);
  // A topic's own board names neither its topic nor offers the toggle.
  await page.getByTestId("scope-topic-掉落表重构").click();
  await expect(page.getByTestId("board-group-topics")).toHaveCount(0);
  await expect(page.getByTestId("card-where")).toHaveText("alpha");
  await page.getByTestId("scope-all").click();
  await page.getByTestId("board-group-topics").check();

  // Drag a card onto another column: the person moves cards. The whole column takes it, down to the page's bottom
  // (2026-10-17), not only the height of its cards.
  const done = page.getByTestId("column-done");
  const box = (await done.boundingBox())!;
  expect(box.height).toBeGreaterThan(300);
  await page.getByTestId("column-review").getByTestId("task-card").dragTo(done, { targetPosition: { x: box.width / 2, y: box.height - 20 } });
  await expect(page.getByTestId("column-done").getByTestId("task-card")).toContainText("整理一下配置项命名");
  await expect.poll(async () => (await studio!.api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === quiet.task.id)?.column).toBe("done");

  expect(waiting.session.kind).toBe("main");
  expect(await windowState(studio.app)).toMatchObject({ focused: false, anyFocused: false, onScreen: false });
  await screenshot(studio.app, "stage-1", "S1-09-board", page);
});

test("rejects a path that is not a directory", async () => {
  studio = await launchStudio({ mockModel: false });
  const { page } = studio;
  await page.getByRole("button", { name: "+ 添加项目" }).click();
  await page.getByLabel("项目路径").fill(`${studio.root}\\does-not-exist`);
  await page.getByRole("button", { name: "登记", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not a directory");
});

test("archived tasks leave the board; the 完成 column lists them, they open read-only and come back", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "旧的导入任务", workspaceId: ws.id });
  await studio.api("POST", "/api/tasks", { title: "还在做的", workspaceId: ws.id });
  await expect(page.getByTestId("archived-open")).toHaveCount(0);
  await studio.api("POST", `/api/tasks/${task.id}/archive`);
  await expect(page.getByTestId("task-card")).toHaveCount(1);

  await page.getByTestId("archived-open").click();
  await expect(page.getByTestId("archived-open")).toHaveText("已归档 1");
  const row = page.getByTestId("archived-list").getByTestId("archived-task");
  await expect(row).toContainText("旧的导入任务");
  await expect(row).toContainText("alpha");
  await screenshot(app, "stage-12", "S12-L-archived-tasks", page);
  await row.click();
  await expect(page.getByTestId("task-archived-banner")).toContainText("已归档 · 只读");
  await page.getByRole("button", { name: "恢复任务" }).click();
  await page.getByRole("button", { name: "返回看板" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(2);
  await expect(page.getByTestId("archived-open")).toHaveCount(0);
});

test("the 完成 column's right-click menu archives one topic group or every finished task (2026-10-22)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落表重构" });
  const make = async (title: string, column: string, topicId?: string) => {
    const { task } = await studio!.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id });
    await studio!.api("PATCH", `/api/tasks/${task.id}`, { column, ...(topicId ? { topicId } : {}) });
    return task;
  };
  await make("拆掉旧的掉落表", "done", topic.id);
  await make("补掉落表测试", "done", topic.id);
  await make("改日志格式", "done");
  await make("还在做的", "doing", topic.id);
  await page.getByTestId("scope-all").click();
  const done = page.getByTestId("column-done");
  await expect(done.getByTestId("task-card")).toHaveCount(3);

  // On a topic group (its head or its cards): that group alone, or the whole column.
  await done.locator('[data-testid="topic-group"][data-topic="掉落表重构"]').locator(".topic-group-head").click({ button: "right" });
  await expect(page.getByTestId("archive-done-group")).toHaveText("归档「掉落表重构」这一组（2）");
  await expect(page.getByTestId("archive-done-all")).toHaveText("归档全部已完成（3）");
  await screenshot(app, "stage-18", "S18-board-archive-done", page);
  await page.getByTestId("archive-done-group").click();
  await expect(page.getByTestId("done-menu")).toHaveCount(0);
  await expect(done.getByTestId("task-card")).toHaveCount(1);
  await expect(done.getByTestId("task-card")).toContainText("改日志格式");
  await expect(page.getByTestId("column-doing").getByTestId("task-card")).toContainText("还在做的");

  // On the column itself (no group there): only the whole column. Other columns have no such menu.
  await page.getByTestId("column-doing").click({ button: "right" });
  await expect(page.getByTestId("done-menu")).toHaveCount(0);
  await done.locator(".column-head").click({ button: "right" });
  await expect(page.getByTestId("archive-done-group")).toHaveCount(0);
  await page.getByTestId("archive-done-all").click();
  await expect(done.getByTestId("task-card")).toHaveCount(0);
  await expect(page.getByTestId("archived-open")).toHaveText("已归档 3");
  const state = await studio.api<{ tasks: Task[] }>("GET", "/api/state");
  expect(state.tasks.filter((t) => t.archivedAt).map((t) => t.title).sort()).toEqual(["拆掉旧的掉落表", "改日志格式", "补掉落表测试"].sort());
});

test("a card title with a long unbroken word (a path) wraps inside its card (2026-10-16)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", {
    title: "Message: …UIWidgets/Blizzard_UIWidgetTemplateTextWithStateAndSomeMoreWordsGluedTogether",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "看看这个报错" },
  });
  await page.getByTestId("scope-all").click();
  const card = page.getByTestId("task-card");
  await expect(card).toContainText("Blizzard_UIWidgetTemplate");
  const fits = await card.evaluate((el) => {
    const title = el.querySelector<HTMLElement>(".card-title")!;
    return { cardRight: el.getBoundingClientRect().right, titleRight: title.getBoundingClientRect().right, overflow: title.scrollWidth - title.clientWidth };
  });
  expect(fits.overflow).toBeLessThanOrEqual(0);
  expect(fits.titleRight).toBeLessThanOrEqual(fits.cardRight);
});
