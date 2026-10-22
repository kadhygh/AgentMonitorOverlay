import { expect, test } from "@playwright/test";
import type { DecisionRequest, MailMessage, Session, Task, TaskNote, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// What collaboration looks like in the workbench: the task page's progress (handoff on top, notes, the person's own
// note) and the board's hints (open decisions and unread mail as counts, next to the one status).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("progress on the task page and collaboration hints on the board", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const scope = { workspaceId: ws.id };
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "导入重试",
    scope,
    firstSession: { profileId: "codex-mock", text: '[[mcp: task_note_add {"text":"重试逻辑已加"}]]' },
  });
  const notes = () => studio!.api<TaskNote[]>("GET", `/api/tasks/${a.task.id}/notes`);
  await expect.poll(async () => (await notes()).length, { timeout: 60_000 }).toBe(1);
  await studio.api("POST", `/api/sessions/${a.session.id}/messages`, { text: '[[mcp: handoff_submit {"summary":"交接：importer.ts 已改，测试在 tests/import 下"}]]' });
  await expect.poll(async () => (await notes()).length, { timeout: 60_000 }).toBe(2);

  // Another session asks this task's session a question (decision) and leaves mail for the task.
  const b = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "配置键统一",
    scope,
    firstSession: { profileId: "claude-mock", text: `[[mcp: mailbox_send {"toTaskId":"${a.task.id}","text":"导入完成后告诉我"}]]` },
  });
  await expect.poll(async () => (await studio!.api<MailMessage[]>("GET", `/api/mail?forTask=${a.task.id}`)).length, { timeout: 60_000 }).toBe(1);
  await studio.api("POST", `/api/sessions/${a.session.id}/messages`, { text: '[[mcp: decision_request {"question":"重试上限设几次？","options":["3","5"]}]]' });
  await expect.poll(async () => (await studio!.api<DecisionRequest[]>("GET", "/api/decisions?state=open")).length, { timeout: 60_000 }).toBe(1);
  expect(b.task.id).not.toBe(a.task.id);

  // Board: counts in the card's own line; the top bar counts the task as needing the person.
  const card = page.getByTestId("task-card").filter({ hasText: "导入重试" });
  await expect(card.getByTestId("card-asks")).toHaveText("1 个待决策 · 1 条留言");
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await expect(page.getByTestId("task-card").filter({ hasText: "配置键统一" }).getByTestId("card-asks")).toHaveCount(0);
  await screenshot(studio.app, "stage-5", "S5-06-board-hints", page);

  // Task page: the latest handoff on top, notes below, and the person can add one.
  await card.click();
  await expect(page.getByTestId("handoff-note")).toContainText("交接：importer.ts 已改");
  await expect(page.getByTestId("task-note")).toHaveText(/重试逻辑已加/);
  await page.getByLabel("记一笔进度").fill("和策划确认过：上限 3 次");
  await page.getByLabel("记一笔进度").press("Enter");
  await expect(page.getByTestId("task-note").first()).toContainText("我");
  await expect(page.getByTestId("task-note").first()).toContainText("和策划确认过：上限 3 次");
  await expect(page.getByTestId("note-count")).toHaveText("3");
  await screenshot(studio.app, "stage-5", "S5-06-progress", page);

  // Answer and dismiss: the board hints go away.
  // Decisions are answered in the shared question popup (since 9f8853c).
  const ask = page.getByTestId("question-popup").getByTestId("question-card");
  await ask.getByRole("radio", { name: /^3/ }).first().click();
  await ask.getByRole("button", { name: "提交", exact: true }).click();
  await page.getByTestId("mail-card").filter({ hasText: "导入完成后告诉我" }).getByRole("button", { name: "忽略" }).click();
  await page.getByRole("button", { name: "返回看板" }).click();
  await expect(card.getByTestId("card-asks")).toHaveCount(0);
});
