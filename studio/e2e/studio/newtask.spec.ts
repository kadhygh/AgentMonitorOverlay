import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StateSnapshot, StudioSettings, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

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
  await expect(projects.getByRole("button", { name: "不选" })).toHaveAttribute("aria-pressed", "true");
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

test("the topic comes first and picks its one preferred project; Ctrl N opens the quick bar with the same draft (2026-10-29)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const [alpha, beta, gamma] = await registerWorkspaces(studio, ["alpha", "beta", "gamma"]);
  // 掉落表重构 has one project (beta, added by hand); 战斗数值 two (alpha by hand, gamma through a task).
  await studio.api<Topic>("POST", "/api/topics", { title: "掉落表重构", workspaceIds: [beta!.id] });
  const battle = await studio.api<Topic>("POST", "/api/topics", { title: "战斗数值", workspaceIds: [alpha!.id] });
  await studio.api("POST", "/api/tasks", { title: "Boxer 墙距", workspaceId: gamma!.id, topicId: battle.id });
  await page.getByRole("button", { name: "+ 新任务" }).click();

  // 专题 is above 项目.
  const topics = page.getByRole("group", { name: "专题" });
  const projects = page.getByRole("group", { name: "项目" });
  expect((await topics.boundingBox())!.y).toBeLessThan((await projects.boundingBox())!.y);
  await expect(topics.getByRole("button").first()).toHaveText("不选");
  await expect(projects.getByRole("button").first()).toHaveText("不选");

  // One preferred project: picked with the topic, first in the row and marked 专题常用.
  await topics.getByRole("button", { name: "掉落表重构" }).click();
  await expect(projects.getByRole("button", { name: /beta/ })).toHaveAttribute("aria-pressed", "true");
  await expect(projects.getByRole("button").nth(1)).toHaveText("beta专题常用");
  await expect(page.getByTestId("scope-hint")).toContainText("在 beta 里运行 · 放进「掉落表重构」");
  // Two: both first, neither picked (the one picked by the topic goes again).
  await topics.getByRole("button", { name: "战斗数值" }).click();
  await expect(projects.locator('button[aria-pressed="true"]')).toHaveText("不选");
  await expect(projects.locator(".chip-tag")).toHaveCount(2);
  await expect(projects.getByRole("button").nth(3)).toHaveText("beta");
  // A project picked by hand stays when the topic changes.
  await projects.getByRole("button", { name: "beta" }).click();
  await topics.getByRole("button", { name: "掉落表重构" }).click();
  await topics.getByRole("button", { name: "不选" }).click();
  await expect(projects.getByRole("button", { name: /beta/ })).toHaveAttribute("aria-pressed", "true");
  await topics.getByRole("button", { name: "掉落表重构" }).click();

  // # is plain text now.
  const text = page.getByLabel("第一句话");
  await text.pressSequentially("校验掉落表 #1");
  await expect(page.getByTestId("suggest")).toHaveCount(0);
  await expect(text).toHaveValue("校验掉落表 #1");
  await screenshot(studio.app, "stage-10", "S10-draft-page", page);
  await screenshot(studio.app, "studio", "newtask-topic-first-light", page);

  // Leave the page: the draft stays; Ctrl N shows it in the quick bar, with the topic and project as two pickers.
  await page.getByRole("button", { name: "返回看板" }).click();
  await page.keyboard.press("Control+N");
  const quick = page.getByRole("dialog", { name: "快速新任务" });
  await expect(quick.getByLabel("快速新任务")).toHaveValue("校验掉落表 #1");
  await expect(quick.getByTestId("quick-topic")).toHaveAccessibleName("专题：掉落表重构");
  await expect(quick.getByTestId("quick-project")).toHaveAccessibleName("项目：beta");
  await expect(quick.getByTestId("quick-project")).toContainText("专题常用");
  // The topic picker: 不选 first, then the topics. Another topic keeps beta (picked by hand, not by the topic).
  await quick.getByTestId("quick-topic").click();
  const picker = page.getByTestId("choice-picker");
  await expect(picker.getByRole("option").first()).toContainText("不选");
  await picker.getByLabel("搜索专题").fill("战斗");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await picker.getByLabel("搜索专题").press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(quick.getByTestId("quick-topic")).toHaveAccessibleName("专题：战斗数值");
  await expect(quick.getByTestId("quick-project")).toHaveAccessibleName("项目：beta");
  await expect(quick.getByLabel("快速新任务")).toBeFocused();
  // The project picker lists 战斗数值's projects first.
  await quick.getByTestId("quick-project").click();
  await expect(picker.locator(".choice-picker-h").first()).toHaveText("专题常用");
  await expect(picker.getByRole("option").nth(1)).toContainText("alpha");
  await expect(picker.getByRole("option").nth(2)).toContainText("gamma");
  await screenshot(studio.app, "studio", "quick-bar-project-picker-light", page);
  await picker.getByLabel("搜索项目").press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(quick).toBeVisible();
  await screenshot(studio.app, "stage-10", "S10-quick-bar", page);
  await quick.getByLabel("快速新任务").press("Control+Enter");
  await expect(quick).toHaveCount(0);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks.find((t) => t.title === "校验掉落表 #1")).toMatchObject({ workspaceId: beta!.id, topicId: battle.id, column: "todo" });
});

