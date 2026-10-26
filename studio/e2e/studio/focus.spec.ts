import { expect, test } from "@playwright/test";
import type { Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

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
  await expect(bot).toContainText("1 件事");
  await expect(bot).not.toContainText("完成待审核");
  await expect(bot).toHaveClass(/alert/);
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
  // So does the name next to it: the two are one button (2026-10-19).
  await focus.getByTestId("focus-home").getByText("Focus", { exact: true }).click();
  await expect.poll(shown).toBe(before + 2);
  await focus.getByTestId("focus-home").hover();
  await screenshot(app, "stage-18", "S18-focus-home", focus, "focus");

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
  await expect(menu.locator(".focus-pop-row")).toHaveCount(8);
  for (const label of ["移动位置", "锁定位置", "点击穿透", "收起成一行", "机器人动作测试", "打开 Studio 主窗口", "隐藏 Focus"]) await expect(menu).toContainText(label);
  await expect.poll(async () => (await shape()).reduce((a, r) => a + r.width * r.height, 0)).toBeGreaterThan(panelOnly);
  await screenshot(app, "stage-14", "S14-J-focus-menu", focus, "focus");
  await focus.getByTestId("focus-menu-close").click();
  await expect(menu).toHaveCount(0);

  // 移动位置: an action — the box closes and a drag frame covers the panel until 完成.
  await focus.getByTestId("focus-settings-toggle").click();
  await focus.getByTestId("focus-menu-move").click();
  await expect(menu).toHaveCount(0);
  await expect(focus.getByTestId("focus-move")).toBeVisible();
  // While moving the window may activate, so a press on the frame starts Windows' own move (10-22: Chromium dropped
  // the press on a window that cannot activate, and Focus would not move).
  await expect.poll(() => windowState(app, "focus")).toMatchObject({ focusable: true });
  await screenshot(app, "stage-14", "S14-J-focus-move", focus, "focus");
  await focus.getByTestId("focus-move-done").click();
  await expect(focus.getByTestId("focus-move")).toHaveCount(0);
  await expect.poll(() => windowState(app, "focus")).toMatchObject({ focusable: false, anyFocused: false });

  // A drag of the title row (10-26): the press that would be dropped makes the window activatable, so Windows' own move
  // starts; when the move ends it is unactivatable again. Tests drive the window messages themselves.
  const caption = (step: "pressed" | "entered" | "exited") =>
    app.evaluate((_e, s) => (globalThis as unknown as { __amoFocusCaption: Record<string, () => unknown> }).__amoFocusCaption[s]!(), step);
  await caption("pressed");
  await expect.poll(() => windowState(app, "focus")).toMatchObject({ focusable: true });
  await caption("entered");
  await caption("exited");
  await expect.poll(() => windowState(app, "focus")).toMatchObject({ focusable: false, anyFocused: false });

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

  // 主窗口回到屏幕中央 (2026-10-19): the main window, at its size, in the middle of the display Focus is on (tests only
  // record where: their windows stay off-screen).
  await focus.getByTestId("focus-menu-center").click();
  const centred = await expect
    .poll(() => app.evaluate(() => (globalThis as { __amoMainCentered?: { x: number; y: number; width: number; height: number; display: { x: number; y: number; width: number; height: number } } }).__amoMainCentered ?? null))
    .not.toBeNull()
    .then(() => app.evaluate(() => (globalThis as { __amoMainCentered?: { x: number; y: number; width: number; height: number; display: { x: number; y: number; width: number; height: number } } }).__amoMainCentered!));
  expect(Math.abs(centred.x + centred.width / 2 - (centred.display.x + centred.display.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(centred.y + centred.height / 2 - (centred.display.y + centred.display.height / 2))).toBeLessThanOrEqual(1);
  expect(centred.width).toBeLessThanOrEqual(centred.display.width);
  await focus.getByTestId("focus-settings-toggle").click();

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

test("Focus: a click Chromium dropped (it came with WM_MOUSEACTIVATE, the page never saw it) is given back (2026-10-15)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  const created = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "丢掉的点击",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo lost]]" },
  });
  const approve = focus.getByRole("button", { name: "批准", exact: true });
  await expect(approve).toBeVisible({ timeout: 30_000 });

  // Windows sent WM_MOUSEACTIVATE as the button went down over 批准 and Chromium dropped the press; it came up.
  const box = (await approve.boundingBox())!;
  const zoom = await focus.evaluate(() => window.outerWidth / window.innerWidth || 1);
  await app.evaluate(({ BrowserWindow }, at) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("#focus"))!;
    const b = win.getContentBounds();
    const g = globalThis as { __amoTestCursor?: { x: number; y: number }; __amoFocusClicks?: { activated(at: unknown): void; released(): void; pointer(): unknown } };
    g.__amoTestCursor = { x: b.x + at.x, y: b.y + at.y };
    g.__amoFocusClicks!.activated(g.__amoFocusClicks!.pointer());
    g.__amoFocusClicks!.released();
  }, { x: Math.round((box.x + box.width / 2) * zoom), y: Math.round((box.y + box.height / 2) * zoom) });
  await expect(approve).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === created.session.id)?.status, { timeout: 30_000 }).not.toBe("awaiting-approval");
});

