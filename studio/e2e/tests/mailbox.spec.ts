import { expect, test } from "@playwright/test";
import type { MailMessage, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Mail between sessions: a Codex session leaves messages for a Claude session and its task through the AMO MCP; the
// person sees them on the task page and decides (forward / dismiss); the recipient can also read mail itself.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("mail between sessions, forwarded or dismissed by the person", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const scope = { workspaceId: ws.id };
  const b = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "收件任务", ...scope, firstSession: { profileId: "claude-mock", text: "hello" } });
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "发件任务",
    scope,
    firstSession: { profileId: "codex-mock", text: `[[mcp: mailbox_send {"toSessionId":"${b.session.id}","text":"导入接口改好了，你可以接着做"}]]` },
  });
  const mailFor = () => studio!.api<MailMessage[]>("GET", `/api/mail?forTask=${b.task.id}`);
  await expect.poll(async () => (await mailFor()).length, { timeout: 60_000 }).toBe(1);
  await studio.api("POST", `/api/sessions/${a.session.id}/messages`, { text: `[[mcp: mailbox_send {"toTaskId":"${b.task.id}","text":"记得同步配置键"}]]` });
  await expect.poll(async () => (await mailFor()).length, { timeout: 60_000 }).toBe(2);

  // The recipient's task page: two messages, the session row counts the one for it.
  await page.getByTestId("task-card").filter({ hasText: "收件任务" }).click();
  await expect(page.getByTestId("mail-count")).toHaveText("2");
  await expect(page.getByTestId("session-row").first()).toContainText("1 条留言");
  const cards = page.getByTestId("mail-card");
  await expect(cards.first()).toContainText("来自 发件任务");
  await screenshot(studio.app, "stage-5", "S5-03-mail", page);

  // Dismiss the task message; forward the session message into the conversation.
  await cards.filter({ hasText: "记得同步配置键" }).getByRole("button", { name: "忽略" }).click();
  await expect(cards).toHaveCount(1);
  await cards.getByRole("button", { name: "转进对话" }).click();
  await expect(page.getByTestId("mail-card")).toHaveCount(0);
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: [AMO 留言] 来自任务「发件任务」", { timeout: 60_000 });
  expect((await mailFor()).map((m) => m.state).sort()).toEqual(["dismissed", "forwarded"]);

  // The recipient can also read its own mail on its next turn.
  await studio.api("POST", `/api/sessions/${a.session.id}/messages`, { text: `[[mcp: mailbox_send {"toSessionId":"${b.session.id}","text":"第三条：测试也补上了"}]]` });
  await expect(page.getByTestId("mail-count")).toHaveText("1", { timeout: 60_000 });
  await page.getByLabel("输入消息").fill("[[mcp: mailbox_read]]");
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("第三条：测试也补上了", { timeout: 60_000 });
  // Read by the agent: no longer unread, so the session row stops counting it.
  await expect(page.getByTestId("session-row").first()).not.toContainText("条留言");
});
