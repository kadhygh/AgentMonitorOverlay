import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace, Topic, StateSnapshot, StudioSettings } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 设置: the theme (dark, light, or following the system; remembered, shared with Focus), the common space, and how the
// Claude subscription signs in (a token, or the person's own Claude Code login after a warning).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const bg = (page: import("@playwright/test").Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("light theme from the settings dialog, remembered and shared with Focus", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "导入重试", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "[[markdown]]" } });
  await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true }); // shown on the canvas (S11-A: not automatic)

  // Explicit dark first (the test machine's own theme must not decide the result).
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("radio", { name: "深色" }).click();
  expect(await bg(page)).toBe("rgb(17, 19, 22)");
  await dialog.getByRole("radio", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bg(page)).toBe("rgb(239, 237, 232)");
  await screenshot(app, "settings", "settings-dialog-light", page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The light theme across the main views.
  await screenshot(app, "settings", "board-light", page);
  await page.getByTestId("task-card").filter({ hasText: "导入重试" }).click();
  await expect(page.getByTestId("msg-agent").last().locator("table")).toBeVisible({ timeout: 60_000 });
  await screenshot(app, "settings", "task-light", page);
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
  await screenshot(app, "settings", "canvas-light", page);

  // Focus opens in the same theme; a change in the workbench reaches it.
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await app.waitForEvent("window");
  await expect(focus.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("radio", { name: "深色" }).click();
  await expect(focus.locator("html")).toHaveAttribute("data-theme", "dark");

  // Remembered across a reload.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("radio", { name: "跟随系统" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});

test("界面大小 zooms every window, Focus too (its window grows with it), and is remembered", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const dpr = (p: import("@playwright/test").Page) => p.evaluate(() => window.devicePixelRatio);
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await app.waitForEvent("window");
  const focusSize = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("#focus"))?.getSize());
  expect(await focusSize()).toEqual([380, 560]);

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("radio", { name: "较大 125%" }).click();
  await expect.poll(() => dpr(page)).toBe(1.25);
  await expect.poll(() => dpr(focus)).toBe(1.25);
  expect(await focusSize()).toEqual([475, 700]);
  await expect(dialog.getByRole("radio", { name: "较大 125%" })).toHaveAttribute("aria-checked", "true");
  await screenshot(app, "stage-14", "S14-R-ui-scale", page);

  // Remembered: a reloaded page comes back at the same size.
  await page.reload();
  await expect.poll(() => dpr(page)).toBe(1.25);
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("radio", { name: "标准 100%" }).click();
  await expect.poll(() => dpr(page)).toBe(1);
  expect(await focusSize()).toEqual([380, 560]);
});

test("the common folder: where work without a project runs, moved in settings", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const elsewhere = join(studio.root, "elsewhere");

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "项目与目录" }).click();
  // By default it sits in the data folder.
  await expect(dialog.getByRole("textbox", { name: "公共目录" })).toHaveValue(/common$/);
  await dialog.getByRole("textbox", { name: "公共目录" }).fill(elsewhere);
  await dialog.getByRole("region", { name: "公共目录" }).getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByTestId("settings-message")).toHaveText(`公共目录：${elsewhere}`);
  await page.keyboard.press("Escape");
  // It is not a project: the left column lists only alpha.
  await expect(page.locator('[data-testid^="scope-ws-"]')).toHaveCount(1);

  // A task filed without a project runs there.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("第一句话").fill("随手记一件事");
  await page.getByRole("button", { name: "放进待办" }).click();
  const { commonWorkspace } = await studio.api<StudioSettings>("GET", "/api/settings");
  expect(commonWorkspace.path).toBe(elsewhere);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks.find((t) => t.title === "随手记一件事")?.workspaceId).toBe(commonWorkspace.id);
});

