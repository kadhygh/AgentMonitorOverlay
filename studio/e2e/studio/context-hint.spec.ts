import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-10-17: what long sessions cost. A large context shows a bar above the composer (compact now, or dismiss it); a
// subagent's own tokens show on its row and under the composer.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a large context shows a bar above the composer; a subagent's own use shows on its row (2026-10-17)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "迁移装甲车",
    workspaceId: ws.id,
    firstSession: { profileId: "claude-mock", text: "[[context: 180000]] 读完旧代码" },
  });
  const idle = () => expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.status, { timeout: 60_000 }).toBe("idle");
  await idle();
  await page.getByTestId("task-card").filter({ hasText: "迁移装甲车" }).click();
  const hint = page.getByTestId("context-hint");
  await expect(hint).toContainText("上下文 180", { timeout: 30_000 });
  await expect(hint).toContainText("到 272k 自动压缩");
  await screenshot(studio.app, "stage-16", "S16-G-context-hint", page);
  await hint.getByTestId("context-hint-dismiss").click();
  await expect(hint).toHaveCount(0);

  // A subagent: its row and the line under the composer show what it spent.
  const composer = page.getByLabel("输入消息");
  // (A subagent that only answers sends no message of its own; one that runs a command does.)
  await composer.fill("[[spawn: helper: [[shell: echo hi]]]]");
  await composer.press("Enter");
  await expect(page.getByTestId("subagent-usage")).toContainText("用量", { timeout: 60_000 });
  await expect(page.getByTestId("sub-usage")).toContainText("子 agent");
});
