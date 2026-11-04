import { expect, test, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Chat panel against the real Codex app-server and the mock model: approvals, steer, interrupt, subagents.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTask(s: Studio, text: string) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "对话面板",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text },
  });
  await s.page.getByTestId("task-card").first().click();
  await expect(s.page.getByTestId("task-title")).toHaveText("对话面板");
  return created;
}

const composer = (page: Page) => page.getByLabel("输入消息");
const lastAgent = (page: Page) => page.getByTestId("msg-agent").last();

test("approves and declines commands from the approval card", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "[[shell: cmd /c echo e2e-approved]]");

  const card = page.getByTestId("approval").first();
  await expect(card).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await expect(card).toContainText("cmd /c echo e2e-approved");
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await card.getByRole("button", { name: "批准" }).click();
  await expect(card).toHaveAttribute("data-state", "accepted");
  await expect(card).toContainText("已批准");
  await expect(lastAgent(page)).toContainText("MOCK-DONE", { timeout: 30_000 });
  const tool = page.getByTestId("tool").first();
  await expect(tool).toHaveAttribute("data-status", "completed");
  await tool.getByRole("button").click();
  await expect(tool).toContainText("e2e-approved");
  await expect(page.getByTestId("needs-you")).toHaveCount(0);

  await composer(page).fill("[[shell: cmd /c echo e2e-declined]]");
  await composer(page).press("Enter");
  const second = page.getByTestId("approval").nth(1);
  await expect(second).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await second.getByRole("button", { name: "拒绝" }).click();
  await expect(second).toContainText("已拒绝");
  await expect(page.getByTestId("tool").nth(1)).toHaveAttribute("data-status", "declined", { timeout: 30_000 });
  await screenshot(studio.app, "stage-1", "S1-11c-approval", page);
});

test("steers a running reply and interrupts another", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "[[slow]]");

  // While generating, the send button becomes 插话 and 打断 appears.
  await expect(page.getByRole("button", { name: "插话" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "打断" })).toBeVisible();
  await composer(page).fill("补充一句");
  await page.getByRole("button", { name: "插话" }).click();
  // Codex delivers steered input at the next sampling boundary, i.e. after the current (slow) model response.
  await expect(page.getByTestId("msg-user").filter({ hasText: "补充一句" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await expect(lastAgent(page)).toContainText("MOCK: 补充一句");

  await composer(page).fill("[[slow]]");
  await composer(page).press("Enter");
  await expect(page.getByRole("button", { name: "打断" })).toBeVisible({ timeout: 30_000 });
  await expect(lastAgent(page)).toContainText("slow");
  // 问题 #16 (2026-11-03): until the turn has stopped (held here, as a real one can take seconds) the button greys and
  // the composer says it is stopping.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/interrupt", async (route) => (await held, route.continue()));
  await page.getByRole("button", { name: "打断" }).click();
  await expect(page.getByRole("button", { name: "正在停止" })).toBeDisabled();
  await expect(page.locator(".composer-hint")).toContainText("正在停止…");
  await screenshot(studio.app, "stage-1", "S1-12-stopping", page);
  release();
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "打断" })).toHaveCount(0);
  // A reply had come back: the message stays sent.
  await expect(composer(page)).toHaveValue("");

  // 停止 before anything came back (2026-10-28): the message goes back into the composer to be reworded.
  await composer(page).fill("改一下掉落表 [[wait]]");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "打断" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "打断" }).click();
  await expect(composer(page)).toHaveValue("改一下掉落表 [[wait]]");
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
});

test("a message the Host does not answer: 正在发送… after a few seconds, its text back in the composer after 30", async () => {
  test.setTimeout(120_000);
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "你好");
  await expect(lastAgent(page)).toContainText("MOCK: 你好", { timeout: 60_000 });
  // 2026-11-05: one sent right after 停止 never came back — no row, no error, the composer already empty.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/sessions/*/messages", async (route) => (await held, route.continue()));
  await composer(page).fill("这条卡住了");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
  await expect(page.locator(".composer-hint")).toHaveText("正在发送…", { timeout: 10_000 });
  await screenshot(studio.app, "studio", "send-slow", page);
  await expect(composer(page)).toHaveValue("这条卡住了", { timeout: 40_000 });
  await expect(page.getByText(/Host 还没回应：文字放回了输入框/)).toBeVisible();
  await expect(page.locator(".composer-hint")).not.toContainText("正在发送");
  await screenshot(studio.app, "studio", "send-given-up", page);
  // It went in after all: the row shows, and the composer keeps the text (the person decides).
  release();
  await expect(page.getByTestId("msg-user").filter({ hasText: "这条卡住了" })).toBeVisible({ timeout: 30_000 });
  await expect(composer(page)).toHaveValue("这条卡住了");
});

test("shows a subagent under its parent and jumps to it", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "[[spawn: explorer: list call sites]]");

  const sub = page.getByTestId("msg-subagent");
  await expect(sub).toContainText("/root/explorer", { timeout: 30_000 });
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-kind", "sub");
  await expect(rows.nth(1)).toHaveAttribute("data-depth", "1");
  await expect(rows.nth(1)).toContainText("explorer");
  await screenshot(studio.app, "stage-1", "S1-11c-subagent", page);

  await sub.getByRole("button", { name: "查看" }).click();
  await expect(page.getByTestId("thread-head")).toContainText("explorer");
  await expect(lastAgent(page)).toContainText("MOCK-SUB: /root/explorer");
});
