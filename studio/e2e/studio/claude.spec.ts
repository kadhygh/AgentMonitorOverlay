import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Claude sessions end to end: the real Claude Agent SDK in the Host, routed to the mock Anthropic API, inside the test's
// own data dir (its claude-home is Studio's CLAUDE_CONFIG_DIR). No model budget.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a Claude session: approve a command, queue a message, branch, follow a subagent", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const wsDir = studio.workspace("alpha");
  await studio.api<Workspace>("POST", "/api/workspaces", { path: wsDir });

  // New task on the Claude profile; the first message asks for a command that needs approval.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock Claude" }).click();
  await page.getByLabel("第一句话").fill("[[shell: mkdir e2e-claude-dir]]");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("thread-head")).toContainText("Mock Claude");
  const card = page.getByTestId("approval").first();
  await expect(card).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  await expect(card).toContainText("mkdir e2e-claude-dir");
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  expect(existsSync(join(wsDir, "e2e-claude-dir"))).toBe(false);
  await card.getByRole("button", { name: "批准" }).click();
  await expect(card).toHaveAttribute("data-state", "accepted");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-DONE", { timeout: 60_000 });
  expect(existsSync(join(wsDir, "e2e-claude-dir"))).toBe(true);
  await expect(page.getByTestId("tool").first()).toHaveAttribute("data-status", "completed");
  await screenshot(studio.app, "stage-4", "S4-04-claude-approval", page);

  // While a reply is generating, Claude queues the next message instead of steering.
  const composer = page.getByLabel("输入消息");
  await composer.fill("[[slow]]");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "排队" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".composer-hint")).toHaveText("工具调用后或本轮结束后读到 · Ctrl+Enter 立即发送");
  await composer.fill("after the slow one");
  await page.getByRole("button", { name: "排队" }).click();
  // 立即发送 (2026-11-02): the queued message says it waits, and its button makes the turn give way to it.
  const waiting = page.getByTestId("msg-delivery");
  await expect(waiting).toHaveAttribute("data-delivery", "waiting", { timeout: 10_000 });
  await expect(waiting).toContainText("等待送达");
  await screenshot(studio.app, "send-now", "send-now-01-waiting", page);
  // 问题 #16 (2026-11-03): until the turn gives way the row says it is being interrupted (held here, as a real one can
  // take seconds), and the 立即发送 button is gone.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/send-now", async (route) => (await held, route.continue()));
  await waiting.getByTestId("send-now").click();
  await expect(waiting).toHaveAttribute("data-delivery", "interrupting");
  await expect(waiting).toContainText("正在打断当前这一步");
  await expect(waiting.getByTestId("send-now")).toHaveCount(0);
  await screenshot(studio.app, "send-now", "send-now-01b-interrupting", page);
  release();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: after the slow one", { timeout: 30_000 });
  await expect(page.getByTestId("msg-delivery")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
  // Ctrl+Enter while it works sends at once as well; the slow reply is cut short.
  await composer.fill("[[slow]]");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "排队" })).toBeVisible({ timeout: 30_000 });
  await composer.fill("right now");
  let releaseSend!: () => void;
  const heldSend = new Promise<void>((resolve) => (releaseSend = resolve));
  await page.route("**/api/sessions/*/messages", async (route) => (await heldSend, route.continue()));
  await composer.press("Control+Enter");
  await expect(page.locator(".composer-hint")).toHaveText("正在打断，停下后马上发出…");
  // Released, it passes the next sends straight on (unrouting now would race the held one).
  releaseSend();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: right now", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
  await screenshot(studio.app, "send-now", "send-now-02-after", page);

  // Branch: a new Claude session under this one, which carries the context.
  await page.getByRole("button", { name: "分支", exact: true }).click();
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  await composer.fill("in the branch");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: in the branch", { timeout: 60_000 });
  expect(JSON.stringify(studio.claudeMock!.requests.at(-1)!.body.messages)).toContain("MOCK: after the slow one");

  // A subagent: a summary line in the parent, its own read-only child session.
  await rows.first().click();
  await composer.fill("[[spawn: helper: say hi]]");
  await composer.press("Enter");
  const sub = page.getByTestId("msg-subagent");
  await expect(sub).toContainText("helper", { timeout: 60_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-DONE", { timeout: 60_000 });
  await sub.getByRole("button", { name: "查看" }).click();
  await expect(page.getByTestId("thread-head")).toContainText("helper");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-SUB: helper");
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveAttribute("placeholder", /子 agent 不能单独接收消息/);
  await expect(page.getByRole("button", { name: "分支", exact: true })).toHaveCount(0);
  await screenshot(studio.app, "stage-4", "S4-04-claude-subagent", page);

  // Studio's own Claude config dir holds the transcripts.
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.sessions.filter((s) => s.runtime === "claude").map((s) => s.kind).sort()).toEqual(["fork", "main", "sub"]);
  expect(existsSync(join(studio.dataDir, "claude-home", "projects"))).toBe(true);
});

