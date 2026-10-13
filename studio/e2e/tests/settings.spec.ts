import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace, Topic, StateSnapshot, StudioSettings } from "@amo-studio/protocol";
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

test("the common folder: where work without a project runs, moved in settings", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const elsewhere = join(studio.root, "elsewhere");

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
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
  const row = dialog.locator('[data-testid="credential"][data-id="claude-subscription"]');
  await expect(row).toContainText("未设置");
  await row.getByLabel("Claude 令牌").fill("sk-ant-oat01-e2e");
  await row.getByRole("button", { name: "保存" }).click();
  await expect(row).toContainText("已保存");
  await expect(dialog.getByTestId("credential-message")).toHaveText("已保存 Claude 令牌");
  // API keys stored elsewhere are shown, never editable here.
  await expect(dialog.locator('[data-testid="credential"][data-id="mock"]').getByRole("button")).toHaveCount(0);
  await dialog.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await screenshot(app, "settings", "settings-credentials", page);
  await page.keyboard.press("Escape");

  await start();
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 60_000 });
  await expect(page.getByTestId("thread-head")).toContainText("Claude");
});
