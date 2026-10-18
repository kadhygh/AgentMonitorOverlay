import { expect, test } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 型号 / 思考强度 / 权限: chosen for a new task, switched inside a session (panel or a 常用预设 chip), and each choice
// reaches the model request (Codex sends model and reasoning effort with every turn).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

type ResponsesBody = { model?: string; reasoning?: { effort?: string } };

test("model, effort and permissions: new task, presets, switching inside a session", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const mock = studio.mock!;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const lastBody = (text: string) => mock.requests.filter((r) => r.lastUserText === text).at(-1)?.body as ResponsesBody | undefined;

  // A preset in 设置: full access (no more approvals) with low effort.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.getByTestId("models-nav-presets").click();
  const presets = dialog.getByRole("region", { name: "常用预设" });
  await presets.getByLabel("预设名称").fill("快速全自动");
  await presets.getByLabel("预设的模型").selectOption("codex-mock");
  await presets.getByLabel("思考强度").selectOption("low");
  await presets.getByLabel("权限").selectOption("full-auto");
  await presets.getByRole("button", { name: "添加预设" }).click();
  await expect(presets.getByTestId("preset-row")).toContainText("快速全自动");
  await expect(presets.getByTestId("preset-row")).toContainText("低");
  await presets.evaluate((el) => el.scrollIntoView());
  await screenshot(app, "stage-9", "options-presets", page);
  await page.keyboard.press("Escape");

  // New task with the highest effort: one click on the last bar.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  await page.getByTestId("effort").getByRole("button", { name: "最高" }).click();
  await expect(page.getByTestId("preset-chip")).toHaveText("快速全自动");
  await screenshot(app, "stage-9", "options-newtask", page);
  await page.getByLabel("第一句话").fill("first effort");
  await page.getByRole("button", { name: "开始" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: first effort", { timeout: 60_000 });
  expect(lastBody("first effort")?.reasoning?.effort).toBe("max");
  // Codex's own instructions only: Studio adds none.
  expect(JSON.stringify(lastBody("first effort"))).not.toContain("You are running inside AMO Studio");
  const summary = page.getByTestId("session-options");
  await expect(summary).toContainText("最高");
  await expect(summary).toContainText("逐条询问");

  // One click on the preset: low effort, full access — a command runs without an approval card.
  await page.getByTestId("preset-chip").filter({ hasText: "快速全自动" }).click();
  await expect(page.getByTestId("preset-chip").filter({ hasText: "快速全自动" })).toHaveAttribute("aria-pressed", "true");
  await expect(summary).toContainText("完全访问");
  const composer = page.getByLabel("输入消息");
  await composer.fill("[[shell: cmd /c echo auto-run]]");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-DONE", { timeout: 60_000 });
  await expect(page.locator('[data-testid="approval"]')).toHaveCount(0);
  expect(lastBody("[[shell: cmd /c echo auto-run]]")?.reasoning?.effort).toBe("low");

  // Back to high effort (a bar, no panel) and ask-every-command (the permission tray).
  await summary.getByTestId("effort").getByRole("button", { name: "高", exact: true }).click();
  await expect(summary.getByTestId("effort-label")).toHaveText("高");
  await page.getByTestId("switch-permission").click();
  const tray = page.getByRole("dialog", { name: "权限" });
  await expect(tray.getByRole("button", { name: /完全访问/ })).toHaveAttribute("aria-pressed", "true");
  await screenshot(app, "stage-9", "options-panel", page);
  await tray.getByRole("button", { name: /逐条询问/ }).click();
  await expect(tray).toHaveCount(0);
  await expect(summary).toContainText("逐条询问");
  await expect(page.getByTestId("options-note")).toContainText("下一轮生效");
  await composer.fill("after switching");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: after switching", { timeout: 60_000 });
  expect(lastBody("after switching")?.reasoning?.effort).toBe("high");
});

test("Fast (stage 13): a Codex model with a fast tier runs at it from the next turn, off again on a click", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const mock = studio.mock!;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const lastBody = (text: string) => mock.requests.filter((r) => r.lastUserText === text).at(-1)?.body as Record<string, unknown> | undefined;
  await studio.api("POST", "/api/tasks", { title: "Fast", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "standard speed" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: standard speed", { timeout: 60_000 });
  expect(lastBody("standard speed")?.service_tier).toBeUndefined();

  const summary = page.getByTestId("session-options");
  const fast = summary.getByTestId("fast-toggle");
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await expect(fast).toHaveAttribute("title", /2x speed, increased usage/);
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("options-note")).toContainText("Fast 已开，下一轮生效");
  await screenshot(app, "stage-13", "S13-C-fast", page);
  const composer = page.getByLabel("输入消息");
  await composer.fill("fast please");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: fast please", { timeout: 60_000 });
  expect(lastBody("fast please")?.service_tier).toBe("priority");

  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await composer.fill("standard again");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: standard again", { timeout: 60_000 });
  expect(lastBody("standard again")?.service_tier ?? "default").toBe("default");
});

test("Claude sessions offer Claude Code's models, efforts and permission modes", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "Claude 选项", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "hello", options: { effort: "high", permission: "plan" } } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 60_000 });
  const summary = page.getByTestId("session-options");
  await expect(summary).toContainText("高");
  await expect(summary).toContainText("只做计划");
  // Five effort bars, as Claude Code offers them.
  await expect(summary.getByTestId("effort").getByRole("button")).toHaveCount(5);
  // Models switch within the same account only.
  await page.getByTestId("switch-model").click();
  const models = page.getByRole("dialog", { name: "换型号" });
  await expect(models.getByRole("group", { name: "型号" }).getByRole("button")).toHaveText(["Mmock-claude", "Mmock-claude-b"]);
  await expect(models).toContainText("要换到别家的模型，新开一个会话。");
  await models.getByRole("button", { name: /mock-claude-b/ }).click();
  await expect(summary).toContainText("mock-claude-b");
  await expect(page.getByTestId("options-note")).toContainText("立即生效");
  // Permissions: Claude Code's modes as tiles.
  await page.getByTestId("switch-permission").click();
  const tray = page.getByRole("dialog", { name: "权限" });
  await expect(tray.locator("b")).toHaveText(["每次询问", "自动接受编辑", "只做计划", "全部允许"]);
  await tray.getByRole("button", { name: /自动接受编辑/ }).click();
  await expect(summary).toContainText("自动接受编辑");
  expect(studio.claudeMock!.requests.filter((r) => r.lastUserText === "hello" && r.tools.length).at(-1)?.body).toMatchObject({ output_config: { effort: "high" } });
});

