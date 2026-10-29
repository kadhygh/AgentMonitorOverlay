import { expect, test, type Page } from "@playwright/test";
import type { Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-10-21: a Claude session that ended its turn while its background subagents still run is 进行中, not 完成待审核
// (Focus had called it finished — and the robot come out — each time the session took a moment's turn); its running
// subagents fold to「▸ N」 (方案 D). A task pinned in Focus stays on top in one line, its detail open only while it
// waits for the person (10-22). Opened to deal with it
// (from Focus, or from the board), a long reply offers 「按 ↑ 回到本轮回复开始」.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openFocus(s: Studio): Promise<Page> {
  const opened = s.app.waitForEvent("window");
  await s.page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });
  return focus;
}

test("Focus: waiting for its subagents is 进行中 with ▸ N, finished once they end; a pinned task stays on top, open", async () => {
  studio = await launchStudio();
  const { app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const focus = await openFocus(studio);

  // The session starts a background subagent that runs a while, and ends its own turn at once.
  await studio.api<{ task: Task }>("POST", "/api/tasks", {
    title: "调查方案",
    workspaceId: ws.id,
    firstSession: { profileId: "claude-mock", text: "[[spawn-bg: watcher: [[shell: ping -n 20 127.0.0.1]]]]", options: { permission: "bypassPermissions" } },
  });
  const working = focus.getByTestId("focus-working-entry");
  await expect(working).toHaveAttribute("data-waiting-subs", "true", { timeout: 60_000 });
  await expect(working).toContainText("调查方案");
  await expect(working).toContainText("等子 agent");
  await expect(working.getByTestId("focus-status-word").first()).toHaveText("◐等待");
  // Not finished, nothing for the person yet.
  await expect(focus.getByTestId("focus-entry")).toHaveCount(0);
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理");
  await expect(focus.getByTestId("focus-bot")).toHaveCount(0);

  const toggle = working.getByTestId("focus-subs-toggle");
  await expect(toggle).toHaveText("▸ 1");
  await toggle.click();
  await expect(toggle).toHaveText("▾ 1");
  const sub = focus.getByTestId("focus-sub-row");
  await expect(sub).toContainText("watcher");
  await expect(sub).toContainText("已跑");
  await screenshot(app, "stage-18", "S18-focus-subagents", focus, "focus");

  // 置顶 while it works: on top in one line, no longer under 进行中 (10-22).
  await working.hover();
  await working.getByTestId("focus-pin").click();
  const pinned = focus.getByTestId("focus-pinned");
  await expect(pinned).toContainText("调查方案");
  await expect(pinned).toContainText("等子 agent");
  await expect(focus.getByTestId("focus-working")).toHaveCount(0);
  await expect(pinned.getByTestId("focus-snippet")).toHaveCount(0);
  // Kept per machine.
  await expect.poll(() => focus.evaluate(() => JSON.parse(localStorage.getItem("amo.focusPinned") ?? "[]").length)).toBe(1);

  // The subagent ends and the session reports: finished work, still one line (only an approval or a question opens it).
  await expect(pinned).toContainText("完成待审核", { timeout: 90_000 });
  await expect(pinned.getByTestId("focus-snippet")).toHaveCount(0);
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toHaveCount(0);
  await screenshot(app, "stage-18", "S18-focus-pinned", focus, "focus");

  // Unpinned, it is finished work in the list again.
  await pinned.getByTestId("focus-pin").click();
  await expect(pinned).toHaveCount(0);
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("完成待审核");
});

test("Focus: a pinned task opens its detail only while it waits for an approval (10-22)", async () => {
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const focus = await openFocus(studio);
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", {
    title: "掉落表校验",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo pinned-approval]]" },
  });
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toContainText("待批准", { timeout: 30_000 });
  await entry.hover();
  await entry.getByTestId("focus-pin").click();

  // Pinned, the approval is dealt with on top, its command shown.
  const pinned = focus.getByTestId("focus-pinned");
  await expect(pinned).toContainText("待批准");
  await expect(pinned.getByTestId("focus-snippet")).toContainText("cmd /c echo pinned-approval");
  await expect(entry).toHaveCount(0);
  await pinned.getByRole("button", { name: "批准", exact: true }).click();

  // Approved: back to one line.
  await expect(pinned.getByTestId("focus-snippet")).toHaveCount(0, { timeout: 30_000 });
  await expect(pinned).not.toContainText("待批准");
  expect(await focus.evaluate(() => JSON.parse(localStorage.getItem("amo.focusPinned") ?? "[]"))).toEqual([task.id]);
});

/** A message the mock model echoes back, long enough that its reply starts far above the bottom. */
const LONG = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段`).join("\n\n");

test("opened to deal with it — from Focus or from the board — a long reply offers to go back to its start", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const focus = await openFocus(studio);

  // Two long replies end while the board shows.
  await studio.api("POST", "/api/tasks", { title: "长回复一", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: LONG } });
  const entries = focus.getByTestId("focus-entry");
  await expect(entries).toHaveCount(1, { timeout: 60_000 });
  await studio.api("POST", "/api/tasks", { title: "长回复二", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: LONG } });
  await expect(entries).toHaveCount(2, { timeout: 60_000 });
  // (A new session is idle for an instant before it starts: wait for its reply, shown in the entry that opens.)
  await expect(entries.filter({ hasText: "长回复二" }).getByTestId("focus-snippet")).toContainText("MOCK: 第 1 段", { timeout: 60_000 });

  // In Focus, opening the second one counts as seeing it; going on to the workbench from there still offers the hint.
  const first = entries.filter({ hasText: "长回复一" });
  await first.getByRole("button", { name: /长回复一/ }).click();
  await first.getByRole("button", { name: "在工作台打开" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("长回复一");
  const hint = page.getByTestId("turn-start-hint");
  await expect(hint).toBeVisible({ timeout: 15_000 });
  await screenshot(app, "stage-18", "S18-turn-start-from-focus", page);
  await hint.click();
  await expect(hint).toHaveCount(0);

  // From the board: the other one, still unseen.
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: "长回复二" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("长回复二");
  await expect(hint).toBeVisible({ timeout: 15_000 });

  // Back to one already looked at: nothing to deal with, no hint.
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: "长回复一" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("长回复一");
  await expect(page.getByTestId("msg-agent").first()).toBeVisible();
  await page.waitForTimeout(500);
  await expect(hint).toHaveCount(0);
});
