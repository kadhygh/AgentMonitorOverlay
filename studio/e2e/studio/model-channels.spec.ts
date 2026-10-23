import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { ModelChannel, ModelProfile, Session, StateSnapshot, StudioSettings, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 设置 → 模型 → 渠道 (2026-10-15): the person's own third-party Codex and Claude endpoints, run against the mocks; the
// balance through CC Switch's 通用 template; 「隐藏」 takes a channel out of the pickers. S18 (2026-10-18): the page is a
// list of channels (支持的渠道 / 第三方, added as a Codex or a Claude scheme) beside the chosen one's page.

let studio: Studio | undefined;

/** A test's own little HTTP server (a relay's model listing), closed after it. */
let server: Server | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
  server?.close();
  server = undefined;
});

test("a third-party Codex channel: added in 设置 with its balance, runs a session, hidden from the pickers", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await expect(dialog.getByTestId("channel-nav")).not.toHaveCount(0);

  await dialog.getByTestId("channel-add-codex").click();
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

  // The new channel's page opens, and it is listed under 第三方 as a Codex one.
  const card = dialog.getByTestId("channel-page");
  await expect(card.getByTestId("channel-title")).toHaveText("中转 GPT");
  await expect(card).toContainText("Key 已保存");
  await expect(card).toContainText("Codex 方案");
  await expect(card.getByTestId("channel-balance")).toHaveText("余额 $12.50");
  const [channel] = await studio.api<ModelChannel[]>("GET", "/api/channels");
  const nav = dialog.locator(`[data-testid="channel-nav"][data-id="${channel!.id}"]`);
  await expect(nav).toHaveAttribute("aria-current", "page");
  await expect(nav).toContainText("Codex 方案");
  await screenshot(app, "stage-18", "S18-models-third-party", page);

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
  await nav.click();
  await card.getByTestId("channel-hidden").check();
  await expect(nav).toHaveClass(/hidden/);
  await expect(nav).toContainText("已隐藏");
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

test("设置 → 模型 → 快速选择: the automatic row, dragged into the person's own order (2026-10-18)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  // Recent picks naming Mock Claude's default model by id and by "default": one model, so one row.
  await page.evaluate(() => localStorage.setItem("amo.recentModels", JSON.stringify([{ profileId: "claude-mock", model: "mock-claude" }, { profileId: "claude-mock", model: null }])));
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.getByTestId("models-nav-quick").click();
  const section = dialog.getByRole("region", { name: "快速选择" });
  const rows = section.getByTestId("quick-row");
  const names = () => rows.locator(".channel-sub");
  await expect(section.getByTestId("quick-auto")).toBeVisible();
  await expect(names()).toHaveText(["Mock Claude", "Mock 模型", "Claude"]);
  const quick = async () => (await studio!.api<StudioSettings>("GET", "/api/settings")).quickModels;
  expect(await quick()).toEqual([]);

  // A drag keeps the row as the person's own.
  await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 20, y: 2 } });
  await expect(names()).toHaveText(["Claude", "Mock Claude", "Mock 模型"]);
  await expect(section.getByTestId("quick-auto")).toHaveCount(0);
  await expect.poll(quick).toEqual([{ profileId: "claude-subscription", model: null }, { profileId: "claude-mock", model: null }, { profileId: "codex-mock", model: null }]);
  // The keyboard way, a removal, an addition.
  await rows.nth(0).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(names()).toHaveText(["Mock Claude", "Claude", "Mock 模型"]);
  await rows.nth(2).getByTestId("quick-remove").click();
  await expect(rows).toHaveCount(2);
  await section.getByTestId("quick-profile").selectOption({ label: "Mock Claude" });
  await expect(section.getByTestId("quick-model").locator("option")).toHaveCount(2);
  await section.getByTestId("quick-model").selectOption("mock-claude-b");
  await section.getByTestId("quick-add").click();
  await expect(rows).toHaveCount(3);
  await expect.poll(quick).toEqual([{ profileId: "claude-mock", model: null }, { profileId: "claude-subscription", model: null }, { profileId: "claude-mock", model: "mock-claude-b" }]);
  await screenshot(app, "stage-18", "S18-quick-models", page);
  await page.keyboard.press("Escape");

  // The new-task page shows them in that order; the model the draft has now (Mock 模型) always shows, in the last place.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const tiles = page.getByRole("group", { name: "模型" }).getByRole("button").filter({ hasNotText: "全部型号" });
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toHaveAttribute("title", /^Mock Claude/);
  await expect(tiles.nth(1)).toHaveAttribute("title", /^Claude/);
  await expect(tiles.nth(2)).toHaveAttribute("title", /^Mock 模型/);
  await tiles.nth(0).click();
  await page.keyboard.press("Alt+3");
  await expect(tiles.nth(2)).toHaveAttribute("title", /mock-claude-b|Mock Claude B/i);
});

