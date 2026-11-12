import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ClaudeAccountsState, Session, Task, Workspace, Topic, StateSnapshot, StudioSettings } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 设置: the theme (dark, light, or following the system; remembered, shared with Focus), the common space, and how the
// Claude subscription signs in (the person's own Claude Code login; the token mode is gone since 2026-10-27).

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

test("设置 → 模型: the Claude subscription signs in through Claude Code itself, with nothing to paste; API keys show on their channel's page (2026-10-27)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.locator('[data-testid="channel-nav"][data-id="claude-subscription"]').click();
  await expect(dialog.getByTestId("claude-accounts")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /令牌/ })).toHaveCount(0);
  await expect(dialog.locator('[data-testid="credential"][data-id="claude-subscription"]')).toHaveCount(0);
  await expect(dialog.getByTestId("claude-login-notes")).toContainText("对话记录");
  // Studio stores no Claude.ai token any more: the Host refuses one.
  await expect(studio.api("PUT", "/api/credentials/claude-subscription", { secret: "sk-ant-oat01-e2e" })).rejects.toThrow(/cannot be changed from Studio/);
  // API keys stored elsewhere are shown on their channel's page, never editable here.
  await dialog.locator('[data-testid="channel-nav"][data-id="codex-mock"]').click();
  await expect(dialog.locator('[data-testid="channel-page"][data-id="codex-mock"]')).toContainText("Key 已保存（旧 AMO 设置里的）");
  await expect(dialog.locator('[data-testid="credential"][data-id="mock"]')).toHaveCount(0);
  await screenshot(app, "settings", "settings-credentials", page);
});

test("the Claude subscription on the local Claude Code login: found in 设置, then sessions run without a token", async ({}, info) => {
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
  await dialog.locator('[data-testid="channel-nav"][data-id="claude-subscription"]').click();
  // The local login is found (the stand-in here); there is nothing to choose and no token row.
  const own = dialog.locator('[data-testid="claude-account"][data-id="default"]');
  await expect(own).toContainText("已登录");
  await expect(own).toContainText("✓ 正在使用");
  await expect(own).toContainText(mine);
  await expect(dialog.locator('[data-testid="credential"][data-id="claude-subscription"]')).toHaveCount(0);
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
});

test("Claude 多账号: a second account in 设置, the quota per account at the bottom left, and switching only when no session is at work (2026-11-03)", async ({}, info) => {
  const mine = join(info.outputDir, "my-claude");
  mkdirSync(mine, { recursive: true });
  const expiresAt = Date.now() + 365 * 24 * 3600_000;
  const login = (token: string, plan: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: plan } });
  writeFileSync(join(mine, ".credentials.json"), login("sk-ant-oat01-e2e-local", "max"));
  studio = await launchStudio({ env: { CLAUDE_CONFIG_DIR: mine } });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });

  // A second account (signed in here as `claude auth login` would: a test run opens no browser).
  const added = await studio.api<ClaudeAccountsState>("POST", "/api/claude-accounts", { label: "工作号", signIn: false });
  const work = added.accounts.find((a) => a.label === "工作号")!;
  writeFileSync(join(work.dir, ".credentials.json"), login("sk-ant-oat01-e2e-local-work", "pro"));
  // Its name at Claude, as `claude auth login` leaves it in the dir's .claude.json (2026-11-13: shown under 工作号).
  writeFileSync(join(work.dir, ".claude.json"), JSON.stringify({ oauthAccount: { displayName: "Sam", emailAddress: "sam@example.com", planDisplayName: "Pro" } }));
  // Its records are the default account's.
  expect(lstatSync(join(work.dir, "projects")).isSymbolicLink()).toBe(true);

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.locator('[data-testid="channel-nav"][data-id="claude-subscription"]').click();
  await expect(dialog.getByTestId("claude-account")).toHaveCount(2);
  const workRow = dialog.locator(`[data-testid="claude-account"][data-id="${work.id}"]`);
  await expect(workRow).toContainText("已登录");
  await expect(workRow.getByTestId("claude-account-switch")).toBeEnabled();
  await screenshot(app, "settings", "claude-accounts", page);
  await page.keyboard.press("Escape");

  // A session on the default account; while it works, no switching.
  await studio.api("POST", "/api/tasks", { title: "多账号", workspaceId: ws.id, firstSession: { profileId: "claude-subscription", text: "[[slow]] hello mine" } });
  await page.getByTestId("host-status").click();
  const current = page.locator('[data-testid="usage-account"][data-current="1"]');
  await expect(current).toContainText("正在使用");
  await expect(current).toContainText("剩 63%");
  // 方案 A (2026-11-13): every account open at once, the one in use without 切换; folded, what is left of the one in use.
  await expect(current.getByTestId("usage-switch")).toHaveCount(0);
  await expect(page.getByTestId("usage-peak")).toHaveText("Claude 剩 63%");
  const other = page.locator(`[data-testid="usage-account"][data-account="${work.id}"]`);
  await expect(other).toContainText("工作号");
  await expect(other.getByTestId("usage-account-who")).toHaveText("Sam · Pro");
  await expect(other.getByTestId("usage-switch")).toBeDisabled();
  // A model's own weekly limit (the mock's Fable 每周) only once 设置 → 额度 turns it on.
  await expect(current.getByTestId("usage-window")).toHaveCount(2);
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "额度" }).click();
  const fable = dialog.locator('[data-testid="quota-row"][data-id="claude-subscription"]').getByTestId("quota-model-weekly");
  await expect(fable).not.toBeChecked();
  await expect(dialog.locator('[data-testid="quota-row"][data-id="claude-subscription"]')).toContainText("Fable 每周");
  await screenshot(app, "settings", "quota-fable-switch", page);
  await fable.click();
  await expect(fable).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(current.getByTestId("usage-window")).toHaveCount(3);
  await expect(current.getByTestId("usage-window").nth(2)).toContainText("Fable 每周");
  await expect(current.getByTestId("usage-window").nth(2)).toContainText("剩 52%");
  await expect(page.getByTestId("usage-peak")).toHaveText("Claude 剩 52%");
  await screenshot(app, "settings", "claude-accounts-usage-fable", page);
  await expect(studio.api("PUT", "/api/claude-accounts/current", { id: work.id })).rejects.toThrow(/正在进行/);
  await screenshot(app, "settings", "claude-accounts-usage-busy", page);

  // Once it is over, 切换 from the quota list; the session goes on under the work account.
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("slow slow", { timeout: 60_000 });
  await expect(other.getByTestId("usage-switch")).toBeEnabled({ timeout: 30_000 });
  await other.getByTestId("usage-switch").click();
  await expect(page.locator(`[data-testid="usage-account"][data-current="1"][data-account="${work.id}"]`)).toBeVisible();
  await expect.poll(async () => (await studio!.api<StudioSettings>("GET", "/api/settings")).claudeAccounts.current).toBe(work.id);
  await screenshot(app, "settings", "claude-accounts-usage", page);
  await page.getByTestId("host-status").click();
});
