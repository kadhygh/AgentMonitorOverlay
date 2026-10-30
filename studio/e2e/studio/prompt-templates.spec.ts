import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 提示词模板 (2026-10-31): @ → AMO 扩展功能 → 提示词模板… opens the template window; a template is written there (or by
// an agent through MCP, marked AI 写的), and picking one puts its text where @ was typed, in a session's composer and
// on the new-task page.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const composer = (page: Page) => page.getByLabel("输入消息");

test("prompt templates: write one, paste it into a session's composer, project-only ones stay in their project", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  // One an agent saved for alpha, one only for beta (not offered in alpha).
  await studio.api("POST", "/api/prompt-templates", { title: "别的项目的", body: "beta 专用", workspaceId: beta.id });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "模板", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 30_000 });

  const dialog = page.getByTestId("prompt-dialog");
  await composer(page).pressSequentially("先看这个 @");
  await page.getByTestId("suggest").getByRole("option", { name: /提示词模板/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("还没有模板");

  // Written in the window: global by default.
  await dialog.getByTestId("prompt-new").click();
  await dialog.getByLabel("模板标题").fill("每日巡检");
  await dialog.getByLabel("模板内容").fill("看一遍昨天的提交\n列出有风险的改动");
  await dialog.getByTestId("prompt-save").click();
  await expect(dialog.getByTestId("prompt-item")).toHaveCount(1);
  await expect(dialog.getByTestId("prompt-preview")).toContainText("列出有风险的改动");

  // A second one for this project only, as an agent would write it.
  await studio.api("POST", "/api/prompt-templates", { title: "打包检查", body: "打 portable 包前过一遍清单", workspaceId: ws.id });
  await expect(dialog.getByTestId("prompt-item")).toHaveCount(2);
  await expect(dialog.getByTestId("prompt-item").first()).toContainText("alpha");
  await screenshot(studio.app, "studio", "prompt-templates-dialog", page);

  // Search, then Enter pastes the picked one where @ was.
  await dialog.getByLabel("搜索模板").fill("巡检");
  await expect(dialog.getByTestId("prompt-item")).toHaveCount(1);
  await dialog.getByLabel("搜索模板").press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(composer(page)).toHaveValue("先看这个 看一遍昨天的提交\n列出有风险的改动");
  await expect(composer(page)).toBeFocused();

  // Edit and delete in the window.
  await composer(page).fill("@");
  await page.getByTestId("suggest").getByRole("option", { name: /提示词模板/ }).click();
  await dialog.getByTestId("prompt-item").filter({ hasText: "打包检查" }).click();
  await dialog.getByRole("button", { name: "编辑" }).click();
  await dialog.getByLabel("在哪里出现").selectOption({ label: "全局：所有项目" });
  await dialog.getByTestId("prompt-save").click();
  await expect(dialog.getByTestId("prompt-item").filter({ hasText: "打包检查" })).toContainText("全局");
  page.once("dialog", (d) => void d.accept());
  await dialog.getByRole("button", { name: "删除" }).click();
  await expect(dialog.getByTestId("prompt-item")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(composer(page)).toHaveValue("");
  const left = await studio.api<Array<{ title: string; workspaceId: string | null }>>("GET", "/api/prompt-templates");
  expect(left.map((t) => [t.title, t.workspaceId])).toEqual([["每日巡检", null], ["别的项目的", beta.id]]);
});

test("prompt templates on the new-task page", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/prompt-templates", { title: "周报", body: "整理本周合进 master 的改动，按模块写成周报" });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const first = page.getByLabel("第一句话");
  await expect(first).toBeFocused();
  await first.pressSequentially("@");
  await page.getByTestId("suggest").getByRole("option", { name: /提示词模板/ }).click();
  const dialog = page.getByTestId("prompt-dialog");
  await expect(dialog.getByTestId("prompt-item")).toHaveCount(1);
  await dialog.getByTestId("prompt-ok").click();
  await expect(first).toHaveValue("整理本周合进 master 的改动，按模块写成周报");
});
