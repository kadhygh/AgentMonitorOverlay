import { expect, test } from "@playwright/test";
import type { StateSnapshot, StudioSettings, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function registerWorkspaces(s: Studio, names: string[]): Promise<Workspace[]> {
  const out: Workspace[] = [];
  for (const name of names) out.push(await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace(name) }));
  return out;
}

test("creates a task from the blank task page and streams the first reply", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await registerWorkspaces(studio, ["alpha", "beta"]);
  await expect(page.getByTestId("scope-ws-beta")).toBeVisible();

  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByText("要推进什么？")).toBeVisible();
  // No dialog: the main area is the draft. No project is picked until the person picks one.
  await expect(page.getByLabel("第一句话")).toBeFocused();
  const projects = page.getByRole("group", { name: "项目" });
  await expect(projects.getByRole("button", { name: "不指定" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("scope-hint")).toContainText("不指定项目：在公共目录里运行");
  await projects.getByRole("button", { name: "alpha" }).click();
  await expect(page.getByTestId("scope-hint")).toContainText("在 alpha 里运行");
  // The model is a tile, one click; the effort is a set of bars; the permissions a segmented control.
  const tile = page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" });
  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  // Right click on a tile: that account's own models in a small menu.
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock Claude" }).click({ button: "right" });
  const menu = page.getByTestId("model-menu");
  await expect(menu.getByRole("menuitemradio")).toHaveText(["mock-claude", "mock-claude-b"]);
  await menu.getByRole("menuitemradio", { name: "mock-claude-b" }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("group", { name: "模型" }).locator('[data-testid="model-tile"][aria-pressed="true"]')).toContainText("mock-claude-b");
  await tile.click();
  await page.getByTestId("effort").getByRole("button", { name: "低" }).click();
  await expect(page.getByTestId("effort-label")).toHaveText("低");
  await expect(page.getByRole("group", { name: "权限" }).getByRole("button", { name: "逐条询问" })).toHaveAttribute("aria-pressed", "true");
  await screenshot(studio.app, "stage-1", "S1-10-new-task", page);

  await page.getByLabel("第一句话").fill("列出目录结构 [[slow]]");
  await page.getByRole("button", { name: "开始" }).click();

  await expect(page.getByTestId("task-title")).toHaveText("列出目录结构 [[slow]]");
  await expect(page.getByTestId("msg-user")).toHaveText(/列出目录结构/);
  // Just made, the task opens with its session list hidden (one session: nothing to choose between); 会话 shows it.
  await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("complementary", { name: "会话" })).toHaveCount(0);
  await expect(page.getByTestId("session-row")).toHaveCount(0);
  // While streaming, the reply grows and is marked as streaming (a pulsing dot); then it settles.
  await expect(page.getByTestId("msg-agent")).toHaveAttribute("data-streaming", "true", { timeout: 30_000 });
  await expect(page.getByTestId("msg-agent")).toContainText("slow slow");
  await expect(page.getByTestId("msg-agent")).not.toHaveAttribute("data-streaming", /.+/, { timeout: 30_000 });
  await screenshot(studio.app, "stage-1", "S1-10-first-reply", page);

  await page.getByRole("button", { name: "返回看板" }).click();
  await expect(page.getByTestId("column-doing").getByTestId("task-card")).toHaveCount(1);
});

test("files a task into 待办 in the topic in scope, without starting a session", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const [, beta] = await registerWorkspaces(studio, ["alpha", "beta"]);
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落表重构" });
  await page.getByTestId("scope-topic-掉落表重构").click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByRole("group", { name: "专题" }).getByRole("button", { name: "掉落表重构" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "beta" }).click();
  await page.getByLabel("第一句话").fill("Elite 掉落表补单元测试");
  await page.getByRole("button", { name: "放进待办" }).click();

  // Back on the board, in 待办; nothing ran.
  await expect(page.getByTestId("column-todo").getByTestId("task-card")).toContainText("Elite 掉落表补单元测试");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const task = state.tasks.find((t) => t.title === "Elite 掉落表补单元测试")!;
  expect(task).toMatchObject({ workspaceId: beta!.id, topicId: topic.id, column: "todo" });
  expect(state.sessions.filter((s) => s.taskId === task.id)).toEqual([]);
});

