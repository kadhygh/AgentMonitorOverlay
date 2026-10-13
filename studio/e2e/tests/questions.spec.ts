import { expect, test } from "@playwright/test";
import type { StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Stage 12, S12-B: Claude's questions (AskUserQuestion) take the composer's seat and the answers reach the model;
// a plan written in 只做计划 is reviewed in the conversation (要修改 sends the composer's text back, 批准并开始 leaves
// plan mode). Real Claude Agent SDK against the mock Anthropic API; no model budget.

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

test("answers Claude's questions in the composer seat", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  await openTask(studio, { text: "[[ask]] 给导入器加上重试" });

  const card = page.getByTestId("question-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("输入消息")).toHaveCount(0);
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

test("reviews a plan: changes from the composer, then approve and leave plan mode", async () => {
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  await openTask(studio, { text: "[[plan]] 先出一个计划", options: { permission: "plan" } });

  const plan = page.getByTestId("plan-card").first();
  await expect(plan).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  await expect(plan.locator(".md-h1")).toHaveText("给导入器加上失败重试");
  await expect(plan.getByRole("button", { name: "展开全部计划" })).toBeVisible();
  const bar = page.getByTestId("plan-review-bar");
  await expect(bar).toContainText("计划待审：给导入器加上失败重试");
  await expect(page.getByTestId("switch-permission")).toContainText("只做计划");
  await expect(page.getByTestId("run-status")).toContainText("等你回答");
  await screenshot(app, "stage-12", "S12-B-plan-review", page);

  // 要修改 with an empty composer: the composer collects the feedback and sends it back.
  await bar.getByRole("button", { name: "要修改" }).click();
  const composer = page.getByLabel("输入消息");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute("placeholder", /写下要修改的地方/);
  await composer.fill("测试也要覆盖超时");
  await screenshot(app, "stage-12", "S12-B-plan-revise", page);
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-PLAN", { timeout: 60_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("测试也要覆盖超时");
  await expect(plan).toHaveAttribute("data-revised", "");
  await expect(plan).toContainText("已要求修改");
  await expect(bar).toHaveCount(0);

  // The revised plan, approved: the session leaves 只做计划 for 每次询问.
  await composer.fill("[[plan]] 改好了");
  await composer.press("Enter");
  const second = page.getByTestId("plan-card").nth(1);
  await expect(second).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  await second.getByRole("button", { name: "展开全部计划" }).click();
  await expect(second).toContainText("补充单元测试：成功、重试后成功、全部失败");
  await bar.getByRole("button", { name: "批准并开始" }).click();
  await expect(second).toHaveAttribute("data-state", "answered");
  await expect(second).toContainText("已批准");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-PLAN", { timeout: 60_000 });
  await expect(page.getByTestId("switch-permission")).toContainText("每次询问");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.sessions.find((s) => s.runtime === "claude")!.options.permission).toBe("default");
  // Scroll the thread (it follows the bottom until the person scrolls) so the approved plan shows.
  await second.evaluate((el) => {
    const thread = el.closest<HTMLElement>('[data-testid="thread"]')!;
    thread.scrollTop += el.getBoundingClientRect().top - thread.getBoundingClientRect().top - 120;
  });
  await page.waitForTimeout(100);
  await screenshot(app, "stage-12", "S12-B-plan-approved", page);
});
