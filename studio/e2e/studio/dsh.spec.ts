import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 17: DeepSeek on DSH's own harness. 「Mock DSH」 sessions run the scripted ACP agent standing in for
// `dsh --profile acp`: approvals when a command leaves the sandbox, messages that wait for the turn, no fork and no
// terminal; 设置 → 模型 keeps the clone's place and 「检查」.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a DSH session: approval card, a message waits for the turn, no fork or terminal (stage 17)", async () => {
  studio = await launchStudio({ dsh: true });
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "DSH 推进", workspaceId: ws.id, firstSession: { profileId: "dsh-mock", text: "[[ask: New-Item notes.md]]" } });
  expect(session.runtime).toBe("dsh");
  await page.getByTestId("task-card").filter({ hasText: "DSH 推进" }).click();
  await expect(page.getByTestId("thread-head")).toContainText("Mock DSH");

  const card = page.getByTestId("approval").first();
  await expect(card).toContainText("New-Item notes.md", { timeout: 30_000 });
  await expect(card).toContainText("the person asked for it");
  await screenshot(studio.app, "stage-17", "S17-dsh-approval", page);
  await card.getByRole("button", { name: "批准" }).click();
  await expect(card).toContainText("已批准");
  await expect(page.getByTestId("msg-agent").last()).toContainText("DONE New-Item notes.md", { timeout: 30_000 });

  // DSH has no fork and no terminal of its own.
  await expect(page.getByTestId("session-fork")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "在终端打开" })).toHaveCount(0);

  // A message sent while a turn runs waits for the turn to end.
  const composer = page.getByLabel("输入消息");
  await composer.fill("[[slow]]");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "排队" })).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveAttribute("placeholder", /这一轮结束后发给它/);
  await composer.fill("顺便看看测试");
  await page.getByRole("button", { name: "排队" }).click();
  await expect(page.getByTestId("msg-user").filter({ hasText: "顺便看看测试" })).toBeVisible();
  await screenshot(studio.app, "stage-17", "S17-dsh-queued", page);
  await page.getByRole("button", { name: "打断" }).click();
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("停止后，排队的 1 条消息没有发出")).toBeVisible();
});

test("设置 → 模型: the DSH clone's place, its version and 「检查」 (stage 17)", async () => {
  studio = await launchStudio({ dsh: true });
  const { page } = studio;
  // A stand-in clone: DSH's CLI package and its built entry.
  const clone = studio.workspace("deepseek-harness");
  mkdirSync(join(clone, "apps", "cli", "lib"), { recursive: true });
  writeFileSync(join(clone, "apps", "cli", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.1" }));
  writeFileSync(join(clone, "apps", "cli", "lib", "bin.js"), "");

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.locator('[data-testid="channel-nav"][data-id="dsh-mock"]').click();
  // DSH compacts by itself; its page says so instead of a setting.
  await expect(dialog.getByTestId("auto-compact-dsh")).toContainText("80%");
  const section = dialog.getByTestId("dsh-section");
  await expect(section).toBeVisible();
  // No desktop app here (2026-10-26): it says so, and the clone is used instead.
  await expect(section.getByTestId("dsh-source-auto")).toHaveAttribute("aria-pressed", "true");
  await expect(section.getByTestId("dsh-desktop")).toContainText("没找到 DeepSeek Harness 桌面版");
  await section.getByTestId("dsh-path").fill(clone);
  await section.getByTestId("dsh-save").click();
  await expect(section.getByTestId("dsh-facts")).toContainText("版本 0.2.1-rc.1");
  await expect(section.getByTestId("dsh-facts")).toContainText("已构建");
  await section.getByTestId("dsh-check").click();
  await expect(section.getByTestId("dsh-check-result")).toContainText("可用 · ACP 1 · 2 个型号", { timeout: 30_000 });
  await screenshot(studio.app, "stage-17", "S17-dsh-settings", page);

  // The models DSH offered are the session's choices.
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.profiles.find((p) => p.id === "dsh-mock")?.runtime).toBe("dsh");
  const choices = await studio.api<{ models: Array<{ id: string }> }>("GET", "/api/profiles/dsh-mock/choices");
  expect(choices.models.map((m) => m.id)).toEqual(["deepseek-official/deepseek-v4-flash", "deepseek-official/deepseek-v4-pro"]);
});
