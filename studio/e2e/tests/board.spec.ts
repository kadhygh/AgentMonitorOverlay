import { expect, test } from "@playwright/test";
import type { Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

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
  await expect(page.getByTestId("column-review").getByTestId("task-card")).toContainText("专题 掉落表重构");

  // Drag a card onto another column: the person moves cards.
  await page.getByTestId("column-review").getByTestId("task-card").dragTo(page.getByTestId("column-done"));
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
