import { expect, test, type Page } from "@playwright/test";
import type { Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 2026-10-21: a Claude session that ended its turn while its background subagents still run is 进行中, not 完成待审核
// (Focus had called it finished — and the robot come out — each time the session took a moment's turn); its running
// subagents fold to「▸ N」 (方案 D). A task pinned in Focus stays on top with its detail open. Opened to deal with it
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
  await expect(working.locator(".dot.ring")).toHaveCount(1);
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

  // The subagent ends and the session reports: now it is finished work to look at.
  await expect(working).toHaveCount(0, { timeout: 90_000 });
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("完成待审核");

  // 置顶: on top, its detail open, listed once.
  await entry.hover();
  await entry.getByTestId("focus-pin").click();
  const pinned = focus.getByTestId("focus-pinned");
  await expect(pinned).toContainText("调查方案");
  await expect(pinned).toContainText("完成待审核");
  await expect(pinned.getByTestId("focus-snippet")).toBeVisible();
  await expect(entry).toHaveCount(0);
  // 我知道了: reviewed, still pinned, still open.
  await pinned.getByTestId("focus-done").click();
  await expect(pinned).toContainText("空闲");
  await expect(pinned.getByTestId("focus-snippet")).toBeVisible();
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理");
  await screenshot(app, "stage-18", "S18-focus-pinned", focus, "focus");
  // Kept per machine.
  await expect.poll(() => focus.evaluate(() => JSON.parse(localStorage.getItem("amo.focusPinned") ?? "[]").length)).toBe(1);

  await pinned.getByTestId("focus-unpin").click();
  await expect(pinned).toHaveCount(0);
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
