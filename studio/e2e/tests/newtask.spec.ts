import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function registerWorkspaces(s: Studio, names: string[]): Promise<Workspace[]> {
  const out: Workspace[] = [];
  for (const name of names) out.push(await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace(name) }));
  return out;
}

test("creates a task from the blank task page and streams the first reply", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await registerWorkspaces(studio, ["alpha", "beta"]);
  await expect(page.getByTestId("scope-ws-beta")).toBeVisible();

  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByText("要推进什么？")).toBeVisible();
  // Title sits below the question and may stay empty; the first workspace is preselected.
  await expect(page.getByLabel("任务标题")).toHaveValue("");
  await expect(page.getByRole("group", { name: "任务范围" }).getByRole("button", { name: "alpha" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("scope-hint")).toContainText("任务会建在 alpha");
  await expect(page.getByLabel("模型")).toHaveValue("codex-mock");
  await screenshot(studio.app, "stage-1", "S1-10-new-task", page);

  await page.getByLabel("第一句话").fill("列出目录结构 [[slow]]");
  await page.getByRole("button", { name: "开始" }).click();

  await expect(page.getByTestId("task-title")).toHaveText("列出目录结构 [[slow]]");
  await expect(page.getByTestId("msg-user")).toHaveText(/列出目录结构/);
  // While streaming, the reply grows and is marked as streaming (a pulsing dot); then it settles.
  await expect(page.getByTestId("msg-agent")).toHaveAttribute("data-streaming", "true", { timeout: 30_000 });
  await expect(page.getByTestId("msg-agent")).toContainText("slow slow");
  await expect(page.getByTestId("msg-agent")).not.toHaveAttribute("data-streaming", /.+/, { timeout: 30_000 });
  await screenshot(studio.app, "stage-1", "S1-10-first-reply", page);

  await page.getByRole("button", { name: "← 看板" }).click();
  await expect(page.getByTestId("column-doing").getByTestId("task-card")).toHaveCount(1);
});

test("creates a cross-workspace task with the first session in the chosen workspace", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const [, beta] = await registerWorkspaces(studio, ["alpha", "beta"]);
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("任务标题").fill("统一配置键名");
  await page.getByRole("group", { name: "任务范围" }).getByRole("button", { name: "跨工作区" }).click();
  await expect(page.getByTestId("scope-hint")).toContainText("跨工作区任务");
  await page.getByLabel("首个会话在").selectOption({ label: "beta" });
  await page.getByLabel("第一句话").fill("先列出两边的配置键");
  await page.getByLabel("第一句话").press("Enter");

  await expect(page.getByTestId("task-title")).toHaveText("统一配置键名");
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 先列出两边的配置键", { timeout: 30_000 });
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const task = state.tasks.find((t) => t.title === "统一配置键名")!;
  expect(task.topicId).toBeNull(); // TODO(stage 10): this cross-workspace flow is replaced by topics; rewrite with the new task page
  const session = state.sessions.find((s: Session) => s.taskId === task.id)!;
  expect(session.workspaceId).toBe(beta!.id);
});

test("asks for a workspace before a task can start", async () => {
  studio = await launchStudio({ mockModel: false });
  const { page } = studio;
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByTestId("scope-hint")).toHaveText("先在左栏登记一个工作区。");
  await expect(page.getByRole("button", { name: "开始" })).toBeDisabled();
});
