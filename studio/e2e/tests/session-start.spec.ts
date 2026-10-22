import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 开会话 (session_start, 2026-10-22): a session starts another main session in its own task, without asking the person;
// with report, the new session's first finished turn comes back into the caller's conversation.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

for (const profileId of ["claude-mock", "codex-mock"]) {
  test(`session_start from a ${profileId} session: a second session in the task, its result reported back`, async () => {
    studio = await launchStudio();
    const { page } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
    const start = `[[mcp: session_start ${JSON.stringify({ text: "数一下掉落表有几张", title: "数表", report: true })}]]`;
    const { task, session: caller } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title: "掉落表",
      workspaceId: ws.id,
      firstSession: { profileId, text: start },
    });
    const sessions = async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id);
    // No approval asked: the second main session is there, named, on the caller's model.
    await expect.poll(async () => (await sessions()).length, { timeout: 60_000 }).toBe(2);
    const started = (await sessions()).find((s) => s.id !== caller.id)!;
    expect(started).toMatchObject({ kind: "main", parentId: null, title: "数表", profileId });

    await page.getByTestId("task-card").first().click();
    const thread = page.getByTestId("thread");
    // The caller's conversation gets the report once the new session's turn ends.
    await expect(thread).toContainText(`【你开的会话「数表」（${started.id}）这一轮做完了】`, { timeout: 60_000 });
    await expect(thread).toContainText("MOCK:");
    // The new session says who started it.
    await page.locator('[data-testid="session-row"][title^="数表"]').click();
    await expect(thread).toContainText("【由本任务的会话", { timeout: 30_000 });
    await expect(thread).toContainText("数一下掉落表有几张");
    if (profileId === "claude-mock") await screenshot(studio.app, "stage-18", "S18-session-start", page);
  });
}
