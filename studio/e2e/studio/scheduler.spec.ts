import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, TodoItem, Workspace, Topic } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 7: whole-picture todos become tasks, projects show whether they are free, and the scheduler proposes work
// that the person approves.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a todo converted on a topic's canvas joins the topic, in the group bound to its workspace", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...canvas, groups: [{ id: "g-alpha", title: "alpha 玩法", workspaceId: ws.id, rect: { x: 40, y: 60, w: 520, h: 320 } }] });
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
  expect((await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes.find((n) => n.kind === "task" && n.taskId === task.id)?.groupId).toBe("g-alpha");
  await expect(page.getByTestId("msg-user")).toHaveCount(0);

  // Back on the canvas the todo is done and links to its task.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("tab", { name: "整体待办" }).click();
  await expect(todos).toContainText("已完成 1");
  await todos.getByRole("button", { name: "打开任务 统一掉落表格式" }).click();
  await expect(page.locator(".page-head")).toContainText("统一掉落表格式");
});

test("canvas groups bound to a workspace say whether the project is free", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...canvas,
    groups: [
      { id: "g-alpha", title: "alpha 玩法", workspaceId: alpha.id, rect: { x: 40, y: 60, w: 420, h: 260 } },
      { id: "g-beta", title: "beta 工具", workspaceId: beta.id, rect: { x: 500, y: 60, w: 420, h: 260 } },
    ],
  });
  await studio.api<TodoItem>("POST", "/api/todos", { text: "alpha 的事", workspaceId: alpha.id });
  await studio.api<TodoItem>("POST", "/api/todos", { text: "beta 的事", workspaceId: beta.id });
  // A slow turn keeps alpha busy for a while.
  await studio.api("POST", "/api/tasks", { title: "跑着的", workspaceId: alpha.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "慢慢来 [[slow]]" } });

  await page.getByRole("button", { name: "画布", exact: true }).click();
  const group = (title: string) => page.locator(".canvas-group").filter({ hasText: title }).getByTestId("group-activity");
  await expect(group("alpha 玩法")).toHaveText("忙碌 · 1 个会话");
  await expect(group("beta 工具")).toHaveText("空闲");
  // Todos for a free project come first.
  await page.getByRole("tab", { name: "整体待办" }).click();
  const todos = page.getByRole("group", { name: "整体待办" }).getByTestId("todo");
  await expect(todos.first()).toContainText("beta 的事");
  await expect(todos.first()).toContainText("现在空闲");
  await screenshot(studio.app, "stage-7", "S7-02-activity", page);
  // When the turn ends, alpha is free again.
  await expect(group("alpha 玩法")).toHaveText("空闲", { timeout: 60_000 });
});

test("scheduler proposals wait on the board until the person approves or rejects them", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const a = await studio.api<TodoItem>("POST", "/api/todos", { text: "统一掉落表格式", workspaceId: ws.id });
  const b = await studio.api<TodoItem>("POST", "/api/todos", { text: "清理导表脚本", workspaceId: ws.id });
  await studio.api("POST", "/api/proposals", { todoId: a.id, profileId: "claude-mock", prompt: "统一 drops.json 的字段", reason: "alpha 空闲，这条最早" });
  await studio.api("POST", "/api/proposals", { todoId: b.id, profileId: "codex-mock", prompt: "删掉 tools/old_export" });

  // The board shows them, and they count as needing the person; nothing has started.
  const cards = page.getByTestId("proposal-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 2/);
  await expect(cards.first()).toContainText("在 alpha · 现在空闲 · alpha 空闲，这条最早");
  expect((await studio.api<{ tasks: Task[] }>("GET", "/api/state")).tasks).toEqual([]);

  // Focus only counts them and sends the person to the board.
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await app.waitForEvent("window");
  await expect(focus.getByTestId("focus-proposals")).toContainText("2 条调度提案");
  await screenshot(studio.app, "stage-7", "S7-03-proposals", page);

  // Reject one; approve the other with an edited prompt and model: the task opens and its first turn runs.
  await cards.filter({ hasText: "清理导表脚本" }).getByRole("button", { name: "拒绝" }).click();
  await expect(cards).toHaveCount(1);
  await cards.first().getByLabel("提案提示词").fill("统一 drops.json 的字段，先别改 skills");
  await cards.first().getByLabel("提案模型").selectOption({ label: "Codex · Mock 模型" });
  await cards.first().getByRole("button", { name: "批准开工" }).click();
  await expect(page.locator(".page-head")).toContainText("统一掉落表格式");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 统一 drops.json 的字段，先别改 skills", { timeout: 60_000 });
  await expect(focus.getByTestId("focus-proposals")).toHaveCount(0);
});

test("stage 7 acceptance: a scheduler round by hand, a proposal, approval, work starts", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...canvas, groups: [{ id: "g-alpha", title: "alpha 玩法", workspaceId: alpha.id, rect: { x: 40, y: 60, w: 520, h: 300 } }] });
  const todo = await studio.api<TodoItem>("POST", "/api/todos", { text: "统一掉落表格式", workspaceId: alpha.id });

  // The person starts one round from the todo tab; the round's session opens in the fixed "调度" task.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("tab", { name: "整体待办" }).click();
  const todos = page.getByRole("group", { name: "整体待办" });
  await expect(todos.getByTestId("todo").first()).toContainText("现在空闲");
  await todos.getByLabel("调度用的模型").selectOption({ label: "Codex · Mock 模型" });
  await todos.getByRole("button", { name: "让调度看一次" }).click();
  await expect(page.locator(".page-head")).toContainText("调度");
  await expect(page.getByTestId("msg-user").first()).toContainText(`todoId=${todo.id}：统一掉落表格式（适合：alpha）`);
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 你是 AMO Studio 的调度 agent", { timeout: 60_000 });

  // The mock model proposes only when told to: the person asks it to, the way the real model would on its own.
  const composer = page.getByLabel("输入消息");
  await composer.fill(`[[mcp: schedule_propose {"todoId":"${todo.id}","workspace":"${alpha.id}","profileId":"codex-mock","prompt":"统一 drops.json 的字段","reason":"alpha 空闲"}]]`);
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-MCP:", { timeout: 60_000 });
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);

  // On the board: approve; the todo's task starts with the proposed prompt. (The round was opened from the canvas,
  // so the task page's "←" goes back there; the board is the top bar's tab.)
  await page.getByRole("button", { name: "返回画布" }).click();
  await page.getByRole("button", { name: "看板", exact: true }).click();
  const card = page.getByTestId("proposal-card");
  await expect(card).toContainText("统一掉落表格式");
  await expect(card).toContainText("alpha 空闲");
  await screenshot(studio.app, "stage-7", "S7-05-acceptance", page);
  await card.getByRole("button", { name: "批准开工" }).click();
  await expect(page.locator(".page-head")).toContainText("统一掉落表格式");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 统一 drops.json 的字段", { timeout: 60_000 });
  const state = await studio.api<{ tasks: Task[] }>("GET", "/api/state");
  const task = state.tasks.find((t) => t.title === "统一掉落表格式")!;
  // A proposal is approved on the board, outside any topic: the task joins none.
  expect(task.topicId).toBeNull();
  expect((await studio.api<TodoItem[]>("GET", "/api/todos")).find((t) => t.id === todo.id)).toMatchObject({ done: true, taskId: task.id });
});
