import { cpSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { ChecklistItem, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Stage 6 acceptance with the fictional example pack, the way a person would use it: the pack loads and its
// conventions can be read; a task is made from its template; a session is started from its preset (checked and edited
// first); the agent reads the conventions through the AMO MCP and ticks a step of its own task's checklist.

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "packs", "demo");

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("stage 6 acceptance: an example pack from loading to an agent ticking its checklist", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const path = studio.workspace("alpha");
  cpSync(EXAMPLE, join(path, ".amo", "packs", "demo"), { recursive: true });
  writeFileSync(join(path, "README.md"), "# alpha\n");
  await studio.api<Workspace>("POST", "/api/workspaces", { path });

  // 1. Loaded and readable.
  await page.getByTestId("scope-ws-alpha").click();
  await page.getByRole("button", { name: "扩展包", exact: true }).click();
  await page.getByTestId("pack-doc-link").filter({ hasText: "常见坑" }).click();
  await expect(page.getByTestId("pack-doc")).toContainText("冷却时间写成秒");

  // 2. A task from the template.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("流程模板").selectOption({ label: "示例：小游戏玩法开发 · 新玩法" });
  await page.locator(".newtask-title input").fill("冲刺技能");
  await page.getByLabel("模型").selectOption({ label: "Codex · Mock 模型" });
  await page.getByRole("button", { name: "开始" }).click();
  await expect(page.locator(".page-head")).toContainText("[玩法] 冲刺技能");
  await expect(page.getByTestId("checklist-count")).toHaveText("0/5");
  const task = (await studio.api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.title === "[玩法] 冲刺技能")!;
  const steps = await studio.api<ChecklistItem[]>("GET", `/api/checklist?taskId=${task.id}`);

  // 3. A session from the preset: the person checks the prompt and adds an instruction (here, the mock's directive to
  //    read the conventions through the AMO MCP) before starting it.
  await page.getByLabel("按预设新建会话").selectOption({ label: "示例：小游戏玩法开发 · 按约定实现" });
  const form = page.getByTestId("preset-draft");
  await expect(form.getByLabel("预设提示词")).toHaveValue(/请实现任务「\[玩法\] 冲刺技能」/);
  await form.getByLabel("预设模型").selectOption({ label: "Codex · Mock 模型" });
  const draft = await form.getByLabel("预设提示词").inputValue();
  await form.getByLabel("预设提示词").fill(`${draft}\n[[mcp: pack_doc {"workspace":"alpha","pack":"demo","doc":"conventions"}]]`);
  await form.getByRole("button", { name: "开始" }).click();
  await expect(form).toHaveCount(0);

  // 4. The agent read the conventions through the MCP...
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-MCP:", { timeout: 60_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("代码约定");
  const session = (await studio.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.find((s) => s.taskId === task.id && s.title.startsWith("请实现任务"))!;

  // ...and ticks the first step of its own task's checklist; the task page shows who did.
  const composer = page.getByLabel("输入消息");
  await composer.fill(`[[mcp: checklist_check {"itemId":"${steps[0]!.id}"}]]`);
  await composer.press("Enter");
  await expect(page.getByTestId("checklist-count")).toHaveText("1/5", { timeout: 60_000 });
  await expect(page.getByTestId("checklist-item").first()).toContainText(session.title.slice(0, 10));
  await screenshot(studio.app, "stage-6", "S6-06-acceptance", page);

  // The board card shows the progress.
  await page.getByRole("button", { name: "← 看板" }).click();
  await expect(page.getByTestId("task-card").filter({ hasText: "冲刺技能" })).toContainText("清单 1/5");
});