test("the Claude subscription token is saved in settings, then Claude sessions run on it", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const start = () =>
    studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title: "订阅",
      workspaceId: ws.id, topicId: topic.id,
      firstSession: { profileId: "claude-subscription", text: "hello" },
    });
  // Without a token the session cannot start, and says how to get one.
  await expect(start()).rejects.toThrow(/claude setup-token/);

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await expect(dialog.getByRole("radio", { name: /令牌/ })).toHaveAttribute("aria-checked", "true");
  const row = dialog.locator('[data-testid="credential"][data-id="claude-subscription"]');
  await expect(row).toContainText("未设置");
  await row.getByLabel("Claude 令牌").fill("sk-ant-oat01-e2e");
  await row.getByRole("button", { name: "保存" }).click();
  await expect(row).toContainText("已保存");
  await expect(dialog.getByTestId("credential-message")).toHaveText("已保存 Claude 令牌");
  // API keys stored elsewhere are shown on their channel's card, never editable here.
  await expect(dialog.locator('[data-testid="channel-card"][data-id="codex-mock"]')).toContainText("Key 已保存（旧 AMO 设置里的）");
  await expect(dialog.locator('[data-testid="credential"][data-id="mock"]')).toHaveCount(0);
  await screenshot(app, "settings", "settings-credentials", page);
  await page.keyboard.press("Escape");

  await start();
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 60_000 });
  await expect(page.getByTestId("thread-head")).toContainText("Claude");
});

test("the Claude subscription on the local Claude Code login: a warning first, then sessions run without a token", async ({}, info) => {
  // A stand-in for the person's ~/.claude (their CLAUDE_CONFIG_DIR), signed in: the real one is never touched.
  const mine = join(info.outputDir, "my-claude");
  mkdirSync(mine, { recursive: true });
  const expiresAt = Date.now() + 365 * 24 * 3600_000;
  writeFileSync(join(mine, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-e2e-local", refreshToken: "sk-ant-ort01-e2e-local", expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
  studio = await launchStudio({ env: { CLAUDE_CONFIG_DIR: mine } });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  const local = dialog.getByRole("radio", { name: /本机 Claude Code 的登录/ });
  const confirm = page.getByTestId("claude-local-confirm");

  // The second dialog lists the risks; cancelling (or Escape, which leaves 设置 open) changes nothing.
  await local.click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("共用同一个账号和用量额度");
  await expect(confirm).toContainText(mine);
  await expect(confirm.getByRole("button", { name: "取消" })).toBeFocused();
  await screenshot(app, "stage-12", "S12-I-local-login-confirm", page);
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(local).toHaveAttribute("aria-checked", "false");
  await local.click();
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(local).toHaveAttribute("aria-checked", "false");
  expect((await studio.api<StudioSettings>("GET", "/api/settings")).claudeLogin).toBe("token");

  // Confirmed: the local login is found, no token row any more.
  await local.click();
  await confirm.getByRole("button", { name: "我了解风险，改用本机登录" }).click();
  await expect(local).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("claude-local-state")).toContainText("已找到");
  await expect(dialog.locator('[data-testid="credential"][data-id="claude-subscription"]')).toHaveCount(0);
  await expect(dialog.getByTestId("credential-message")).toContainText("已改用本机 Claude Code 的登录");
  expect((await studio.api<StudioSettings>("GET", "/api/settings")).claudeLogin).toBe("local");
  await screenshot(app, "stage-12", "S12-I-models-page", page);
  await page.keyboard.press("Escape");

  // No token saved, and a Claude session runs; its transcript is in that config dir, not Studio's.
  await studio.api("POST", "/api/tasks", { title: "本机登录", workspaceId: ws.id, firstSession: { profileId: "claude-subscription", text: "hello mine" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello mine", { timeout: 60_000 });
  expect(existsSync(join(mine, "projects"))).toBe(true);
  expect(readdirSync(join(mine, "projects")).length).toBeGreaterThan(0);
  expect(existsSync(join(studio.dataDir, "claude-home", "projects"))).toBe(false);

  // The local login can read the account's quota (as Claude Code's /usage): what is left and when it resets.
  await page.getByTestId("host-status").click();
  const windows = page.getByTestId("usage-account").getByTestId("usage-window");
  await expect(windows.nth(0)).toContainText("5 小时");
  await expect(windows.nth(0)).toContainText("剩 63%");
  await expect(windows.nth(0).getByTestId("usage-reset")).toHaveText(/^1h 3[45]m$/);
  await expect(windows.nth(1)).toContainText("剩 88%");
  await expect(windows.nth(1).getByTestId("usage-reset")).toHaveText(/^3d 2h [56]m$/);
  await screenshot(app, "stage-12", "S12-J-claude-usage", page);
  await page.getByTestId("host-status").click();

  // Back to the token: no second dialog.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("radio", { name: /令牌/ }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: /令牌/ })).toHaveAttribute("aria-checked", "true");
  expect((await studio.api<StudioSettings>("GET", "/api/settings")).claudeLogin).toBe("token");
});
