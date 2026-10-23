import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 开会话 (session_start, 2026-10-22): a session starts another main session in its own task, without asking the person;
// with report, the new session's first finished turn comes back into the caller's conversation. 委派 (10-22): on another
// model when named, and the session list shows it under the caller with its own icon.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

for (const [profileId, other] of [["claude-mock", "codex-mock"], ["codex-mock", "claude-mock"]] as const) {
  test(`session_start from a ${profileId} session: a second session in the task on ${other}, under it, its result reported back`, async () => {
    studio = await launchStudio();
    const { page } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
    const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
    const start = `[[mcp: session_start ${JSON.stringify({ text: "数一下掉落表有几张", title: "数表", model: other, report: true, workspace: "beta" })}]]`;
    const { task, session: caller } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title: "掉落表",
      workspaceId: ws.id,
      firstSession: { profileId, text: start },
    });
    const sessions = async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id);
    // No approval asked: the second main session is there, named, on the model asked for, marked as the caller's.
    await expect.poll(async () => (await sessions()).find((s) => s.id !== caller.id)?.title, { timeout: 60_000 }).toBe("数表");
    const started = (await sessions()).find((s) => s.id !== caller.id)!;
    expect(started).toMatchObject({ kind: "main", parentId: null, title: "数表", profileId: other, startedBy: caller.id, workspaceId: beta.id, taskId: task.id });

    await page.getByTestId("task-card").first().click();
    const thread = page.getByTestId("thread");
    // The caller's conversation gets the report once the new session's turn ends.
    await expect(thread).toContainText(`【你开的会话「数表」（${started.id}）这一轮做完了】`, { timeout: 60_000 });
    await expect(thread).toContainText("MOCK:");
    // In the list it hangs under the caller, with the 委派 icon and its own model's mark.
    const row = page.locator('[data-testid="session-row"][title^="数表"]');
    await expect(row).toHaveAttribute("data-depth", "1");
    await expect(row).toHaveAttribute("data-delegated", "true");
    await expect(row).toHaveAttribute("title", /委派会话/);
    await expect(page.getByTestId("session-fold")).toHaveText(/1/);
    // It works in another project than the task's: the row says which.
    await expect(row.getByTestId("session-project")).toHaveText("beta");
    // The new session says who started it.
    await row.click();
    await expect(page.getByTestId("session-detail")).toContainText("由「");
    await expect(thread).toContainText("【由本任务的会话", { timeout: 30_000 });
    await expect(thread).toContainText("数一下掉落表有几张");
    if (profileId === "claude-mock") await screenshot(studio.app, "stage-18", "S18-session-start", page);
  });
}
