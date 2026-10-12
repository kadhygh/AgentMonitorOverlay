import { expect, test } from "@playwright/test";
import type { MailMessage, Session, Task, TaskNote, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Stage 5 acceptance (ROADMAP): two sessions hand work over through AMO, at the person's pace.
// A (Codex) submits a handoff summary and leaves mail for B (Claude); the person forwards the mail into B's
// conversation; B reads A's handoff through the AMO MCP and records that it took over. Mock models only.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a Codex session hands work to a Claude session through AMO mail", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const scope = { kind: "workspace", workspaceId: ws.id };
  const summary = "交接：重试已加在 importer.ts，测试还没写，入口 tests/import";

  // A finishes its part: a handoff summary on its own task.
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "导入重试",
    scope,
    firstSession: { profileId: "codex-mock", text: `[[mcp: handoff_submit {"summary":"${summary}"}]]` },
  });
  await expect.poll(async () => (await studio!.api<TaskNote[]>("GET", `/api/tasks/${a.task.id}/notes`)).map((n) => n.kind), { timeout: 60_000 }).toEqual(["handoff"]);

  // B exists; A leaves it a message pointing at the handoff.
  const b = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "补测试", scope, firstSession: { profileId: "claude-mock", text: "待命" } });
  await studio.api("POST", `/api/sessions/${a.session.id}/messages`, {
    text: `[[mcp: mailbox_send {"toSessionId":"${b.session.id}","text":"请接手补测试，交接摘要在任务 ${a.task.id}"}]]`,
  });
  await expect.poll(async () => (await studio!.api<MailMessage[]>("GET", `/api/mail?sessionId=${b.session.id}`)).length, { timeout: 60_000 }).toBe(1);

  // Nothing reaches B until the person forwards it.
  await page.getByTestId("task-card").filter({ hasText: "补测试" }).click();
  await expect(page.getByTestId("msg-agent")).toHaveCount(1);
  await expect(page.getByTestId("mail-card")).toContainText("请接手补测试");
  await page.getByTestId("mail-card").getByRole("button", { name: "转进对话" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: [AMO 留言] 来自任务「导入重试」", { timeout: 60_000 });

  // B reads A's handoff through the MCP, then records on its own task that it took over.
  const composer = page.getByLabel("输入消息");
  await composer.fill(`[[mcp: task_get {"taskId":"${a.task.id}"}]]`);
  await composer.press("Enter");
  // Wait for the MCP reply itself: A's session title (its first message) already quotes the summary.
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-MCP:", { timeout: 60_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("重试已加在 importer.ts");
  await composer.fill('[[mcp: task_note_add {"text":"已接手：按交接补 tests/import"}]]');
  await composer.press("Enter");
  await expect(page.getByTestId("task-note")).toContainText("已接手：按交接补 tests/import", { timeout: 60_000 });
  await screenshot(studio.app, "stage-5", "S5-07-handoff", page);

  // Each task keeps its own record; the mail is marked forwarded.
  expect((await studio.api<TaskNote[]>("GET", `/api/tasks/${b.task.id}/notes`)).map((n) => [n.sessionId, n.text])).toEqual([[b.session.id, "已接手：按交接补 tests/import"]]);
  expect((await studio.api<TaskNote[]>("GET", `/api/tasks/${a.task.id}/notes`)).map((n) => n.text)).toEqual([summary]);
  expect((await studio.api<MailMessage[]>("GET", `/api/mail?sessionId=${b.session.id}`)).map((m) => m.state)).toEqual(["forwarded"]);
});
