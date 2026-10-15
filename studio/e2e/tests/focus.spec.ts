import { expect, test } from "@playwright/test";
import type { Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const focusIgnore = (s: Studio) => s.app.evaluate(() => (globalThis as { __amoFocusIgnore?: boolean }).__amoFocusIgnore);

test("Focus lists what needs me, approves in place and opens the workbench", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "掉落表校验",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo focus-approved]]" },
  });

  // Tests start with Focus off; turn it on from the top bar.
  const toggle = page.getByRole("button", { name: /^Focus/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const opened = app.waitForEvent("window");
  await toggle.click();
  const focus = await opened;
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Red line 7 and the window's nature: off-screen, never focused, not focusable, on top.
  await expect.poll(() => windowState(app, "focus")).toMatchObject({ visible: true, onScreen: false, anyFocused: false, focusable: false, alwaysOnTop: true });

  // The pending approval shows up, opened, with the command.
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1", { timeout: 30_000 });
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("掉落表校验");
  await expect(entry).toContainText("待批准");
  await expect(focus.getByTestId("focus-snippet")).toContainText("cmd /c echo focus-approved");

  // The whole panel takes clicks (the window's shape is the panel; the rest lets clicks through by itself).
  await focus.getByTestId("focus-panel").hover();
  await focus.mouse.move(5, 5);
  expect(await focusIgnore(studio)).toBe(false);
  await screenshot(app, "stage-3", "S3-07-focus", focus, "focus");

  // "在工作台打开" shows that session in the workbench.
  await focus.getByRole("button", { name: "在工作台打开" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("掉落表校验");
  await expect(page.getByTestId("approval").first()).toHaveAttribute("data-state", "pending");

  // Approve in place.
  await focus.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByTestId("approval").first()).toHaveAttribute("data-state", "accepted");
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });
  await expect(focus.getByTestId("focus-entry")).toHaveCount(0);
  await expect
    .poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.status, { timeout: 30_000 })
    .not.toBe("awaiting-approval");

  // Turning it off closes the window.
  const closed = focus.waitForEvent("close");
  await toggle.click();
  await closed;
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect((await windowState(app)).anyFocused).toBe(false);
});

