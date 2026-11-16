import { expect, test, type Page } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 新会话 (2026-11-17, the user: 统一迭代一下 task 下 session 的新会话，也用弹窗的形式吧，不在左侧了，然后创建时允许编辑名称，像常规新任务
// 一样选择模型、各种内容以及 mcp 选项): the task head's 新会话 opens a dialog — its name, an optional first message, the model
// (tiles), effort, permissions, 预设 and MCP as the new-task page has them; the session starts with what was picked. The
// new-task page has the same MCP row.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const theme = (page: Page, which: "light" | "dark") => page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), which);

test("新会话 is a dialog: a name, the first message, the model, its options and MCP; the session starts with them", async () => {
  test.setTimeout(180_000);
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("掉落表") });
  // A server of Studio's, on by default (it exits at once: nothing here needs it running) and one off by default.
  await studio.api("POST", "/api/mcp/servers", { name: "figma", spec: { type: "stdio", command: "node", args: ["-e", "process.exit(0)"], env: { FIGMA_KEY: "sk-e2e-secret" } }, note: "设计稿" });
  await studio.api("POST", "/api/mcp/servers", { name: "webtool", spec: { type: "stdio", command: "node", args: ["-e", "process.exit(0)"] }, on: false });
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "整理掉落表", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "先看看" } });
  await page.getByTestId("task-card").filter({ hasText: "整理掉落表" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 60_000 });

  // The old form in the list is gone; the head's 新会话 opens the dialog.
  await expect(page.locator(".session-list .new-session")).toHaveCount(0);
  await page.getByTestId("new-session-toggle").click();
  const dialog = page.getByTestId("new-session-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-session-title")).toBeFocused();
  await dialog.getByTestId("new-session-title").fill("查掉落日志");
  await dialog.getByTestId("new-session-text").fill("把昨天的掉落日志过一遍");
  // Codex first: its MCP is fixed when it starts — listed, not to tick.
  const mcp = dialog.getByTestId("new-session-mcp");
  await expect(mcp.getByTestId("mcp-pick-figma")).toBeDisabled({ timeout: 30_000 });
  await expect(mcp).toContainText("Codex 的 MCP 在它启动时就定了");
  // Claude: picked per session — figma off, webtool on.
  // Not among the four tiles here (recent picks first): from the drawer of every model.
  await dialog.getByTestId("all-models").click();
  await dialog.getByTestId("model-drawer").getByRole("group", { name: "Mock Claude" }).getByRole("button").first().click();
  await expect(mcp.getByTestId("mcp-pick-figma")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await mcp.getByTestId("mcp-pick-figma").click();
  await mcp.getByTestId("mcp-pick-webtool").click();
  await expect(mcp.getByTestId("mcp-pick-webtool")).toContainText("改过");
  expect(await page.content()).not.toContain("sk-e2e-secret");
  await screenshot(studio.app, "studio", "new-session-dialog", page);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "new-session-dialog-dark", page);
  await theme(page, "light");
  await dialog.getByRole("button", { name: "开始新会话" }).click();

  // Started with its name, model and MCP; the dialog closes and the list shows it, selected.
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  const made = await expect
    .poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.taskId === task.id && s.title === "查掉落日志"), { timeout: 30_000 })
    .toBeTruthy()
    .then(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.taskId === task.id && s.title === "查掉落日志")!);
  expect(made).toMatchObject({ profileId: "claude-mock", options: { mcp: { figma: false, webtool: true } } });
  await expect(page.getByTestId("session-row").filter({ hasText: "查掉落日志" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("msg-user").last()).toContainText("把昨天的掉落日志过一遍", { timeout: 30_000 });

  // No name, no first message: named as before, waiting for the person.
  await page.getByTestId("new-session-toggle").click();
  await dialog.getByRole("button", { name: "开始新会话" }).click();
  await expect(page.getByTestId("session-row")).toHaveCount(3, { timeout: 30_000 });

  // The new-task page has the same MCP row (Claude: per session; the choice goes with the first session).
  await page.getByTestId("back").click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock Claude" }).click();
  const draftMcp = page.getByTestId("draft-mcp");
  await expect(draftMcp.getByTestId("mcp-pick-figma")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await draftMcp.getByTestId("mcp-pick-figma").click();
  await page.getByLabel("第一句话").fill("新任务带 MCP");
  await screenshot(studio.app, "studio", "new-task-mcp", page);
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.locator(".page-head")).toContainText("新任务带 MCP", { timeout: 60_000 });
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const newTask = state.tasks.find((t) => t.title === "新任务带 MCP")!;
  expect(state.sessions.find((s) => s.taskId === newTask.id)!.options.mcp).toEqual({ figma: false });
});
