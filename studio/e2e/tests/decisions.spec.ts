import { expect, test } from "@playwright/test";
import type { DecisionRequest, MailMessage, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Decision requests: agents ask through the AMO MCP; the person answers on the task page or in the Focus window; the
// answer goes back to the asking session as mail.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("agents ask for decisions; the person answers on the task page and in Focus", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const scope = { kind: "workspace", workspaceId: ws.id };
  const open = () => studio!.api<DecisionRequest[]>("GET", "/api/decisions?state=open");

  // A Codex session asks; the person picks an option on the task page.
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "掉落表拆分",
    scope,
    firstSession: { profileId: "codex-mock", text: '[[mcp: decision_request {"question":"按关卡拆还是按怪物拆？","options":["按关卡","按怪物"]}]]' },
  });
  await expect.poll(async () => (await open()).length, { timeout: 60_000 }).toBe(1);
  await page.getByTestId("task-card").filter({ hasText: "掉落表拆分" }).click();
  const card = page.getByTestId("decision-card");
  await expect(card).toContainText("按关卡拆还是按怪物拆？");
  await expect(page.getByTestId("decision-count")).toHaveText("1");
  await screenshot(app, "stage-5", "S5-04-decision", page);
  await card.getByRole("button", { name: "按关卡" }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await studio!.api<MailMessage[]>("GET", `/api/mail?sessionId=${a.session.id}`)).map((m) => m.text)).toEqual([
    "针对你的问题「按关卡拆还是按怪物拆？」，我的决定：按关卡",
  ]);
  await expect(page.getByTestId("mail-card")).toContainText("来自 我");

  // A Claude session asks without options. Focus cannot take keyboard focus, so it sends the person to the workbench.
  await studio.api("POST", "/api/tasks", {
    title: "配置键统一",
    scope,
    firstSession: { profileId: "claude-mock", text: '[[mcp: decision_request {"question":"旧键名保留多久？"}]]' },
  });
  await expect.poll(async () => (await open()).length, { timeout: 60_000 }).toBe(1);
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1");
  const ask = focus.getByTestId("focus-decision");
  await expect(ask).toContainText("旧键名保留多久？");
  await screenshot(app, "stage-5", "S5-04-focus-decision", focus, "focus");
  await expect(ask.getByLabel("决定")).toHaveCount(0);
  await ask.getByRole("button", { name: "在工作台回答" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("配置键统一");
  const there = page.getByTestId("decision-card");
  await there.getByLabel("决定").fill("保留到下个版本");
  await there.getByRole("button", { name: "回答" }).click();
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理");
  expect(await open()).toEqual([]);

  // With options, Focus answers in place, like an approval.
  await studio.api("POST", `/api/sessions/${a.session.id}/messages`, { text: '[[mcp: decision_request {"question":"要不要先备份旧表？","options":["要","不要"]}]]' });
  await expect(focus.getByTestId("focus-decision")).toContainText("要不要先备份旧表？", { timeout: 60_000 });
  await focus.getByTestId("focus-decision").getByRole("button", { name: "要", exact: true }).click();
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理");
});
