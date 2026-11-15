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
    // 2026-11-15 (交流框架): not as the person's bubble — a folded row that says whose it is, all of it on a click.
    const report = thread.getByTestId("msg-origin").filter({ hasText: "子会话「数表」回报" });
    await expect(report).toBeVisible({ timeout: 60_000 });
    await expect(report).toHaveAttribute("data-kind", "report");
    await expect(report.getByTestId("msg-origin-brief")).toContainText("MOCK:");
    await expect(thread.getByTestId("msg-user").filter({ hasText: "这一轮做完了" })).toHaveCount(0);
    await report.scrollIntoViewIfNeeded();
    if (profileId === "claude-mock") await screenshot(studio.app, "studio", "origin-report-folded", page);
    await report.getByTestId("msg-origin-toggle").click();
    await expect(report.getByTestId("msg-origin-body")).toContainText("MOCK:");
    if (profileId === "claude-mock") await screenshot(studio.app, "studio", "origin-report-open", page);
    // 事项清单 (2026-11-15; 设置 → 测试功能 → 脉络): in the side column, the sub-session it started — ended, its report here.
    if (profileId === "claude-mock") {
      await expect(page.getByTestId("matters-panel")).toHaveCount(0);
      await studio.api("PUT", "/api/settings", { experimentalFeatures: ["tracks"] });
      if (!(await page.getByTestId("matters-panel").count())) await page.getByTestId("sidebar-toggle").click();
      const matters = page.getByTestId("matters-panel");
      await expect(matters.getByTestId("matters-open-count")).toHaveText("0");
      const matter = matters.getByTestId("matter").filter({ hasText: "子会话「数表」" });
      await expect(matter).toHaveAttribute("data-state", "done");
      await expect(matter).toContainText("结果已回到这里");
      await report.getByTestId("msg-origin-toggle").click();
      await matter.click();
      await expect(report).toBeInViewport();
      await screenshot(studio.app, "studio", "matters-panel", page);
      // 打字时不插队 (2026-11-15; behind its own 测试功能 switch since the same day): while the person writes in the
      // composer, what is forwarded here waits for their message.
      await studio.api("PUT", "/api/settings", { experimentalFeatures: ["tracks", "typing-hold"] });
      await page.waitForTimeout(500);
      await page.getByLabel("输入消息").pressSequentially("我先写一句");
      await page.waitForTimeout(500);
      const mail = await studio.api<{ id: string }>("POST", "/api/mail", { to: { kind: "session", sessionId: caller.id }, text: "打字时转来的留言" });
      await studio.api("POST", `/api/mail/${mail.id}/forward`, {});
      const heldLine = page.getByTestId("msg-delivery").filter({ hasText: "等你发出下一条消息时一起送进去" });
      await expect(heldLine).toHaveAttribute("data-delivery", "held");
      await expect(thread.getByTestId("msg-origin").filter({ hasText: "留言 · 来自" })).toBeVisible();
      await expect(matters.getByTestId("matter").filter({ hasText: "1 条转来的消息还没送进去" })).toBeVisible();
      await page.waitForTimeout(1500);
      await expect(heldLine).toHaveAttribute("data-delivery", "held");
      await heldLine.scrollIntoViewIfNeeded();
      await screenshot(studio.app, "studio", "inbox-held-typing", page);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByTestId("msg-delivery")).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByTestId("msg-agent").last()).toContainText("打字时转来的留言", { timeout: 30_000 });
    }
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
    await expect(thread.getByTestId("msg-origin").first()).toContainText("开启了这个会话", { timeout: 30_000 });
    await expect(thread).toContainText("数一下掉落表有几张");
    if (profileId === "claude-mock") await screenshot(studio.app, "stage-18", "S18-session-start", page);
  });
}
