import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Extension packs in the workbench: the workspace's "扩展包" page (documents, templates, presets, a broken pack's
// errors, reloading after an edit) and the task page's "规范" panel. Uses the fictional example pack only.

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "packs", "demo");

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("extension packs: browse a workspace's packs and read their documents from a task", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const path = studio.workspace("alpha");
  const packs = join(path, ".amo", "packs");
  cpSync(EXAMPLE, join(packs, "demo"), { recursive: true });
  mkdirSync(join(packs, "broken"), { recursive: true });
  writeFileSync(join(packs, "broken", "pack.json"), JSON.stringify({ schemaVersion: 1, name: "broken", title: "坏的", docs: [{ id: "x", title: "X", path: "../../secret.md" }] }));
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path });

  // The tab shows only with one workspace in scope.
  await expect(page.getByRole("button", { name: "扩展包", exact: true })).toHaveCount(0);
  await page.getByTestId("scope-ws-alpha").click();
  await page.getByRole("button", { name: "扩展包", exact: true }).click();
  const rows = page.getByTestId("pack-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "坏的" })).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("broken");
  await expect(rows.nth(0)).toContainText("有错误");

  // The example pack: documents, the template's steps, presets with their model, the reserved tool.
  await rows.filter({ hasText: "示例：小游戏玩法开发" }).click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-template")).toContainText("对照常见坑自查");
  await expect(detail.getByTestId("pack-preset")).toHaveCount(2);
  await expect(detail.getByTestId("pack-preset").first()).toContainText("请实现任务「{{task.title}}」");
  await expect(detail).toContainText("专用工具（预留，不会运行）");
  await screenshot(studio.app, "stage-6", "S6-02-pack-overview", page);
  await detail.getByTestId("pack-doc-link").filter({ hasText: "代码约定" }).click();
  await expect(page.getByTestId("pack-doc").locator("table")).toContainText("skills.json");
  await screenshot(studio.app, "stage-6", "S6-02-pack-doc", page);
  await page.getByRole("button", { name: "← 示例：小游戏玩法开发" }).click();
  await expect(detail.getByTestId("pack-template")).toBeVisible();

  // The broken pack shows why.
  await rows.nth(0).click();
  await expect(page.getByTestId("pack-errors")).toContainText('docs[0].path: 路径 "../../secret.md" 不允许');

  // Fixing it on disk and reloading.
  writeFileSync(join(packs, "broken", "pack.json"), JSON.stringify({ schemaVersion: 1, name: "broken", title: "修好了" }));
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(rows.filter({ hasText: "修好了" })).toHaveCount(1);
  await expect(page.getByTestId("pack-errors")).toHaveCount(0);

  // On a task in that workspace, "规范" lists the documents and opens one in place.
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "冲刺技能",
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId: "codex-mock" },
  });
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  await expect(page.getByTestId("task-pack-doc")).toHaveCount(2);
  await page.getByTestId("task-pack-doc").filter({ hasText: "常见坑" }).click();
  await expect(page.getByTestId("task-pack-doc-view")).toContainText("冷却时间写成秒");
  await screenshot(studio.app, "stage-6", "S6-02-task-docs", page);
});

test("task templates: a task made from a template carries its steps as a checklist", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const path = studio.workspace("alpha");
  cpSync(EXAMPLE, join(path, ".amo", "packs", "demo"), { recursive: true });
  await studio.api<Workspace>("POST", "/api/workspaces", { path });

  await page.getByTestId("scope-ws-alpha").click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("流程模板").selectOption({ label: "示例：小游戏玩法开发 · 新玩法" });
  await expect(page.getByTestId("template-steps").locator("li")).toHaveCount(5);
  await page.locator(".newtask-title input").fill("冲刺技能");
  await screenshot(studio.app, "stage-6", "S6-03-new-from-template", page);
  await page.getByRole("button", { name: "开始" }).click();

  // The task page: the title has the template's prefix; the checklist is ticked by the person.
  await expect(page.locator(".page-head")).toContainText("[玩法] 冲刺技能");
  const items = page.getByTestId("checklist-item");
  await expect(items).toHaveCount(5);
  await expect(page.getByTestId("checklist-count")).toHaveText("0/5");
  // The box follows the Host (the item updates through its event), so click rather than check().
  await items.first().locator("input").click();
  await expect(page.getByTestId("checklist-count")).toHaveText("1/5");
  await expect(items.first()).toContainText("我");
  await screenshot(studio.app, "stage-6", "S6-03-checklist", page);

  // The board card shows the progress in its meta line.
  await page.getByRole("button", { name: "← 看板" }).click();
  await expect(page.getByTestId("task-card").filter({ hasText: "冲刺技能" })).toContainText("清单 1/5");
});

test("session presets: a preset fills the new-session form and starts only when confirmed", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const path = studio.workspace("alpha");
  cpSync(EXAMPLE, join(path, ".amo", "packs", "demo"), { recursive: true });
  writeFileSync(join(path, "README.md"), "# alpha\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path });
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "冲刺技能",
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId: "codex-mock" },
  });
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  const sessionCount = async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id).length;
  expect(await sessionCount()).toBe(1);

  // Picking a preset only prefills: the prompt with the task's title, the files to read, and why the model fell back
  // (the example names a DeepSeek profile that the test setup does not have).
  await page.getByLabel("按预设新建会话").selectOption({ label: "示例：小游戏玩法开发 · 按约定实现" });
  const form = page.getByTestId("preset-draft");
  await expect(form.getByLabel("预设提示词")).toHaveValue(/请实现任务「冲刺技能」。开始前先读 \.amo\/packs\/demo\/docs\/conventions\.md/);
  await expect(form.getByLabel("预设提示词")).toHaveValue(/相关文件（开始前请先阅读）：\n- README\.md$/);
  await expect(form.getByTestId("preset-warnings")).toContainText("没有模型配置 codex-deepseek-flash，改用默认模型");
  await screenshot(studio.app, "stage-6", "S6-04-preset-draft", page);
  expect(await sessionCount()).toBe(1);

  // Cancel leaves nothing behind; confirming starts the session with the (edited) prompt.
  await form.getByRole("button", { name: "取消" }).click();
  await expect(form).toHaveCount(0);
  await page.getByLabel("按预设新建会话").selectOption({ label: "示例：小游戏玩法开发 · 按约定实现" });
  await form.getByLabel("预设模型").selectOption({ label: "Codex · Mock 模型" });
  const text = await form.getByLabel("预设提示词").inputValue();
  await form.getByLabel("预设提示词").fill(`${text}\n先只读代码，不要改。`);
  await form.getByRole("button", { name: "开始" }).click();
  await expect(form).toHaveCount(0);
  await expect.poll(sessionCount).toBe(2);
  await expect(page.getByTestId("msg-user").last()).toContainText("先只读代码，不要改。");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 请实现任务「冲刺技能」", { timeout: 60_000 });
});
