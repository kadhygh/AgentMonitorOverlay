import { expect, test } from "@playwright/test";
import type { Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

// Stage 14 (S14-C): the search box left of "+ 新任务", 置顶 in the title bar, task pages that return where they were
// opened from, the box after 归档任务, and archived tasks and sessions that say so plainly.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function seed(s: Studio) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const topic = await s.api<Topic>("POST", "/api/topics", { title: "数值平衡" });
  const drop = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表调整", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
  await s.api("PATCH", `/api/sessions/${drop.session.id}`, { title: "检查掉落概率" });
  await s.api("PUT", `/api/tasks/${drop.task.id}/canvas`, { onCanvas: true });
  const old = await s.api<{ task: Task }>("POST", "/api/tasks", { title: "旧的掉落表", workspaceId: ws.id });
  await s.api("POST", `/api/tasks/${old.task.id}/archive`);
  const tool = await s.api<{ task: Task }>("POST", "/api/tasks", { title: "导表工具", workspaceId: ws.id, topicId: topic.id });
  await s.api("PUT", `/api/tasks/${tool.task.id}/canvas`, { onCanvas: true });
  return { ws, topic, drop, tool };
}

test("search: Ctrl K, every word, archived last; it opens a task or a session and ← goes back where it came from", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await seed(studio);

  await page.keyboard.press("Control+K");
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();
  // Nothing typed: the most recent live ones.
  await expect(page.getByTestId("search-results")).toContainText("最近");
  await input.fill("掉落");
  const rows = page.getByTestId("search-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.last()).toContainText("旧的掉落表");
  await expect(rows.last()).toContainText("已归档");
  await expect(rows.filter({ hasText: "检查掉落概率" })).toContainText("掉落表调整 · alpha · 数值平衡");
  await expect(rows.first().locator("mark").first()).toHaveText("掉落");
  await screenshot(studio.app, "stage-14", "S14-C-search", page);

  // Two words, one in the name, one in the project; ↓ ↑ and Enter.
  await input.fill("概率 alpha");
  await expect(rows).toHaveCount(1);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.getByTestId("task-title")).toHaveText("掉落表调整");
  await expect(page.getByTestId("thread-head")).toContainText("检查掉落概率");
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "返回看板" }).click();
  await expect(page.getByTestId("task-card").first()).toBeVisible();

  // From the canvas: the task found returns to the canvas, as does a task made with "+ 新任务" there.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(2);
  await input.click();
  await input.fill("导表");
  await rows.first().click();
  await expect(page.getByTestId("task-title")).toHaveText("导表工具");
  await page.getByRole("button", { name: "返回画布" }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(2);
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByRole("group", { name: "专题" }).getByRole("button", { name: "数值平衡" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "返回画布" }).click();
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();

  // Esc clears, then leaves.
  await input.click();
  await input.fill("xyz");
  await expect(page.getByTestId("search-results")).toContainText("没有找到「xyz」");
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(page.getByTestId("search-results")).toHaveCount(0);
});

test("置顶 keeps the workbench above other windows, without taking focus, and is remembered", async () => {
  studio = await launchStudio({ mockModel: false });
  const { page } = studio;
  const pin = page.getByTestId("pin-toggle");
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  expect((await windowState(studio.app)).alwaysOnTop).toBe(false);
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await windowState(studio!.app)).alwaysOnTop).toBe(true);
  const state = await windowState(studio.app);
  expect(state).toMatchObject({ focused: false, anyFocused: false, onScreen: false });
  await screenshot(studio.app, "stage-14", "S14-C-pin", page);

  // The next start keeps it on.
  const root = studio.root;
  await studio.close({ keepData: true });
  studio = await launchStudio({ mockModel: false, root });
  await expect(studio.page.getByTestId("pin-toggle")).toHaveAttribute("aria-pressed", "true");
  expect((await windowState(studio.app)).alwaysOnTop).toBe(true);
  await studio.page.getByTestId("pin-toggle").click();
  await expect(studio.page.getByTestId("pin-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await windowState(studio!.app)).alwaysOnTop).toBe(false);
});

test("归档任务: a box says what was archived and returns to the canvas or board; the page keeps a banner", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { drop } = await seed(studio);

  // Opened from the canvas: 返回画布.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByTestId("canvas-card").filter({ hasText: "掉落表调整" }).dblclick();
  await page.getByTestId("task-archive").click();
  const box = page.getByTestId("task-archived-dialog");
  await expect(box).toContainText("已归档任务「掉落表调整」和它的 1 个会话");
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await screenshot(studio.app, "stage-14", "S14-C-archive-dialog", page);
  await box.getByRole("button", { name: "返回画布" }).click();
  // The archived task keeps its card, greyed and marked 已归档 (2026-10-22).
  await expect(page.getByTestId("canvas-card").filter({ hasText: "掉落表调整" })).toHaveClass(/is-archived/);

  // Found again (archived): the page says so, and 恢复任务 brings it back.
  await page.keyboard.press("Control+K");
  await page.getByTestId("search-input").fill("掉落表调整");
  await page.getByTestId("search-row").first().click();
  const banner = page.getByTestId("task-archived-banner");
  await expect(banner).toContainText("已归档 · 只读");
  await expect(page.getByTestId("task-archive")).toHaveCount(0);
  await expect(page.locator(".chat-input")).toHaveCount(0);
  await screenshot(studio.app, "stage-14", "S14-C-archived-task", page);
  await banner.getByRole("button", { name: "恢复任务" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("任务已恢复");
  await expect(page.locator(".chat-input textarea")).toBeEnabled();

  // Opened from the board: 返回看板, or 关闭 to stay on the read-only page.
  await page.getByRole("button", { name: "返回画布" }).click();
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: "掉落表调整" }).click();
  await page.getByTestId("task-archive").click();
  await expect(box.getByRole("button", { name: "返回看板" })).toBeVisible();
  await box.getByRole("button", { name: "关闭" }).click();
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId("task-title")).toHaveText("掉落表调整");
  await expect(banner).toBeVisible();
  const state = await studio.api<{ tasks: Task[] }>("GET", "/api/state");
  expect(state.tasks.find((t) => t.id === drop.task.id)?.archivedAt).toBeTruthy();
});

test("archived sessions: rows like the live ones, faded and marked; opened, a banner restores them", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "整理导入", workspaceId: ws.id, firstSession: { profileId: "codex-mock" } });
  await studio.api("PATCH", `/api/sessions/${session.id}`, { title: "第一次尝试" });
  await studio.api("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock" });
  await studio.api("POST", `/api/sessions/${session.id}/archive`);

  await page.getByTestId("task-card").click();
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await page.getByTestId("archived-toggle").click();
  const row = page.getByTestId("archived-row");
  await expect(row).toContainText("第一次尝试");
  await expect(row).toContainText("Mock Model · 已归档");
  await row.getByText("第一次尝试").click();
  await expect(row).toHaveAttribute("aria-current", "true");
  const banner = page.getByTestId("session-archived-banner");
  await expect(banner).toContainText("已归档 · 只读");
  await expect(page.locator(".chat-input")).toHaveCount(0);
  await row.hover();
  await screenshot(studio.app, "stage-14", "S14-C-archived-session", page);
  await banner.getByRole("button", { name: "恢复会话" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("session-row")).toHaveCount(2);
  await expect(page.locator(".chat-input textarea")).toBeEnabled();
});