test("hands a Claude session to a terminal and takes it back", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "交接", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "hello" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 60_000 });

  // Test mode records the launch instead of opening a window (red line 7).
  // 在终端打开 is under ⋯ (2026-11-03, 问题 #15).
  await page.getByTestId("session-more").click();
  await page.getByTestId("session-terminal").click();
  const banner = page.getByTestId("handoff-banner");
  await expect(banner).toContainText("工作台暂时只读");
  await expect(page.getByTestId("writer")).toHaveText("已交给终端 · 只读");
  await expect(page.getByLabel("输入消息")).toBeDisabled();
  await page.getByTestId("session-more").click();
  await expect(page.getByTestId("session-menu")).toBeVisible();
  await expect(page.getByTestId("session-terminal")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await screenshot(studio.app, "stage-4", "S4-05-handoff", page);

  await banner.getByRole("button", { name: "立即收回" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByLabel("输入消息")).toBeEnabled();
  await expect(page.getByText("已从终端收回。")).toBeVisible();
  await page.getByLabel("输入消息").fill("after reclaim");
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: after reclaim", { timeout: 60_000 });
});

// 2026-11-08 (the user: 停止 → 将留言转进 → 重发 → 留言的「立即发送」打断了自己重发的那一轮): a mail forwarded into a
// session the person stopped is held; their next message ends the pause and it goes in right behind it — the row says so
// and has no 立即发送.
test("a mail forwarded after 停止 goes in behind the person's next message, without 立即发送", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ session: { id: string } }>("POST", "/api/tasks", { title: "停下后留言", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "[[slow]]" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByRole("button", { name: "排队" })).toBeVisible({ timeout: 60_000 });
  await studio.api("POST", `/api/sessions/${session.id}/interrupt`, {});
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });

  const mail = await studio.api<{ id: string }>("POST", "/api/mail", { to: { kind: "session", sessionId: session.id }, text: "kill 那边合完了" });
  await studio.api("POST", `/api/mail/${mail.id}/forward`, {});
  const line = page.getByTestId("msg-delivery");
  await expect(line).toHaveAttribute("data-delivery", "held");
  await expect(page.getByText("排在它后面一起送进去")).toBeVisible();

  const composer = page.getByLabel("输入消息");
  await composer.fill("[[slow]]");
  await composer.press("Enter");
  await expect(line).toHaveAttribute("data-delivery", "behind-person", { timeout: 10_000 });
  await expect(line).toContainText("已随你刚发的消息一起送进去");
  await expect(line.getByTestId("send-now")).toHaveCount(0);
  await screenshot(studio.app, "studio", "inbox-behind-person", page);
  await expect(page.getByTestId("msg-agent").last()).toContainText("kill 那边合完了", { timeout: 60_000 });
  await expect(page.getByTestId("msg-delivery")).toHaveCount(0);
});