test("Focus shows a Codex async question at once, while the model is still working (stage 13)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });

  // request_user_input_async: the model asks, then goes on for about three seconds ([[slow]]).
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "季节",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[ask-async]] [[slow]] 问我一个" },
  });
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1", { timeout: 30_000 });
  await expect(focus.getByTestId("focus-snippet")).toContainText("你最喜欢哪个季节？");
  // Before stage 13 this waited for the end of the turn; now the turn is still running.
  const items = await studio.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`);
  expect(items.some((i) => i.type === "turn" && i.state === "running")).toBe(true);
  await screenshot(app, "stage-13", "S13-C-focus-async-question", focus, "focus");
  // When the turn ends the question is still open: still waiting for the person.
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).some((i) => i.type === "turn" && i.state === "running"), { timeout: 30_000 }).toBe(false);
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1");
});

test("Focus: the robot dances until looked at; 「Focus 设置」 moves, locks, lets clicks through and hides it (S14-J/K)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const toggle = page.getByRole("button", { name: /^Focus/ });
  const opened = app.waitForEvent("window");
  await toggle.click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });
  await expect(focus.getByTestId("focus-bot")).toHaveCount(0);

  // Something needs the person: the panel glows and the robot pops up above it.
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "机器人提醒",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo bot]]" },
  });
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1", { timeout: 30_000 });
  const bot = focus.getByTestId("focus-bot");
  await expect(bot).toBeVisible();
  await expect(bot).toContainText("1 件事等你");
  await expect(focus.getByTestId("focus-panel")).toHaveClass(/alerting/);
  await screenshot(app, "stage-14", "S14-J-focus-robot", focus, "focus");

  // The robot opens what needs the person, and leaves: it has been seen (it still needs them).
  await bot.click();
  await expect(page.getByTestId("task-title")).toHaveText("机器人提醒");
  await expect(bot).toHaveCount(0);
  await expect(focus.getByTestId("focus-panel")).not.toHaveClass(/alerting/);
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1");

  // The app's icon at the front brings the main window forward, where it is.
  const shown = () => app.evaluate(() => (globalThis as { __amoMainShown?: number }).__amoMainShown ?? 0);
  const before = await shown();
  await focus.getByTestId("focus-home").click();
  await expect.poll(shown).toBe(before + 1);
  await expect(page.getByTestId("task-title")).toHaveText("机器人提醒");

  // The fold button says what it does.
  const fold = focus.getByTestId("focus-compact");
  await expect(fold).toHaveAttribute("title", "收起成一行");
  await fold.click();
  await expect(fold).toHaveAttribute("title", "展开会话列表");
  await expect(focus.getByTestId("focus-entry")).toHaveCount(0);
  await fold.click();

  // The window is only what Focus draws: its shape follows the panel.
  const shape = () => app.evaluate(() => (globalThis as { __amoFocusShape?: Array<{ x: number; y: number; width: number; height: number }> }).__amoFocusShape ?? []);
  await expect.poll(async () => (await shape()).length).toBeGreaterThan(0);
  const panelOnly = (await shape()).reduce((a, r) => a + r.width * r.height, 0);
  expect(panelOnly).toBeLessThan(380 * 560);
  expect(await focusIgnore(studio)).toBe(false);

  // Right-click (or the gear): 「Focus 设置」, a box with ×; the window's shape grows to take it.
  await focus.getByTestId("focus-entry").click({ button: "right" });
  const menu = focus.getByTestId("focus-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".focus-pop-row")).toHaveCount(6);
  for (const label of ["移动位置", "锁定位置", "点击穿透", "收起成一行", "打开 Studio 主窗口", "隐藏 Focus"]) await expect(menu).toContainText(label);
  await expect.poll(async () => (await shape()).reduce((a, r) => a + r.width * r.height, 0)).toBeGreaterThan(panelOnly);
  await screenshot(app, "stage-14", "S14-J-focus-menu", focus, "focus");
  await focus.getByTestId("focus-menu-close").click();
  await expect(menu).toHaveCount(0);

  // 移动位置: an action — the box closes and a drag frame covers the panel until 完成.
  await focus.getByTestId("focus-settings-toggle").click();
  await focus.getByTestId("focus-menu-move").click();
  await expect(menu).toHaveCount(0);
  await expect(focus.getByTestId("focus-move")).toBeVisible();
  await screenshot(app, "stage-14", "S14-J-focus-move", focus, "focus");
  await focus.getByTestId("focus-move-done").click();
  await expect(focus.getByTestId("focus-move")).toHaveCount(0);

  // 锁定位置: a switch — the box stays open; shown in the head, moving is off; remembered after a reload.
  await focus.getByTestId("focus-settings-toggle").click();
  await focus.getByTestId("focus-menu-lock").click();
  await expect(menu).toBeVisible();
  await expect(focus.getByTestId("focus-menu-lock")).toHaveAttribute("aria-checked", "true");
  await expect(focus.getByTestId("focus-menu-move")).toBeDisabled();
  await expect(focus.getByTestId("focus-panel")).toHaveAttribute("data-locked", "true");
  await expect(focus.getByTestId("focus-locked")).toBeVisible();
  await focus.reload();
  await expect(focus.getByTestId("focus-locked")).toBeVisible({ timeout: 30_000 });
  await focus.getByTestId("focus-settings-toggle").click();
  await expect(focus.getByTestId("focus-menu-lock")).toHaveAttribute("aria-checked", "true");
  await focus.getByTestId("focus-menu-lock").click();
  await expect(focus.getByTestId("focus-locked")).toHaveCount(0);

  // 点击穿透: once the box closes, clicks fall through Focus except on its buttons.
  await focus.getByTestId("focus-menu-through").click();
  await expect(focus.getByTestId("focus-menu-through")).toHaveAttribute("aria-checked", "true");
  expect(await focusIgnore(studio)).toBe(false);
  await focus.getByTestId("focus-menu-close").click();
  await expect(focus.getByTestId("focus-passthrough")).toBeVisible();
  await expect.poll(() => focusIgnore(studio!)).toBe(true);
  await screenshot(app, "stage-14", "S14-K-focus-passthrough", focus, "focus");
  await focus.getByTestId("focus-settings-toggle").click();
  await focus.getByTestId("focus-menu-through").click();
  await expect(focus.getByTestId("focus-passthrough")).toHaveCount(0);

  // 隐藏 Focus: the window goes, the top bar button follows.
  const closed = focus.waitForEvent("close");
  await focus.getByTestId("focus-menu-hide").click();
  await closed;
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect((await windowState(app)).anyFocused).toBe(false);
});

test("Focus shows the 额度 that 设置 → 额度 marks for it", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const channel = await studio.api<{ id: string }>("POST", "/api/channels", { kind: "codex", label: "中转 GPT", baseUrl: studio.mock!.baseUrl, key: "mock-channel-key", balance: { template: "general" } });
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toBeVisible();
  await expect(focus.getByTestId("focus-quota")).toHaveCount(0);
  await studio.api("PUT", "/api/settings", { quotaDisplay: { [channel.id]: { footer: true, focus: true } } });
  await expect(focus.getByTestId("focus-quota")).toHaveText("中转 GPT $12.50");
  await screenshot(app, "stage-14", "S14-H-focus-quota", focus, "focus");
});
