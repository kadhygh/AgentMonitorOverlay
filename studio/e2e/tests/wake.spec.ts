import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import type { SessionWake, StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Stage 15 (2026-10-16): a Claude session that goes on by itself. Its loop and a usage limit show above the composer
// and in the session list; after a Host restart Studio takes the loop's wakeup over; the person can stop the loop or
// switch going on after the limit. The mock cannot run a real /loop or hit a claude.ai limit, so the wake is written
// into the data dir between two launches (as the Host stores it).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

function writeWake(dataDir: string, sessionId: string, wake: SessionWake): void {
  const db = new DatabaseSync(join(dataDir, "studio.db"));
  try {
    db.prepare("UPDATE sessions SET wake = ? WHERE id = ?").run(JSON.stringify(wake), sessionId);
  } finally {
    db.close();
  }
}

test("a loop and a usage limit above the composer: stop the loop, switch going on after the limit", async () => {
  studio = await launchStudio();
  let { page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock Claude" }).click();
  await page.getByLabel("第一句话").fill("hello loop");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello loop", { timeout: 60_000 });
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const sessionId = state.sessions.find((s) => s.title === "hello loop")!.id;
  await expect(page.getByTestId("wake-bar")).toHaveCount(0);

  // The agent was looping when the Host went down: its next wakeup in half an hour.
  const root = studio.root;
  const dataDir = studio.dataDir;
  await studio.close({ keepData: true });
  const at = new Date(Date.now() + 30 * 60_000);
  writeWake(dataDir, sessionId, { loop: { at: at.toISOString(), reason: "遥控赛车在后台执行，完成时会自动唤醒", prompt: "loop tick" } });
  studio = await launchStudio({ root });
  page = studio.page;
  await page.getByTestId("task-card").first().click();
  const bar = page.getByTestId("wake-bar");
  await expect(bar).toHaveAttribute("data-kind", "loop");
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  // Past midnight the bar names the day too (下次 10月21日 00:07).
  await expect(bar).toContainText(new RegExp(`Loop 中 · 下次 (\\d+月\\d+日 )?${hm}`));
  await expect(bar).toContainText("遥控赛车在后台执行");
  await expect(page.getByTestId("session-wake")).toHaveText(new RegExp(`^loop · (\\d+月\\d+日 )?${hm}$`));
  await expect(page.getByTestId("thread")).toContainText("Host 重启后，这条会话的 loop 由 Studio 按时唤醒。");
  await screenshot(studio.app, "stage-15", "S15-01-loop-bar", page);

  await bar.getByRole("button", { name: "停止 loop" }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("session-wake")).toHaveCount(0);
  await expect(page.getByTestId("thread")).toContainText("你在 Studio 里停止了这条会话的 loop。");
  expect((await studio.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === sessionId)!.wake).toBeUndefined();

  // A usage limit, outside a loop: it waits for the person to turn going on by itself on.
  const resets = new Date(Date.now() + 2 * 3600_000);
  await studio.close({ keepData: true });
  writeWake(dataDir, sessionId, { limit: { resetsAt: resets.toISOString(), message: "You've hit your session limit · resets 12:30am (Asia/Hong_Kong)", autoContinue: false } });
  studio = await launchStudio({ root });
  page = studio.page;
  await page.getByTestId("task-card").first().click();
  const limitBar = page.getByTestId("wake-bar");
  await expect(limitBar).toHaveAttribute("data-kind", "limit");
  await expect(limitBar).toContainText("额度用完");
  await expect(page.getByTestId("session-wake")).toContainText("等额度");
  const box = limitBar.getByRole("checkbox", { name: "恢复后自动继续" });
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  await expect(limitBar).toContainText("恢复后自动继续");
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === sessionId)!.wake?.limit?.autoContinue).toBe(true);
  await expect(box).toBeChecked();
  await screenshot(studio.app, "stage-15", "S15-02-limit-bar", page);
});
