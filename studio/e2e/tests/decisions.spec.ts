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
  const scope = { workspaceId: ws.id };
  const open = () => studio!.api<DecisionRequest[]>("GET", "/api/decisions?state=open");

  // A Codex session asks; the person picks an option on the task page.
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "掉落表拆分",
    scope,
    firstSession: {
      profileId: "codex-mock",
      text: '[[mcp: decision_request {"question":"按关卡拆还是按怪物拆？","options":["按关卡","按怪物","两者都拆：先按关卡拆成 12 张表，再在每张表里按怪物分组，旧的总表保留到下个版本再删"]}]]',
    },
  });
  await expect.poll(async () => (await open()).length, { timeout: 60_000 }).toBe(1);
  await page.getByTestId("task-card").filter({ hasText: "掉落表拆分" }).click();
  // The shared question popup overlays the conversation; the record stays compact and reopens it.
  const card = page.getByTestId("question-popup").getByTestId("question-card");
  await expect(card).toContainText("按关卡拆还是按怪物拆？");
  await expect(page.getByTestId("decision-count")).toHaveCount(0);
  const long = card.getByRole("radio", { name: /两者都拆/ });
  const box = (await long.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(box.height).toBeGreaterThan(30);
  expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  await screenshot(app, "stage-12", "S12-H-decision-in-session", page);
  await card.getByRole("radio", { name: /按关卡/, exact: false }).first().click();
  await card.getByRole("button", { name: "提交", exact: true }).click();
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
  const there = page.getByTestId("question-card");
  await there.getByPlaceholder("写下你的答案，回车继续，Shift+回车换行").fill("保留到下个版本");
  await there.getByRole("button", { name: "提交", exact: true }).click();
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理");
  expect(await open()).toEqual([]);

  // With options, Focus answers in place, like an approval.
  await studio.api("POST", `/api/sessions/${a.session.id}/messages`, { text: '[[mcp: decision_request {"question":"要不要先备份旧表？","options":["要","不要"]}]]' });
  await expect(focus.getByTestId("focus-decision")).toContainText("要不要先备份旧表？", { timeout: 60_000 });
  // That session's turn ends once it has asked, while the workbench shows another task: Focus lists it as 「完成待审核」
  // (2026-10-15). Waited for before answering: the entry coming moves the panel's buttons (Focus grows upwards).
  const replied = focus.getByTestId("focus-entry");
  await expect(replied).toHaveCount(1, { timeout: 60_000 });
  await expect(replied).toContainText("掉落表拆分");
  await expect(replied).toContainText("完成待审核");
  await focus.getByTestId("focus-decision").getByRole("button", { name: "要", exact: true }).click();
  await expect(focus.getByTestId("focus-decision")).toHaveCount(0);
  expect(await open()).toEqual([]);
});

for (const profileId of ["codex-mock", "claude-mock", "dsh-mock"]) {
  test(`${profileId} AMO decisions use the shared popup, retain drafts and return the answer as mail`, async () => {
    studio = await launchStudio({ dsh: profileId === "dsh-mock" });
    const { page, app } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
    const question = "现在允许启动 Editor 完成迁移验证吗？";
    const options = ["允许启动并完成验证", "我来打开之后再继续"];
    const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title: "提问浮层验证", workspaceId: ws.id,
      firstSession: { profileId, text: `[[mcp: decision_request ${JSON.stringify({ question, options })}]]` },
    });
    await page.getByTestId("task-card").filter({ hasText: "提问浮层验证" }).click();
    const popup = page.getByTestId("question-popup");
    const card = popup.getByTestId("question-card");
    await expect(card.getByRole("heading")).toHaveText(question, { timeout: 60_000 });
    await expect(card.getByTestId("question-origin")).toHaveText("跨工具请求 · AMO MCP");
    await expect(card.getByTestId("question-kind")).toHaveAttribute("data-kind", "mail");
    await expect(card.getByTestId("question-kind")).toHaveText("非阻断 · 留言返回");
    await expect(page.getByTestId("thread-decisions").getByTestId("decision-card")).toHaveCount(0);
    const records = page.getByTestId("thread-decisions");
    expect((await records.boundingBox())!.height).toBeLessThan(65);
    const thread = page.getByTestId("thread");
    const threadHeight = (await thread.boundingBox())!.height;
    await expect(page.getByLabel("输入消息")).toBeVisible();
    await card.getByPlaceholder("其他：写下你的答案").fill("只启动 dev 工程，先不要改主工程");
    await card.getByRole("button", { name: "收起问题卡片" }).click();
    expect((await popup.boundingBox())!.height).toBeLessThan(140);
    expect((await thread.boundingBox())!.height).toBe(threadHeight);
    await card.getByRole("button", { name: "展开问题卡片" }).click();
    await card.getByRole("button", { name: "关闭问题卡片" }).click();
    await expect(popup).toHaveCount(0);
    await expect.poll(async () => (await studio!.api<DecisionRequest[]>("GET", "/api/decisions?state=open")).length).toBe(1);
    await records.getByRole("button", { name: "回答", exact: true }).click();
    await expect(card.getByPlaceholder("其他：写下你的答案")).toHaveValue("只启动 dev 工程，先不要改主工程");

    // More than one pending decision: answering one advances to the other, and every answer keeps its own id.
    await expect.poll(async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.status).toBe("idle");
    await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: '[[mcp: decision_request {"question":"生成前要备份吗？","options":["备份","不用"]}]]' });
    await expect(records.getByTestId("decision-record")).toHaveCount(2, { timeout: 60_000 });
    await card.getByRole("button", { name: "提交", exact: true }).click();
    await expect(card.getByRole("heading")).toHaveText("生成前要备份吗？");
    await card.getByRole("radio", { name: /备份/ }).click();
    if (profileId === "codex-mock") await screenshot(app, "stage-18", "S18-decision-popup", page);
    await card.getByRole("button", { name: "提交", exact: true }).click();
    await expect(popup).toHaveCount(0);
    const mail = await studio.api<MailMessage[]>("GET", `/api/mail?sessionId=${session.id}`);
    expect(mail.map((m) => m.text)).toEqual(expect.arrayContaining([
      `针对你的问题「${question}」，我的决定：只启动 dev 工程，先不要改主工程`,
      "针对你的问题「生成前要备份吗？」，我的决定：备份",
    ]));
  });
}
