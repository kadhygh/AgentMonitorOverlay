import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// After stage 12: Codex's request_user_input_async (the model asks and carries on) shows as a question card whose
// answer goes out as the next message (real codex-cli against the mock model); and a Host that dies is started again
// by the shell, the windows reconnect and say so, the work goes on.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("Codex's async question: a card in the composer seat, answered as the next message", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "选季节", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[ask-async]] 测一下提问" } });
  await page.getByTestId("task-card").first().click();

  // The turn goes on after asking (the tool answers at once), then the person is up.
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-ASKED", { timeout: 60_000 });
  const card = page.getByTestId("question-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("question-kind")).toHaveAttribute("data-kind", "message");
  await expect(card.getByTestId("question-kind")).toHaveText("非阻断 · 下一条消息返回");
  await expect(card.locator(".qc-eyebrow")).toHaveText("Codex 在问你 · 回答会作为你的下一条消息");
  await expect(card.getByRole("heading")).toHaveText("你最喜欢哪个季节？");
  await expect(card.getByRole("radio")).toHaveCount(3);
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await screenshot(app, "stage-12", "S12-G-async-question", page);

  await card.getByRole("radio", { name: /夏天/ }).click();
  await card.getByRole("button", { name: "提交" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("msg-user").last()).toContainText("「你最喜欢哪个季节？」：夏天");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 「你最喜欢哪个季节？」：夏天", { timeout: 60_000 });
  const record = page.getByTestId("question-record").first();
  await expect(record).toHaveAttribute("data-state", "answered");
  await expect(page.getByTestId("needs-you")).toHaveCount(0);
});

test("a Host that dies is started again; the window reconnects, says so and keeps working", async () => {
  studio = await launchStudio({ env: { AMO_STUDIO_KEEPALIVE_MS: "400" } });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "崩溃之前", workspaceId: ws.id });
  await expect(page.getByTestId("task-card")).toHaveCount(1);

  const before = (JSON.parse(readFileSync(join(studio.dataDir, "host.json"), "utf8")) as { pid: number }).pid;
  process.kill(before);

  const toast = page.getByTestId("host-error");
  await expect(toast).toContainText("Host 意外退出，已自动重新启动", { timeout: 30_000 });
  const after = (JSON.parse(readFileSync(join(studio.dataDir, "host.json"), "utf8")) as { pid: number }).pid;
  expect(after).not.toBe(before);
  // Same address and token: the API and the window's live updates work again.
  await studio.api<Task>("POST", "/api/tasks", { title: "崩溃之后", workspaceId: ws.id });
  await expect(page.getByTestId("task-card")).toHaveCount(2, { timeout: 15_000 });
  await screenshot(app, "stage-12", "S12-G-host-restarted", page);
});
