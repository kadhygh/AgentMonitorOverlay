import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, TodoItem, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Stage 7: whole-picture todos become tasks, projects show whether they are free, and the scheduler proposes work
// that the person approves.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a todo becomes a task in the group bound to its workspace", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const canvas = await studio.api<CanvasDoc>("GET", "/api/canvas");
  await studio.api("PUT", "/api/canvas", { ...canvas, groups: [{ id: "g-alpha", title: "alpha 玩法", workspaceId: ws.id, rect: { x: 40, y: 60, w: 520, h: 320 } }] });
  await studio.api<TodoItem>("POST", "/api/todos", { text: "统一掉落表格式", workspaceId: ws.id });

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("tab", { name: "整体待办" }).click();
  const todos = page.getByRole("group", { name: "整体待办" });
  await todos.getByRole("button", { name: "转为任务 统一掉落表格式" }).click();
  const form = todos.getByTestId("todo-convert");
  await expect(form.getByLabel("任务的工作区")).toHaveValue(ws.id);
  await form.getByLabel("任务的模型").selectOption({ label: "Codex · Mock 模型" });
  await screenshot(studio.app, "stage-7", "S7-01-convert", page);
  await form.getByRole("button", { name: "建任务" }).click();

  // The new task opens; it sits in the bound group; nothing was sent to a model.
  await expect(page.locator(".page-head")).toContainText("统一掉落表格式");
  const task = (await studio.api<{ tasks: Task[]; sessions: Session[] }>("GET", "/api/state")).tasks.find((t) => t.title === "统一掉落表格式")!;
  expect((await studio.api<CanvasDoc>("GET", "/api/canvas")).nodes.find((n) => n.kind === "task" && n.taskId === task.id)?.groupId).toBe("g-alpha");
  await expect(page.getByTestId("msg-user")).toHaveCount(0);

  // Back on the canvas the todo is done and links to its task.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("tab", { name: "整体待办" }).click();
  await expect(todos).toContainText("已完成 1");
  await todos.getByRole("button", { name: "打开任务 统一掉落表格式" }).click();
  await expect(page.locator(".page-head")).toContainText("统一掉落表格式");
});