test("Focus: 「机器人动作测试」 plays the robot's moods; the angry one flies in its own window until clicked (2026-10-15)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });
  const flight = () => app.evaluate(() => (globalThis as { __amoBotFlight?: { flying: boolean; message: string } }).__amoBotFlight ?? { flying: false, message: "" });

  await focus.getByTestId("focus-settings-toggle").click();
  await focus.getByTestId("focus-menu-bot").click();
  const bot = focus.getByTestId("focus-bot");
  await expect(bot).toHaveClass(/alert/);
  await expect(bot).toContainText("1 件事（测试）");
  await screenshot(app, "stage-14", "bot-light", focus, "focus");
  await expect(bot).toHaveClass(/calm/, { timeout: 5000 });
  // Angry: it leaves Focus and flies in a window of its own.
  const botWindow = app.waitForEvent("window");
  await expect(bot).toHaveCount(0, { timeout: 5000 });
  const flying = await botWindow;
  await expect.poll(flight).toEqual({ flying: true, message: "生气了！（测试，点我停下）" });
  const angry = flying.getByTestId("focus-bot");
  await expect(angry).toHaveClass(/angry/);
  await expect(angry).toContainText("生气了！");
  await screenshot(app, "stage-14", "bot-angry", flying, "focus");
  // Caught: it lands and the test ends.
  await angry.click();
  await expect.poll(flight).toMatchObject({ flying: false });
  await expect(focus.getByTestId("focus-bot")).toHaveCount(0);
});

test("Focus 桌宠: the robot by default; 「看书的 Claude 娘」 picked in 设置 → 界面 shows on Focus and flies (2026-10-15)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });

  // The robot by default.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "界面" }).click();
  await expect(dialog.getByTestId("pet-skin-robot")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("pet-skin-preview").locator("svg")).toHaveCount(1);
  await dialog.getByTestId("pet-skin-reader").click();
  await expect(dialog.getByTestId("pet-skin-reader")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("reader-art")).toBeVisible();
  await screenshot(app, "stage-14", "pet-skin-setting", page);
  await page.keyboard.press("Escape");

  // Focus follows at once: she pops up for 「机器人动作测试」, and she is the one who flies off angry.
  await focus.getByTestId("focus-settings-toggle").click();
  await focus.getByTestId("focus-menu-bot").click();
  const bot = focus.getByTestId("focus-bot");
  await expect(bot).toHaveClass(/skin-reader/);
  await expect(bot.getByTestId("reader-art")).toBeVisible();
  await screenshot(app, "stage-14", "pet-reader-focus", focus, "focus");
  const flyingOpened = app.waitForEvent("window");
  await expect(bot).toHaveCount(0, { timeout: 8000 });
  const flying = await flyingOpened;
  const angry = flying.getByTestId("focus-bot");
  await expect(angry).toHaveClass(/skin-reader/);
  await expect(angry).toHaveClass(/angry/);
  // 2026-10-16: she looked cut off while flying. The window's shape leaves room round her for the shake and her shadow.
  const slot = await angry.locator(".pixel-bot-slot").boundingBox();
  const zoom = await flying.evaluate(() => window.outerWidth / window.innerWidth);
  await expect
    .poll(async () => {
      const shape = await app.evaluate(() => (globalThis as { __amoBotShape?: Array<{ x: number; y: number; width: number; height: number }> }).__amoBotShape ?? []);
      const s = { x: slot!.x * zoom, y: slot!.y * zoom, r: (slot!.x + slot!.width) * zoom, b: (slot!.y + slot!.height) * zoom };
      return shape.some((r) => r.x <= s.x - 12 && r.y <= s.y - 12 && r.x + r.width >= s.r + 12 && r.y + r.height >= s.b + 12);
    })
    .toBe(true);
  await screenshot(app, "stage-14", "pet-reader-angry", flying, "focus");
  await angry.click();
});

