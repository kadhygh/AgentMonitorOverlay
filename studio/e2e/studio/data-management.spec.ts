import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Archiving a project or a topic from the left column, and 设置 → 数据管理: restoring, or deleting for good after a
// confirmation that says what goes with it (2026-10-14).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("projects and topics are archived from the left column; 数据管理 restores them or deletes them for good", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "数值" });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表", workspaceId: alpha.id, firstSession: { profileId: "codex-mock", text: "hello" } });
  await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "专题里的任务", workspaceId: beta.id, topicId: topic.id });
  const nav = page.getByRole("navigation", { name: "范围" });

  // 归档项目 from the project's right-click menu, after a confirmation.
  await nav.getByTestId("scope-ws-alpha").click({ button: "right" });
  await page.getByTestId("archive-project").click();
  const confirm = page.getByTestId("archive-scope-confirm");
  await expect(confirm).toContainText("归档项目「alpha」");
  await expect(confirm).toContainText("1 个任务");
  await screenshot(app, "stage-14", "S14-D-archive-project", page);
  await confirm.getByTestId("confirm-action").click();
  await expect(nav.getByTestId("scope-ws-alpha")).toHaveCount(0);
  await expect(page.getByTestId("task-card").filter({ hasText: "掉落表" })).toHaveCount(0);

  // 归档专题 from the topic's.
  await nav.getByTestId("scope-topic-数值").click({ button: "right" });
  await page.getByTestId("archive-topic").click();
  await page.getByTestId("archive-scope-confirm").getByTestId("confirm-action").click();
  await expect(nav.getByTestId("scope-topic-数值")).toHaveCount(0);

  // 设置 → 数据管理 lists both, newest first.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "数据管理" }).click();
  const rows = dialog.getByTestId("data-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("数值");
  await expect(rows.nth(1)).toContainText("alpha");
  await screenshot(app, "stage-14", "S14-D-data-management", page);

  // Restore the topic: it is back in the left column with its task.
  await rows.filter({ hasText: "数值" }).getByTestId("data-restore").click();
  await expect(dialog.getByTestId("data-message")).toContainText("已恢复专题「数值」");
  await expect(rows).toHaveCount(1);
  await expect(nav.getByTestId("scope-topic-数值")).toBeVisible();

  // Delete the project for good: the confirmation says what goes with it.
  await rows.filter({ hasText: "alpha" }).getByTestId("data-delete").click();
  const sure = page.getByTestId("data-delete-confirm");
  await expect(sure).toContainText("彻底删除项目「alpha」");
  await expect(sure).toContainText("1 个任务、1 个会话");
  await expect(sure).toContainText("项目文件夹本身和里面的文件不动");
  await screenshot(app, "stage-14", "S14-D-delete-confirm", page);
  await sure.getByTestId("confirm-action").click();
  await expect(dialog.getByTestId("data-message")).toContainText("已彻底删除项目「alpha」");
  await expect(dialog.getByTestId("data-empty")).toBeVisible();

  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.workspaces.some((w) => w.id === alpha.id)).toBe(false);
  expect(state.tasks.map((t) => t.title)).toEqual(["专题里的任务"]);
  expect(state.sessions).toHaveLength(0);
});
