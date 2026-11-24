import { expect, test } from "@playwright/test";
import type { MailMessage, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 待我处理 (2026-11-25, 本机的事项, in place of the task page's 留言): a message between two tasks of one topic goes in by
// itself and is a 事项 the page shows until it is handled; one from a task without a topic waits for the person (先问).
// The task's side panel shows what waits for it, and 「全部 →」 opens the page.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("待我处理: a 先问 message let in, a 事项 marked handled and folded away", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落改版" });
  const y = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "claude-mock", text: "待命" } });
  const send = (args: Record<string, string>) => `[[mcp: mailbox_send ${JSON.stringify(args)}]]`;
  // Same topic: straight into 掉落表's session, a 事项 with one message.
  await studio.api("POST", "/api/tasks", { title: "数值", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: send({ toSessionId: y.session.id, text: "数值表改好了，掉落率按新表读" }) } });
  // No topic: waits for the person.
  await studio.api("POST", "/api/tasks", { title: "美术外包", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: send({ toTaskId: y.task.id, text: "图标下周才到，先用占位图" }) } });
  const mail = () => studio!.api<MailMessage[]>("GET", `/api/mail?forTask=${y.task.id}`);
  await expect.poll(async () => (await mail()).map((m) => `${m.via}:${m.ask ? "ask" : m.state}`).sort(), { timeout: 60_000 }).toEqual(["mail:ask", "mail:forwarded"]);
  await expect(page.getByTestId("thread")).toHaveCount(0);

  // The task page's side panel: the one waiting, and the 事项.
  await page.getByTestId("task-card").filter({ hasText: "掉落表" }).click();
  await expect(page.getByTestId("thread")).toContainText("数值表改好了", { timeout: 60_000 });
  const card = page.getByTestId("mail-card");
  await expect(card).toContainText("图标下周才到，先用占位图");
  await expect(card).toContainText("来自 美术外包");
  await expect(page.getByTestId("pending-line")).toHaveCount(2);
  await screenshot(studio.app, "studio", "pending-task-panel", page);

  // The task's first session is its 任务主控 (the session menu says so).
  await page.getByTestId("session-more").click();
  await expect(page.getByTestId("session-task-lead")).toHaveText("✓ 任务主控");
  await screenshot(studio.app, "studio", "task-lead-menu", page);
  await page.keyboard.press("Escape");

  // The page, from 「全部 →」 (the tab counts what waits for the person).
  await page.getByTestId("pending-open-all").click();
  const pending = page.getByTestId("pending-page");
  await expect(pending).toBeVisible();
  await expect(page.getByTestId("tab-count-pending")).toHaveText("1");
  await expect(pending.getByTestId("mail-card")).toHaveCount(1);
  const threads = pending.getByTestId("pending-thread");
  await expect(threads.filter({ hasText: "数值表改好了" })).toContainText("事项 1");
  await expect(threads.filter({ hasText: "数值表改好了" })).toContainText(/送到|看过/);
  await screenshot(studio.app, "studio", "pending-page", page);

  // Let it in: it goes into 掉落表's session as a 留言 of its own 事项.
  await pending.getByTestId("mail-card").getByRole("button", { name: "送进会话" }).click();
  await expect(pending.getByTestId("mail-card")).toHaveCount(0);
  await expect(page.getByTestId("tab-count-pending")).toHaveCount(0);
  await expect.poll(async () => (await mail()).filter((m) => m.state === "forwarded").length, { timeout: 30_000 }).toBe(2);

  // Its 事项 now shows the message on its way (送到 / 看过 once the session read it).
  const later = threads.filter({ hasText: "图标下周才到" });
  await expect(later).toContainText(/送到|看过/, { timeout: 30_000 });
  await screenshot(studio.app, "studio", "pending-page-sent", page);

  // Marking a 事项's messages handled closes it when nobody is waited on any more; 关闭事项 closes one by hand.
  await threads.filter({ hasText: "数值表改好了" }).getByRole("button", { name: "都标成处理了" }).click();
  await expect(threads.filter({ hasText: "数值表改好了" })).toHaveCount(0);
  await later.getByRole("button", { name: "关闭事项" }).click();
  await expect(threads).toHaveCount(0);
  await expect(pending).toContainText("现在没有要你处理的");
});
