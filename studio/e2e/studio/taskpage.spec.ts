import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { forkLatest, launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTaskWithReply(s: Studio) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "整理导入流程",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "先看看现状" },
  });
  await s.page.getByTestId("task-card").filter({ hasText: "整理导入流程" }).click();
  await expect(s.page.getByTestId("task-title")).toHaveText("整理导入流程");
  await expect(s.page.getByTestId("msg-agent")).toContainText("MOCK: 先看看现状", { timeout: 30_000 });
  return created;
}

test("task page: column, fork, new session, terminal and archive", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { task } = await openTaskWithReply(studio);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(1);
  // 仅工作台 is the usual writer and is not shown.
  await expect(page.getByTestId("writer")).toHaveCount(0);

  // Task status is set by the person and moves the card: the status under the title opens a small menu.
  await page.getByTestId("task-status").click();
  await page.getByTestId("status-review").click();
  await expect(page.getByTestId("task-status")).toHaveText("待审阅");
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).tasks[0]!.column).toBe("review");

  // Fork: indented under its parent, same model, and selected afterwards.
  await forkLatest(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-kind", "fork");
  await expect(rows.nth(1)).toHaveAttribute("data-depth", "1");
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  // One line per session (细线树); the selected one is described under the tree.
  await expect(page.getByTestId("session-detail")).toContainText("分支 · Mock Model");

  // A second independent session in the same task.
  await page.getByTestId("new-session-toggle").click();
  await page.getByRole("button", { name: "开始新会话" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toHaveAttribute("data-depth", "0");

  // Open in terminal: test mode records the launch instead of opening a window.
  await rows.first().click();
  await page.getByTestId("session-more").click();
  await page.getByTestId("session-terminal").click();
  await expect(page.getByTestId("toast")).toContainText("已在新终端窗口接入同一会话");
  await expect(page.getByTestId("toast").locator("code")).toHaveText(/^codex --remote ws:\/\/127\.0\.0\.1:\d+ --remote-auth-token-env AMO_STUDIO_CODEX_TOKEN resume \S+$/);
  await expect(page.getByTestId("writer")).toHaveText("终端已接入 · 共享");
  await expect(rows.first().getByLabel("终端已接入")).toBeVisible();
  await expect(page.getByTestId("session-detail")).toContainText("终端已接入");
  await screenshot(studio.app, "stage-1", "S1-11a-task-page", page);

  // Archive the main session: its fork goes with it; restore brings both back.
  await page.getByTestId("session-archive").click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: /已归档 1/ }).click();
  await expect(page.getByTestId("archived-row")).toHaveCount(1);
  await page.getByTestId("archived-row").hover();
  await page.getByTestId("archived-row").getByRole("button", { name: "查看" }).click();
  await expect(page.getByTestId("session-archived-banner")).toContainText("已归档 · 只读");
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 先看看现状");
  await page.getByTestId("archived-row").hover();
  await page.getByTestId("archived-row").getByRole("button", { name: "恢复", exact: true }).click();
  await expect(rows).toHaveCount(3);
  const sessions = (await studio.api<StateSnapshot>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id);
  expect(sessions.every((s) => !s.archivedAt)).toBe(true);
});

test("细线树: a fork of a fork hangs one level deeper, each level on its own line", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await openTaskWithReply(studio);
  const rows = page.getByTestId("session-row");
  await forkLatest(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  // Fork the fork: it is selected now, so 分支 branches it.
  await forkLatest(page);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toHaveAttribute("data-kind", "fork");
  await expect(rows.nth(2)).toHaveAttribute("data-depth", "2");
  await expect(rows.nth(2)).toHaveAttribute("aria-level", "3");
  await expect(page.getByRole("tree", { name: "会话树" }).getByRole("group")).toHaveCount(2);
  // The root names what hangs under it.
  await rows.first().click();
  await expect(page.getByTestId("session-detail")).toContainText("2 个分支");
  await screenshot(app, "stage-14", "S14-P-session-tree", page);
});