test("编辑专题 sets its 常用项目, which the new-task page then picks with the topic (2026-10-29)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const [, beta] = await registerWorkspaces(studio, ["alpha", "beta"]);
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "数值" });
  await page.getByTestId("scope-topic-数值").click({ button: "right" });
  await page.getByTestId("edit-topic-item").click();
  const dialog = page.getByTestId("edit-topic");
  const row = dialog.getByTestId("edit-topic-projects");
  await expect(row.getByRole("button", { name: "beta" })).toHaveAttribute("aria-pressed", "false");
  await row.getByRole("button", { name: "beta" }).click();
  await expect(row.getByRole("button", { name: "beta" })).toHaveAttribute("aria-pressed", "true");
  await screenshot(studio.app, "studio", "edit-topic-projects-light", page);
  await dialog.getByTestId("edit-topic-save").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).topics.find((t) => t.id === topic.id)?.workspaceIds).toEqual([beta!.id]);

  // In the topic's scope, the new task starts in its one project.
  await page.getByTestId("scope-topic-数值").click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByRole("group", { name: "专题" }).getByRole("button", { name: "数值" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "项目" }).getByRole("button", { name: /beta/ })).toHaveAttribute("aria-pressed", "true");
});

test("「更多…」 opens a search over every project: typing filters, Enter picks (2026-10-29)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "BattleConfig", "battle-sim"];
  await registerWorkspaces(studio, names);
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const projects = page.getByRole("group", { name: "项目" });
  // Six chips besides 不选, then 更多… with the rest.
  await expect(projects.locator(".chip:not(.none):not(.more):not(.add)")).toHaveCount(6);
  const more = projects.getByTestId("more-项目");
  await expect(more).toHaveText("更多… 3");
  await more.click();
  const picker = page.getByTestId("choice-picker");
  await expect(picker.getByLabel("搜索项目")).toBeFocused();
  await expect(picker.locator(".choice-picker-h")).toHaveText(["全部"]);
  await expect(picker.getByRole("option")).toHaveCount(names.length);
  await picker.getByLabel("搜索项目").pressSequentially("battle");
  const options = picker.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await picker.getByLabel("搜索项目").press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  const second = (await options.nth(1).locator(".choice-name").textContent())!;
  expect(["BattleConfig", "battle-sim"]).toContain(second);
  await screenshot(studio.app, "studio", "newtask-more-picker-light", page);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await screenshot(studio.app, "studio", "newtask-more-picker-dark", page);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await picker.getByLabel("搜索项目").press("Enter");
  await expect(picker).toHaveCount(0);
  // The one picked is in the row now, still six chips, and the page says where the task runs.
  await expect(projects.getByRole("button", { name: second, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(projects.locator(".chip:not(.none):not(.more):not(.add)")).toHaveCount(6);
  await expect(page.getByTestId("scope-hint")).toContainText(`在 ${second} 里运行`);
  // Typing while a chip has the focus opens the search with that letter; Esc closes it and keeps the pick.
  await projects.getByRole("button", { name: "不选" }).focus();
  await page.keyboard.press("z");
  await expect(picker.getByLabel("搜索项目")).toHaveValue("z");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(picker.getByRole("option")).toContainText("zeta");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.getByText("要推进什么？")).toBeVisible();
  await expect(projects.getByRole("button", { name: second, exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("@ in the first sentence refers to a task (and its sessions) without changing the task's project (2026-10-29)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const [alpha] = await registerWorkspaces(studio, ["alpha", "beta"]);
  const { task: ref } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "冰冻炮迭代复核", workspaceId: alpha!.id, firstSession: { profileId: "codex-mock", text: "数值对比" } });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const text = page.getByLabel("第一句话");
  await text.pressSequentially("按 @冰");
  const suggest = page.getByTestId("suggest");
  await expect(suggest.locator(".suggest-h").first()).toHaveText("任务");
  await expect(suggest.getByRole("option").first()).toContainText("冰冻炮迭代复核");
  // The task's session is listed under it.
  await expect(suggest.locator("button.sub")).toHaveCount(1);
  await expect(suggest.locator("button.sub")).toContainText("└ 会话");
  // No project picked: no files yet.
  await expect(suggest.getByText("找文件…")).toHaveCount(0);
  await screenshot(studio.app, "studio", "newtask-at-task-light", page);
  await text.press("Enter");
  await expect(text).toHaveValue("按 @冰冻炮迭代复核 ");
  // The task's project was not picked by it.
  await expect(page.getByRole("group", { name: "项目" }).getByRole("button", { name: "不选" })).toHaveAttribute("aria-pressed", "true");
  // Projects are offered too; picking one keeps it in the text only.
  await text.pressSequentially("的结论改 @be");
  await expect(suggest.getByRole("option", { name: /beta/ })).toBeVisible();
  await text.press("Enter");
  await expect(text).toHaveValue("按 @冰冻炮迭代复核 的结论改 @beta ");
  await expect(page.getByRole("group", { name: "项目" }).getByRole("button", { name: "不选" })).toHaveAttribute("aria-pressed", "true");
  await text.press("Enter");

  // The first message says which task and project the names are; the bubble colours them.
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 按 @冰冻炮迭代复核", { timeout: 30_000 });
  const bubble = page.getByTestId("msg-user").first();
  await expect(bubble.getByTestId("msg-mention")).toHaveText(["@冰冻炮迭代复核", "@beta"]);
  await expect(bubble.getByTestId("msg-mention-brief")).toHaveAttribute("title", new RegExp(`AMO 任务 ${ref.id}`));
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const made = state.tasks.find((t) => t.id !== ref.id)!;
  expect(made.workspaceId).toBe((await studio.api<StudioSettings>("GET", "/api/settings")).commonWorkspace.id);
});

test("设置 → 默认路径: 选择文件夹 starts there when adding a project (2026-10-17, in place of 默认项目)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const root = studio.workspace("projects");
  const game = studio.workspace("game");

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

  // Adding a project: Studio's own picker (2026-10-25) starts at the default path; a folder made and one renamed
  // there; the folder picked becomes the project.
  mkdirSync(join(root, "old"));
  await page.getByRole("button", { name: "+ 添加项目" }).click();
  await page.getByRole("button", { name: "选择文件夹…" }).click();
  const picker = page.getByRole("dialog", { name: "选择文件夹" });
  await expect(picker.getByRole("textbox", { name: "路径" })).toHaveValue(root);
  await expect(picker.getByRole("group", { name: "磁盘" }).getByRole("button", { name: root.slice(0, 2).toUpperCase() })).toHaveAttribute("aria-pressed", "true");
  await picker.getByRole("button", { name: "+ 新建文件夹" }).click();
  await picker.getByRole("textbox", { name: "新文件夹的名字" }).fill("游戏");
  await picker.getByRole("textbox", { name: "新文件夹的名字" }).press("Enter");
  await expect(picker.getByRole("option", { name: "游戏" })).toHaveAttribute("aria-selected", "true");
  expect(existsSync(join(root, "游戏"))).toBe(true);
  await picker.getByRole("option", { name: "old" }).click();
  await picker.getByRole("listbox", { name: "文件夹" }).press("F2");
  await picker.getByRole("textbox", { name: "新名字" }).fill("client");
  await picker.getByRole("textbox", { name: "新名字" }).press("Enter");
  await expect(picker.getByRole("option", { name: "client" })).toHaveAttribute("aria-selected", "true");
  expect(existsSync(join(root, "client")) && !existsSync(join(root, "old"))).toBe(true);
  // A network path is never opened.
  await picker.getByRole("textbox", { name: "路径" }).fill("\\\\nas.example\\share");
  await picker.getByRole("textbox", { name: "路径" }).press("Enter");
  await expect(picker.getByRole("alert")).toContainText("网络路径");
  await picker.getByRole("option", { name: "游戏" }).click();
  await screenshot(studio.app, "stage-16", "S16-A-folder-picker", page);
  await picker.getByRole("button", { name: "选择「游戏」" }).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).workspaces.some((w) => w.path === join(root, "游戏"))).toBe(true);

  // A path typed in; no way to the system dialog (it hung again, 2026-10-25).
  await page.getByRole("button", { name: "添加项目", exact: true }).click();
  await page.getByRole("button", { name: "选择文件夹…" }).click();
  await expect(picker.getByRole("button", { name: "用系统对话框…" })).toHaveCount(0);
  await picker.getByRole("textbox", { name: "路径" }).fill(game);
  await picker.getByRole("textbox", { name: "路径" }).press("Enter");
  await expect(picker.getByRole("textbox", { name: "路径" })).toHaveValue(game);
  await picker.getByRole("button", { name: "选择这个文件夹" }).click();
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).workspaces.some((w) => w.path === game)).toBe(true);

  // Cleared: from beside the folder picked last.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "项目与目录" }).click();
  await expect(field).toHaveValue(root);
  await dialog.getByRole("region", { name: "默认路径" }).getByRole("button", { name: "清除" }).click();
  await expect(field).toHaveValue("");
});
