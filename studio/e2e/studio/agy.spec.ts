import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Gemini on Antigravity (2026-11-24, plans/agy.md): a 测试功能, off by default. Its sessions run a scripted stand-in
// for `agy acp` (testkit fake-agy-agent.ts): 设置 → 模型 → Antigravity (检查, the models besides Gemini), and a session
// with an approval card, no fork and no terminal.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("Gemini (Antigravity): turned on in 测试功能, 设置's page, a session with an approval, no fork or terminal", async () => {
  studio = await launchStudio({ agy: true });
  const { page } = studio;
  const profiles = async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).profiles.map((p) => p.id);
  expect(await profiles()).not.toContain("agy-gemini");

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "测试功能" }).click();
  await dialog.getByTestId("experimental-agy").check();
  await expect.poll(profiles).toContain("agy-gemini");

  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.locator('[data-testid="channel-nav"][data-id="agy-gemini"]').click();
  await expect(dialog.getByTestId("auto-compact-agy")).toBeVisible();
  const section = dialog.getByTestId("agy-section");
  await expect(section.getByTestId("agy-exe")).toContainText("test");
  await section.getByTestId("agy-check").click();
  await expect(section.getByTestId("agy-check-result")).toContainText("可用 · ACP 1", { timeout: 30_000 });
  // Gemini only, until another model is ticked here.
  const claude = section.getByTestId("agy-model-claude-sonnet-4-6").getByRole("checkbox");
  await expect(claude).not.toBeChecked();
  await screenshot(studio.app, "studio", "agy-settings", page);
  await claude.click();
  await expect(claude).toBeChecked();
  await page.keyboard.press("Escape");

  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "Gemini 推进", workspaceId: ws.id, firstSession: { profileId: "agy-gemini", text: "[[ask: dir]]" } });
  expect(session.runtime).toBe("agy");
  await page.getByTestId("task-card").filter({ hasText: "Gemini 推进" }).click();
  await expect(page.getByTestId("thread-head")).toContainText("Gemini");
  const card = page.getByTestId("approval").first();
  await expect(card).toContainText("dir", { timeout: 30_000 });
  await screenshot(studio.app, "studio", "agy-approval", page);
  await card.getByRole("button", { name: "批准" }).click();
  await expect(page.getByTestId("msg-agent").filter({ hasText: "MOCK-AGY: ran dir" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });

  await expect(page.getByTestId("turn-fork")).toHaveCount(0);
  await page.getByTestId("session-more").click();
  await expect(page.getByTestId("session-fork")).toBeDisabled();
  await expect(page.getByTestId("session-terminal")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await screenshot(studio.app, "studio", "agy-session", page);
});
