import { expect, test } from "@playwright/test";
import type { CanvasDoc, TodoItem, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("canvas sidebar: whole-picture todos and the agent view", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "整理导入流程", workspaceId: ws.id, firstSession: { profileId: "codex-mock" } });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);

  // Todos: add (with a workspace), complete, delete.
  await page.getByRole("tab", { name: "整体待办" }).click();
  const todos = page.getByRole("group", { name: "整体待办" });
  await todos.getByLabel("适合的工作区").selectOption({ label: "alpha" });
  await todos.getByLabel("新待办").fill("统一掉落表格式");
  await todos.getByLabel("新待办").press("Enter");
  await todos.getByLabel("新待办").fill("清理旧的导表脚本");
  await todos.getByLabel("新待办").press("Enter");
  await expect(todos.getByTestId("todo")).toHaveCount(2);
  await expect(todos.getByTestId("todo").first()).toContainText("适合：alpha");
  await todos.getByLabel("完成 清理旧的导表脚本").check();
  await expect(todos).toContainText("已完成 1");
  await expect.poll(async () => (await studio!.api<TodoItem[]>("GET", "/api/todos")).filter((t) => t.done).map((t) => t.text)).toEqual(["清理旧的导表脚本"]);
  await todos.getByRole("button", { name: "删除待办 清理旧的导表脚本" }).click();
  await expect(todos.getByTestId("todo")).toHaveCount(1);
  await screenshot(studio.app, "stage-3", "S3-05-todos", page);

  // Agent view: outline and JSON, refreshed when the canvas changes.
  await page.getByRole("tab", { name: "agent 视角" }).click();
  const view = page.getByTestId("agent-view");
  await expect(view).toContainText("未分组");
  await expect(view).toContainText("整理导入流程");
  await page.getByRole("button", { name: "+ 分组" }).click();
  await expect.poll(async () => (await studio!.api<CanvasDoc>("GET", "/api/canvas")).groups.length).toBe(1);
  await page.getByRole("tab", { name: "agent 视角" }).click();
  await expect(view).toContainText("分组「新分组」");
  await page.getByRole("button", { name: "JSON" }).click();
  const json = JSON.parse((await view.textContent())!) as { groups: unknown[]; ungrouped: { tasks: Array<{ title: string }> } };
  expect(json.groups).toHaveLength(1);
  expect(json.ungrouped.tasks.map((t) => t.title)).toEqual(["整理导入流程"]);
  expect(await view.textContent()).not.toMatch(/"pos"|"rect"/);
  await screenshot(studio.app, "stage-3", "S3-05-agent-view", page);
});
