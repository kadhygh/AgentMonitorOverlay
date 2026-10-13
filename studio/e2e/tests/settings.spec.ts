import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 设置: the theme (dark, light, or following the system; remembered, shared with Focus) and the common space.

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
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "导入重试", scope: { kind: "workspace", workspaceId: ws.id }, firstSession: { profileId: "codex-mock", text: "[[markdown]]" } });

  // Explicit dark first (the test machine's own theme must not decide the result).
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("radio", { name: "深色" }).click();
  expect(await bg(page)).toBe("rgb(17, 19, 22)");
  await dialog.getByRole("radio", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bg(page)).toBe("rgb(245, 246, 248)");
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

test("the common space: a folder for the scheduler and cross-workspace sessions", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const common = join(studio.root, "common");

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByLabel("公共空间目录").fill(common);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByTestId("settings-message")).toHaveText(`公共空间：${common}`);
  // It is a registered workspace now, shown in the left column.
  await expect(page.getByTestId("scope-ws-公共空间")).toBeVisible();
  await page.keyboard.press("Escape");

  // A cross-workspace task's first session defaults to it.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "任务范围" }).getByRole("button", { name: "跨工作区" }).click();
  await expect(page.getByLabel("首个会话在").locator("option:checked")).toHaveText("公共空间");
});

test("the Claude subscription token is saved in settings, then Claude sessions run on it", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const start = () =>
    studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title: "订阅",
      scope: { kind: "workspace", workspaceId: ws.id },
      firstSession: { profileId: "claude-subscription", text: "hello" },
    });
  // Without a token the session cannot start, and says how to get one.
  await expect(start()).rejects.toThrow(/claude setup-token/);

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  const row = dialog.locator('[data-testid="credential"][data-id="claude-subscription"]');
  await expect(row).toContainText("未设置");
  await row.getByLabel("Claude 订阅 令牌").fill("sk-ant-oat01-e2e");
  await row.getByRole("button", { name: "保存" }).click();
  await expect(row).toContainText("已保存");
  await expect(dialog.getByTestId("credential-message")).toHaveText("已保存 Claude 订阅 令牌");
  // API keys stored elsewhere are shown, never editable here.
  await expect(dialog.locator('[data-testid="credential"][data-id="mock"]').getByRole("button")).toHaveCount(0);
  await dialog.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await screenshot(app, "settings", "settings-credentials", page);
  await page.keyboard.press("Escape");

  await start();
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 60_000 });
  await expect(page.getByTestId("thread-head")).toContainText("Claude 订阅");
});