test("Focus 桌宠 「AMO 娘」: her faces on Focus, and the top-left, Focus and taskbar icons follow the work; another pet puts them back (2026-10-26)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const appIcon = () => app.evaluate(() => (globalThis as { __amoAppIcon?: string }).__amoAppIcon ?? "");
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "界面" }).click();
  await dialog.getByTestId("pet-skin-mascot").click();
  await expect(dialog.getByTestId("mascot-art")).toBeVisible();
  await expect(dialog.getByTestId("pet-skin-mascot-hint")).toContainText("任务栏");
  await screenshot(app, "stage-18", "S18-pet-mascot-setting", page);
  await page.keyboard.press("Escape");
  // Nothing going on: the plain icon.
  await expect(page.getByTestId("brand-mark")).toHaveAttribute("src", "./icon.png");

  // Waiting for approval: 待命, everywhere; the pet pops up on Focus with that face.
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "表情", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo mascot]]" } });
  await expect(page.getByTestId("brand-mark")).toHaveAttribute("src", "./mascot/01-idle.png", { timeout: 30_000 });
  await expect.poll(appIcon).toMatch(/mascot[\\/]01-idle\.png$/);
  await expect(focus.getByTestId("focus-home-icon")).toHaveAttribute("src", "./mascot/01-idle.png");
  await expect(focus.getByTestId("focus-bot").getByTestId("mascot-art")).toHaveAttribute("src", "./mascot/01-idle.png");
  await screenshot(app, "stage-18", "S18-pet-mascot-focus", focus, "focus");

  // Approved, it finishes: only finished work to look at — 开心.
  await focus.getByTestId("focus-entry").getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByTestId("brand-mark")).toHaveAttribute("src", "./mascot/02-happy.png", { timeout: 30_000 });
  await expect.poll(appIcon).toMatch(/mascot[\\/]02-happy\.png$/);

  // Another pet: the icons are the app's again.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "界面" }).click();
  await dialog.getByTestId("pet-skin-robot").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("brand-mark")).toHaveAttribute("src", "./icon.png");
  await expect.poll(appIcon).toMatch(/assets[\\/]icon\.png$/);
});

test("Focus: 「我知道了」 counts a 完成待审核 entry as reviewed without going back to the workbench (2026-10-17)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "看一眼就行", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello review" } });
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toHaveCount(1, { timeout: 30_000 });
  await expect(entry).toHaveAttribute("data-review", "true");
  await expect(entry).toContainText("完成待审核");
  // The newest entry opens by itself.
  await expect(focus.getByTestId("focus-snippet")).toContainText("MOCK: hello review");
  // Its title only folds and opens it (2026-10-26): it is not reviewed by that, and stays.
  await entry.locator(".focus-row").click();
  await expect(focus.getByTestId("focus-snippet")).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(entry).toHaveCount(1);
  await entry.locator(".focus-row").click();
  await expect(focus.getByTestId("focus-snippet")).toContainText("MOCK: hello review");
  await focus.getByTestId("focus-done").click();
  await expect(entry).toHaveCount(0);
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理");
  // The workbench stayed where it was.
  await expect(page.getByTestId("task-title")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(entry).toHaveCount(0);
});