test("设置 → 模型 → a channel's 自动压缩点: 272k by default, its own value, the CLI's, or back to the default (S18)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const own = async () => (await studio!.api<StudioSettings>("GET", "/api/settings")).autoCompactProfiles["codex-mock"];
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.locator('[data-testid="channel-nav"][data-id="codex-mock"]').click();
  const section = dialog.getByRole("region", { name: "自动压缩点" });
  const input = section.getByTestId("auto-compact-input");
  await expect(input).toHaveValue("272");
  await expect(section.getByTestId("auto-compact-shared-tag")).toBeVisible();
  await input.fill("200");
  await input.press("Enter");
  await expect(section.getByRole("status")).toContainText("200k");
  await expect.poll(own).toBe(200_000);
  await expect(section.getByTestId("auto-compact-shared-tag")).toHaveCount(0);
  await input.fill("10");
  await section.getByTestId("auto-compact-save").click();
  await expect(section.getByRole("alert")).toContainText("50 到 1000");
  await input.fill("200");
  await section.scrollIntoViewIfNeeded();
  await screenshot(app, "stage-18", "S18-models-channel", page);
  await section.getByTestId("auto-compact-cli").click();
  await expect(section.getByTestId("auto-compact-off")).toBeVisible();
  await expect.poll(own).toBe("cli");

  // Another channel keeps the default.
  await dialog.locator('[data-testid="channel-nav"][data-id="claude-mock"]').click();
  await expect(dialog.getByRole("region", { name: "自动压缩点" }).getByTestId("auto-compact-input")).toHaveValue("272");

  await dialog.locator('[data-testid="channel-nav"][data-id="codex-mock"]').click();
  await section.getByTestId("auto-compact-shared").click();
  await expect(section.getByTestId("auto-compact-input")).toHaveValue("272");
  await expect(section.getByTestId("auto-compact-shared-tag")).toBeVisible();
  await expect.poll(own).toBeUndefined();
});

test("a third-party DeepSeek channel run by DSH: its address, its own key and the site's model names reach DSH (2026-10-19)", async () => {
  // The relay's model listing (GET /v1/models), as Sub2API answers it; only this key may read it.
  const relay = createServer((req, res) => {
    const ok = req.url === "/v1/models" && req.headers.authorization === "Bearer sk-relay-ds";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { object: "list", data: [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "deepseek/deepseek-v4-pro" }, { id: "deepseek/deepseek-ocr" }] } : { error: "no" }));
  });
  server = relay;
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  studio = await launchStudio({ dsh: true });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.getByTestId("channel-add-dsh").click();
  const form = page.getByTestId("channel-dialog");
  await expect(form.getByTestId("channel-kind-dsh")).toHaveAttribute("aria-checked", "true");
  await form.getByTestId("channel-label").fill("中转 DeepSeek");
  await form.getByTestId("channel-url").fill(relayUrl);
  await form.getByTestId("channel-key").fill("sk-relay-ds");
  // 从网址读取: the site's names to click in; the first clicked is the default.
  await form.getByTestId("channel-models-read").click();
  const site = form.getByTestId("channel-site-models");
  await expect(site.getByRole("button")).toHaveText(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-ocr"]);
  await site.getByRole("button", { name: "deepseek/deepseek-v4-pro" }).click();
  await site.getByRole("button", { name: "deepseek/deepseek-v4.1-flash" }).click();
  await expect(form.getByTestId("channel-models")).toHaveValue("deepseek/deepseek-v4-pro\ndeepseek/deepseek-v4.1-flash");
  await screenshot(app, "stage-18", "S18-dsh-channel", page);
  await form.getByTestId("channel-save").click();
  await expect(form).toHaveCount(0);
  const card = dialog.getByTestId("channel-page");
  await expect(card.getByTestId("channel-title")).toHaveText("中转 DeepSeek");
  await expect(card).toContainText("DSH 方案");
  const channel = (await studio.api<ModelChannel[]>("GET", "/api/channels")).find((c) => c.kind === "dsh")!;
  expect(channel).toMatchObject({ label: "中转 DeepSeek", baseUrl: relayUrl, model: null, models: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4.1-flash"], keySaved: true });
  expect(JSON.stringify(channel)).not.toContain("sk-relay-ds");

  // A session on it: DSH starts with the channel's address, key and model.
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "走中转 DeepSeek", workspaceId: ws.id, firstSession: { profileId: channel.id, text: "[[endpoint]]" } });
  await page.keyboard.press("Escape");
  await page.getByTestId("task-card").filter({ hasText: "走中转 DeepSeek" }).click();
  await expect(page.getByTestId("msg-agent").last()).toHaveText(`ENDPOINT base=${relayUrl} key=sk-relay-ds model=["deepseek-official","deepseek/deepseek-v4-pro"]`, { timeout: 60_000 });
  await expect(page.getByTestId("thread-head")).toContainText("中转 DeepSeek");

  // The channel's model list changes (10-22): the conversation's models and 型号顺序和默认 follow without a reload.
  const tray = page.getByTestId("options-tray").getByRole("group", { name: "型号" }).locator(".mtile-main");
  await page.getByTestId("switch-model").click();
  await expect(tray).toHaveText(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4.1-flash"]);
  await page.getByTestId("switch-model").click();
  await studio.api("PATCH", `/api/channels/${channel.id}`, { models: ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-ocr"] });
  await page.getByTestId("switch-model").click();
  await expect(tray).toHaveText(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-ocr"]);
  await page.getByTestId("switch-model").click();
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.locator(`[data-testid="channel-nav"][data-id="${channel.id}"]`).click();
  const rows = dialog.getByRole("region", { name: "型号顺序和默认" }).getByTestId("model-order-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAccessibleName("deepseek/deepseek-v4.1-flash，第 1 个，默认");
  await expect(rows.last()).toHaveAccessibleName("deepseek/deepseek-ocr，第 2 个");
});