test("设置 → 模型: models in the person's order, their default model, effort and permissions for new sessions", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const mock = studio.claudeMock!;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.locator('[data-testid="channel-nav"][data-id="claude-mock"]').click();
  const section = dialog.getByRole("region", { name: "型号顺序和默认" });
  const rows = section.getByTestId("model-order-row");
  await expect(rows.locator(".model-order-name")).toHaveText(["mock-claude", "mock-claude-b"]);

  // Reorder (the keyboard way of the drag), then make the second one the default.
  await rows.first().focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(rows.locator(".model-order-name")).toHaveText(["mock-claude-b", "mock-claude"]);
  await rows.nth(1).dragTo(rows.nth(0), { targetPosition: { x: 20, y: 2 } });
  await expect(rows.locator(".model-order-name")).toHaveText(["mock-claude", "mock-claude-b"]);
  await rows.nth(1).getByRole("button", { name: "设为默认" }).click();
  await expect(rows.nth(1).getByRole("button", { name: "默认" })).toHaveAttribute("aria-pressed", "true");
  await section.getByLabel("默认思考强度").selectOption("high");
  await section.getByLabel("默认权限").selectOption("plan");
  await expect.poll(async () => (await studio!.api<{ modelPrefs: Record<string, unknown> }>("GET", "/api/settings")).modelPrefs["claude-mock"]).toEqual({ order: ["mock-claude", "mock-claude-b"], model: "mock-claude-b", effort: "high", permission: "plan" });
  await screenshot(app, "stage-12", "S12-J-model-defaults", page);
  await page.keyboard.press("Escape");

  // A new session with nothing chosen gets them, and says which model it runs by name.
  await studio.api("POST", "/api/tasks", { title: "默认选项", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "defaults please" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: defaults please", { timeout: 60_000 });
  await expect(page.getByTestId("thread-model")).toHaveText("Mock Claude · mock-claude-b");
  const summary = page.getByTestId("session-options");
  await expect(summary).toContainText("mock-claude-b");
  await expect(summary).toContainText("只做计划");
  const body = mock.requests.filter((r) => r.lastUserText === "defaults please" && r.tools.length).at(-1)!.body as Record<string, unknown>;
  expect(body).toMatchObject({ model: "mock-claude-b", output_config: { effort: "high" } });
});