test("分支 from a chosen turn: the dialog's turn, 平级会话, title and effort; the branch has the conversation up to there (2026-11-10)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const { session } = await openTaskWithReply(studio);
  const composer = page.getByLabel("输入消息");
  await composer.fill("再改一下导出");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 再改一下导出", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });

  // Under the first turn's reply, beside 复制.
  const first = page.getByTestId("turn-foot").first();
  await first.hover();
  await first.getByTestId("turn-fork").click();
  const dialog = page.getByTestId("fork-dialog");
  await expect(dialog.getByTestId("fork-turn")).toHaveValue(/.+/);
  await expect(dialog).toContainText("带上第 1 到第 1 轮，后面 1 轮不带");
  await expect(dialog.getByTestId("fork-title")).toHaveValue("先看看现状 · 第 1 轮分支");
  await dialog.getByTestId("fork-mode-peer").click();
  await dialog.getByTestId("fork-title").fill("只看现状");
  await dialog.getByTestId("fork-more").click();
  await dialog.getByTestId("effort").getByRole("button").first().click();
  await expect(dialog.getByTestId("fork-more")).toContainText("改了 1 项");
  await screenshot(app, "studio", "fork-dialog", page);
  await dialog.getByTestId("fork-submit").click();
  await expect(dialog).toHaveCount(0);

  // Beside the source, not under it; it says where it came from; its conversation ends at the first turn.
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  const branch = rows.filter({ hasText: "只看现状" });
  await expect(branch).toHaveAttribute("data-kind", "main");
  await expect(branch).toHaveAttribute("data-depth", "0");
  await expect(branch.getByTestId("session-forked-from")).toHaveText("第 1 轮分出");
  await expect(page.getByTestId("msg-agent")).toHaveCount(1);
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 先看看现状");
  await expect(page.getByText("从「先看看现状」第 1 轮分出")).toBeVisible();
  const made = (await studio.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.title === "只看现状")!;
  expect(made).toMatchObject({ kind: "main", parentId: null, forkOf: { sessionId: session.id, turn: 1 } });
  expect(made.options.effort).toBeTruthy();
  await screenshot(app, "studio", "fork-peer", page);

  // It goes on from there: the model remembers the first turn only.
  await composer.fill("在分支里");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 在分支里", { timeout: 30_000 });
  const sent = JSON.stringify(studio.mock!.requests.at(-1));
  expect(sent).toContain("先看看现状");
  expect(sent).not.toContain("再改一下导出");
});

test("细线树: a session folds what hangs under it to ▸ N, kept after a reload; selecting a session inside opens it (10-22)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", {
    title: "折叠子 agent",
    workspaceId: ws.id,
    firstSession: { profileId: "claude-mock", text: "[[spawn: helper: say hi]]", options: { permission: "bypassPermissions" } },
  });
  await page.getByTestId("task-card").filter({ hasText: "折叠子 agent" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-DONE", { timeout: 60_000 });
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  // A fork too: the main session has a subagent and a fork under it.
  await forkLatest(page);
  await expect(rows).toHaveCount(3);
  await rows.first().click();

  const fold = page.getByTestId("session-fold");
  await expect(fold).toHaveCount(1);
  await expect(fold).toHaveText("▾ 2");
  await fold.click();
  await expect(fold).toHaveText("▸ 2");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(1);
  await screenshot(app, "stage-18", "S18-session-tree-folded", page);

  // Kept per machine.
  await page.reload();
  await expect(page.getByTestId("task-title")).toHaveText("折叠子 agent", { timeout: 30_000 });
  await expect(rows).toHaveCount(1);
  await expect(fold).toHaveText("▸ 2");

  // The subagent opened from the conversation: the way to it opens.
  await page.getByTestId("msg-subagent").getByRole("button", { name: "查看" }).click();
  await expect(page.getByTestId("thread-head")).toContainText("helper");
  await expect(rows).toHaveCount(3);
  await expect(fold).toHaveText("▾ 2");
  await expect(page.locator('[data-testid="session-row"][data-kind="sub"]')).toHaveAttribute("aria-current", "true");
});