test("a task without a project runs in the common folder", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("第一句话").fill("Rust 生命周期报错怎么理解");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: Rust 生命周期报错怎么理解", { timeout: 30_000 });
  const { commonWorkspace } = await studio.api<StudioSettings>("GET", "/api/settings");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks[0]!.workspaceId).toBe(commonWorkspace.id);
  expect(state.sessions[0]!.workspaceId).toBe(commonWorkspace.id);
  // The page names no project for it.
  await expect(page.locator(".page-head")).toContainText("未指定项目");
});

test("@ and # pick the project and topic while typing; Ctrl N opens the quick bar with the same draft", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const [alpha] = await registerWorkspaces(studio, ["alpha", "beta"]);
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落表重构" });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const text = page.getByLabel("第一句话");
  await text.pressSequentially("校验掉落表 @al");
  await expect(page.getByTestId("suggest")).toContainText("alpha");
  await text.press("Enter");
  await text.pressSequentially(" #掉落");
  await text.press("Enter");
  await expect(text).toHaveValue("校验掉落表 ");
  await expect(page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "专题" }).getByRole("button", { name: "掉落表重构" })).toHaveAttribute("aria-pressed", "true");
  await screenshot(studio.app, "stage-10", "S10-draft-page", page);

  // Leave the page: the draft stays; Ctrl N shows it in the quick bar, which files it.
  await page.getByRole("button", { name: "返回看板" }).click();
  await page.keyboard.press("Control+N");
  const quick = page.getByRole("dialog", { name: "快速新任务" });
  await expect(quick.getByLabel("快速新任务")).toHaveValue("校验掉落表 ");
  await expect(quick).toContainText("@alpha");
  await expect(quick).toContainText("#掉落表重构");
  await screenshot(studio.app, "stage-10", "S10-quick-bar", page);
  await quick.getByLabel("快速新任务").press("Control+Enter");
  await expect(quick).toHaveCount(0);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks[0]).toMatchObject({ title: "校验掉落表", workspaceId: alpha!.id, topicId: topic.id, column: "todo" });
});

test("设置 → 默认路径: 选择文件夹 starts there when adding a project (2026-10-17, in place of 默认项目)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const root = studio.workspace("projects");
  const game = studio.workspace("game");
  type Pick = { started: Array<string | null>; answer: string | null };
  const picks = () => app.evaluate(() => (globalThis as { __amoPickDirectory?: Pick }).__amoPickDirectory ?? { started: [], answer: null });
  await app.evaluate((_e, answer) => {
    (globalThis as { __amoPickDirectory?: unknown }).__amoPickDirectory = { started: [], answer };
  }, game);

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "项目与目录" }).click();
  await expect(dialog.getByRole("radiogroup", { name: "默认项目" })).toHaveCount(0);
  const field = dialog.getByRole("textbox", { name: "默认路径" });
  await expect(field).toHaveValue("");
  await field.fill(root);
  await dialog.getByRole("region", { name: "默认路径" }).getByRole("button", { name: "保存" }).click();
  await screenshot(studio.app, "stage-16", "S16-A-default-folder", page);
  await page.keyboard.press("Escape");

  // Adding a project: the dialog starts at the default path; the folder picked becomes the project.
  await page.getByRole("button", { name: "+ 添加项目" }).click();
  await page.getByRole("button", { name: "选择文件夹…" }).click();
  await expect.poll(async () => (await picks()).started).toEqual([root]);
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).workspaces.some((w) => w.path === game)).toBe(true);

  // Cleared: from the system's own place again.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "项目与目录" }).click();
  await expect(field).toHaveValue(root);
  await dialog.getByRole("region", { name: "默认路径" }).getByRole("button", { name: "清除" }).click();
  await expect(field).toHaveValue("");
});
