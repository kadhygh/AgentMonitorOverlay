import { expect, test } from "@playwright/test";
import type { ModelChannel, ModelProfile, Session, StateSnapshot, StudioSettings, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 设置 → 模型 → 渠道 (2026-10-15): the person's own third-party Codex and Claude endpoints, run against the mocks; the
// balance through CC Switch's 通用 template; 「隐藏」 takes a channel out of the pickers.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a third-party Codex channel: added in 设置 with its balance, runs a session, hidden from the pickers", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await expect(dialog.getByTestId("channel-card")).not.toHaveCount(0);

  await dialog.getByTestId("channel-add").click();
  const form = page.getByTestId("channel-dialog");
  await form.getByTestId("channel-kind-codex").click();
  await form.getByTestId("channel-label").fill("中转 GPT");
  await form.getByTestId("channel-url").fill(studio.mock!.baseUrl);
  await form.getByTestId("channel-key").fill("mock-channel-key");
  await form.getByTestId("channel-model").fill("mock-model");
  await form.getByTestId("balance-general").click();
  await form.getByTestId("balance-test").click();
  await expect(form.getByTestId("balance-test-result")).toHaveText("余额 $12.50");
  await screenshot(app, "stage-14", "S14-H-channel-dialog", page);
  await form.getByTestId("channel-save").click();
  await expect(form).toHaveCount(0);

  const card = dialog.locator('[data-testid="channel-card"]').filter({ hasText: "中转 GPT" });
  await expect(card).toContainText("Key 已保存");
  await expect(card.getByTestId("channel-balance")).toHaveText("余额 $12.50");
  await screenshot(app, "stage-14", "S14-H-channels", page);

  const [channel] = await studio.api<ModelChannel[]>("GET", "/api/channels");
  expect(channel).toMatchObject({ kind: "codex", label: "中转 GPT", model: "mock-model", keySaved: true, balance: { template: "general" } });
  // The key never comes back from the Host.
  expect(JSON.stringify(channel)).not.toContain("mock-channel-key");

  // It runs a session like any other model.
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "走中转", workspaceId: ws.id, firstSession: { profileId: channel!.id, text: "hello relay" } });
  expect(session.profileId).toBe(channel!.id);
  await page.keyboard.press("Escape");
  await page.getByTestId("task-card").filter({ hasText: "走中转" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello relay", { timeout: 60_000 });
  await expect(page.getByTestId("thread-head")).toContainText("中转 GPT");

  // Hidden: gone from the new-task tiles and the drawer, still the label of its session.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "模型" }).click();
  await card.getByTestId("channel-hidden").check();
  await expect(card).toHaveClass(/hidden/);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.profiles.find((p: ModelProfile) => p.id === channel!.id)!.hidden).toBe(true);
  // A channel a session uses cannot be deleted.
  await card.getByTestId("channel-remove").click();
  await card.getByTestId("channel-remove-confirm").click();
  await expect(dialog.getByTestId("credential-message")).toContainText("有 1 个会话用这个渠道");
  await page.keyboard.press("Escape");

  await page.getByTestId("back").click();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await expect(page.getByRole("group", { name: "模型" })).not.toContainText("中转 GPT");
  await page.getByTestId("all-models").click();
  await expect(page.getByTestId("model-drawer")).not.toContainText("中转 GPT");
});

test("a third-party Claude channel runs Claude Code against its address; the last visible channel cannot be hidden", async () => {
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  const channel = await studio.api<ModelChannel>("POST", "/api/channels", { kind: "claude", label: "中转 Claude", baseUrl: studio.claudeMock!.baseUrl, model: "mock-claude", key: "mock-key" });
  expect(channel).toMatchObject({ kind: "claude", claudeAuth: "bearer", keySaved: true });
  await studio.api("POST", "/api/tasks", { title: "走 Claude 中转", workspaceId: ws.id, firstSession: { profileId: channel.id, text: "hello claude relay" } });
  await studio.page.getByTestId("task-card").filter({ hasText: "走 Claude 中转" }).click();
  await expect(studio.page.getByTestId("msg-agent").last()).toContainText("MOCK: hello claude relay", { timeout: 60_000 });

  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const others = state.profiles.filter((p) => p.id !== channel.id);
  for (const p of others) await studio.api("PUT", `/api/profiles/${p.id}/hidden`, { hidden: true });
  await expect(studio.api("PUT", `/api/profiles/${channel.id}/hidden`, { hidden: true })).rejects.toThrow(/至少要留一个/);
});

test("设置 → 额度: which accounts show at the bottom of the left column and in Focus", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const channel = await studio.api<ModelChannel>("POST", "/api/channels", { kind: "codex", label: "中转 GPT", baseUrl: studio.mock!.baseUrl, key: "mock-channel-key", balance: { template: "general" } });
  const footer = page.locator(".usage-toggle");
  await expect(footer).toContainText("中转 GPT $12.50");

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "额度" }).click();
  const row = dialog.locator(`[data-testid="quota-row"][data-id="${channel.id}"]`);
  await expect(row).toContainText("余额 · 余额 $12.50");
  await expect(row.getByTestId("quota-footer")).toBeChecked();
  await expect(row.getByTestId("quota-focus")).not.toBeChecked();
  await row.getByTestId("quota-focus").click();
  await expect(row.getByTestId("quota-focus")).toBeChecked();
  await row.getByTestId("quota-footer").click();
  await expect(row.getByTestId("quota-footer")).not.toBeChecked();
  await screenshot(app, "stage-14", "S14-H-quota", page);
  const settings = await studio.api<StudioSettings>("GET", "/api/settings");
  expect(settings.quotaDisplay[channel.id]).toEqual({ footer: false, focus: true });
  await page.keyboard.press("Escape");
  await expect(footer).not.toContainText("中转 GPT");
});
