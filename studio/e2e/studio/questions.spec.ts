import { expect, test } from "@playwright/test";
import type { StateSnapshot, Workspace } from "@amo-studio/protocol";
import { selectAndRelease } from "../support/selection.js";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

// Stage 12, S12-B: Claude's questions (AskUserQuestion) open as a popup over the conversation and the answers reach the model;
// a plan written in 只做计划 is reviewed in its own window (2026-11-09: annotations and the window's own box go back
// with 要修改, 批准并开始 leaves plan mode). Real Claude Agent SDK against the mock Anthropic API; no model budget.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTask(s: Studio, firstSession: Record<string, unknown>) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  await s.api("POST", "/api/tasks", { title: "导入器重试", workspaceId: ws.id, firstSession: { profileId: "claude-mock", ...firstSession } });
  await s.page.getByTestId("task-card").first().click();
}

test("answers Claude's questions in a popup over the conversation", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  await openTask(studio, { text: "[[ask]] 给导入器加上重试" });

  const card = page.getByTestId("question-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("question-kind")).toHaveAttribute("data-kind", "blocking");
  await expect(card.getByTestId("question-kind")).toHaveText("阻断式 · 等待回答");
  // A popup: over the conversation, which keeps its size; the composer stays in place.
  const popup = page.getByTestId("question-popup");
  const thread = page.getByTestId("thread");
  expect((await popup.boundingBox())!.height).toBeGreaterThanOrEqual((await thread.boundingBox())!.height - 1);
  await expect(page.getByLabel("输入消息")).toBeVisible();
  await expect(card.locator(".qc-eyebrow")).toHaveText("Claude 在问你 · 重试策略");
  await expect(card.getByRole("heading")).toHaveText("导入失败时要怎么重试？");
  await expect(card.getByRole("radio")).toHaveCount(3);
  await expect(card.getByRole("radio").first()).toContainText("每次等待时间翻倍，最多 3 次");
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await expect(page.getByTestId("run-status")).toContainText("等你回答");
  await screenshot(app, "stage-12", "S12-B-question-card", page);

  // A single choice moves on to the next question; the second one is multi-select with "其他".
  await card.getByRole("radio", { name: /固定间隔/ }).click();
  await expect(card.getByRole("heading")).toHaveText("重试时要记录哪些信息？");
  await expect(card.locator(".qc-progress")).toHaveText("2 / 2");
  await card.getByRole("checkbox", { name: /失败原因/ }).click();
  await card.getByRole("checkbox", { name: /等待时长/ }).click();
  await card.getByPlaceholder("其他：写下你的答案").fill("请求的 URL");
  await screenshot(app, "stage-12", "S12-B-question-multi", page);

  // Folded: a strip at the bottom, the conversation readable again; unfolded it is the popup again.
  await card.getByRole("button", { name: "收起问题卡片" }).click();
  expect((await popup.boundingBox())!.height).toBeLessThan(120);
  await screenshot(app, "stage-12", "S12-K-question-folded", page);
  await card.getByRole("button", { name: "展开问题卡片" }).click();
  await expect(card.locator(".qc-progress")).toHaveText("2 / 2");

  // Closing only hides the card: the conversation offers it again, drafts intact.
  await card.getByRole("button", { name: "关闭问题卡片" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByLabel("输入消息")).toBeVisible();
  const record = page.getByTestId("question-record");
  await expect(record).toHaveAttribute("data-state", "pending");
  await record.getByRole("button", { name: "回答" }).click();
  await expect(card.locator(".qc-progress")).toHaveText("2 / 2");
  await expect(card.getByRole("checkbox", { name: /失败原因/ })).toHaveAttribute("aria-checked", "true");

  await card.getByRole("button", { name: "提交" }).click();
  await expect(card).toHaveCount(0);
  const reply = page.getByTestId("msg-agent").last();
  await expect(reply).toContainText("MOCK-ANSWERED", { timeout: 60_000 });
  await expect(reply).toContainText('"导入失败时要怎么重试？"="固定间隔"');
  await expect(reply).toContainText('"重试时要记录哪些信息？"="失败原因, 等待时长, 请求的 URL"');
  await expect(record).toHaveAttribute("data-state", "answered");
  await expect(record).toContainText("固定间隔 · 失败原因、等待时长、请求的 URL");
  await record.getByRole("button", { name: /已回答/ }).click();
  await expect(record.locator("dd")).toHaveText(["固定间隔", "失败原因、等待时长、请求的 URL"]);
  await expect(page.getByTestId("needs-you")).toHaveCount(0);
  await screenshot(app, "stage-12", "S12-B-question-answered", page);

  // Closing without answering tells Claude so, and it carries on.
  const composer = page.getByLabel("输入消息");
  await composer.fill("[[ask]] 再问一次");
  await composer.press("Enter");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // Keys: a digit picks that option (and moves on), Escape closes the card.
  await page.keyboard.press("2");
  await expect(card.getByRole("heading")).toHaveText("重试时要记录哪些信息？");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await page.getByTestId("question-record").last().getByRole("button", { name: "回答" }).click();
  await card.getByRole("button", { name: "不回答" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("without answering", { timeout: 60_000 });
  await expect(page.getByTestId("question-record").last()).toHaveAttribute("data-state", "dismissed");
});

test("reviews a plan in its own window: annotate and write, kept across closing, 要修改, then approve and leave plan mode", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  await openTask(studio, { text: "[[plan]] 先出一个计划", options: { permission: "plan" } });

  // In the conversation: one row with 查看计划, not the plan itself; above the composer: 打开计划 and 批准并开始.
  const plan = page.getByTestId("plan-card").first();
  await expect(plan).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  await expect(plan).toContainText("Claude 的计划：给导入器加上失败重试");
  await expect(plan.locator(".md-h1")).toHaveCount(0);
  const bar = page.getByTestId("plan-review-bar");
  await expect(bar).toContainText("计划待审：给导入器加上失败重试");
  await expect(bar.getByRole("button")).toHaveText(["打开计划", "批准并开始"]);
  await expect(page.getByTestId("switch-permission")).toContainText("只做计划");
  await expect(page.getByTestId("run-status")).toContainText("等你回答");
  await expect(page.getByLabel("输入消息")).toHaveAttribute("placeholder", /打开计划/);
  await screenshot(app, "stage-12", "S12-B-plan-review", page);

  // The window: the plan, annotated where it is selected; what to change in its own box.
  const opened = app.waitForEvent("window");
  await plan.getByTestId("plan-card-open").click();
  const win = await opened;
  const doc = win.getByTestId("plan-window-doc");
  await expect(doc.locator(".md-h1")).toHaveText("给导入器加上失败重试");
  await expect(win.getByTestId("plan-window-state")).toHaveText("待你审阅");
  expect(await windowState(app, "plan")).toMatchObject({ onScreen: false, anyFocused: false });
  await selectAndRelease(doc, "指数退避");
  await win.getByTestId("selection-bar").getByRole("button", { name: "批注" }).click();
  const bubble = win.getByTestId("annotation-bubble");
  await bubble.getByLabel("批注内容").fill("退避上限 30 秒");
  await bubble.getByRole("button", { name: "保存" }).click();
  await expect(win.getByTestId("plan-window-notes")).toContainText("退避上限 30 秒");
  await win.getByTestId("plan-window-input").fill("测试也要覆盖超时");
  await expect(win.getByTestId("plan-window-revise")).toHaveText("要修改（1 条批注）");
  await screenshot(app, "stage-12", "S12-B-plan-window", win, "plan");
  // The plan's annotation is the window's: the task page's 批注 panel does not count it.
  await expect(page.getByTestId("annotation-count")).toHaveText("0");

  // Closed and opened again (from the bar this time): what was written and annotated is still there.
  await win.close();
  const reopened = app.waitForEvent("window");
  await bar.getByTestId("plan-bar-open").click();
  const win2 = await reopened;
  await expect(win2.getByTestId("plan-window-input")).toHaveValue("测试也要覆盖超时");
  await expect(win2.getByTestId("plan-window-notes")).toContainText("退避上限 30 秒");

  // 要修改: the text and the annotation go back to Claude together.
  await win2.getByTestId("plan-window-revise").click();
  const reply = page.getByTestId("msg-agent").last();
  await expect(reply).toContainText("MOCK-PLAN", { timeout: 60_000 });
  await expect(reply).toContainText("测试也要覆盖超时");
  await expect(reply).toContainText("退避上限 30 秒");
  await expect(plan).toHaveAttribute("data-revised", "");
  await expect(plan).toContainText("已要求修改");
  await expect(plan).toContainText("带 1 条批注");
  await expect(win2.getByTestId("plan-window-feedback")).toContainText("退避上限 30 秒");
  await expect(bar).toHaveCount(0);

  // The revised plan: the open window moves to it (第 2 版), with an empty box; approved there.
  const composer = page.getByLabel("输入消息");
  await composer.fill("[[plan]] 改好了");
  await composer.press("Enter");
  const second = page.getByTestId("plan-card").nth(1);
  await expect(second).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  await expect(win2.getByTestId("plan-window-state")).toHaveText("待你审阅");
  await expect(win2.getByTestId("plan-version")).toContainText("第 2 版（待审）");
  await expect(win2.getByTestId("plan-window-doc")).toContainText("补充单元测试：成功、重试后成功、全部失败");
  await expect(win2.getByTestId("plan-window-input")).toHaveValue("");
  await win2.getByTestId("plan-window-approve").click();
  await expect(second).toHaveAttribute("data-state", "answered");
  await expect(second).toContainText("已批准");
  await expect(win2.getByTestId("plan-window-state")).toHaveText("已批准");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-PLAN", { timeout: 60_000 });
  await expect(page.getByTestId("switch-permission")).toContainText("每次询问");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.sessions.find((s) => s.runtime === "claude")!.options.permission).toBe("default");
  // Scroll the thread (it follows the bottom until the person scrolls) so the approved plan's row shows.
  const approved = page.getByTestId("thread").getByTestId("plan-card").filter({ hasText: "已批准" }).last();
  await expect(approved).toBeVisible();
  // When the turn finishes the row is drawn once more, so the scroll may meet the old one: try again.
  await expect(async () => approved.evaluate((el) => el.scrollIntoView({ block: "center" }))).toPass();
  await page.waitForTimeout(100);
  await screenshot(app, "stage-12", "S12-B-plan-approved", page);
});
