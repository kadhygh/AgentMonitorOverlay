import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
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
  // 2026-11-04 (plans/done/message-delivery.md): a mail forwarded while the turn waits on the person goes into the session's
  // inbox — shown at once, 「等这一轮结束后送进去」 — and is sent as the next turn once this one is over.
  const mail = await studio.api<{ id: string }>("POST", "/api/mail", { to: { kind: "session", sessionId: session.id }, text: "记得跑一下测试" });
  await studio.api("POST", `/api/mail/${mail.id}/forward`, {});
  const heldLine = page.getByTestId("msg-delivery").filter({ hasText: "等这一轮结束后送进去" });
  await expect(heldLine).toHaveAttribute("data-delivery", "held");
  await expect(heldLine.getByRole("button", { name: "立即发送" })).toBeVisible();
  await screenshot(studio.app, "studio", "inbox-held", page);
  await card.getByRole("button", { name: "批准" }).click();
  await expect(card).toContainText("已批准");
  await expect(page.getByTestId("msg-agent").filter({ hasText: "DONE New-Item notes.md" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("记得跑一下测试", { timeout: 30_000 });
  await expect(page.getByTestId("msg-delivery")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });

  // DSH has no fork (greyed in ⋯, none under the turns, 2026-11-10) and no terminal of its own.
  await expect(page.getByTestId("turn-fork")).toHaveCount(0);
  await page.getByTestId("session-more").click();
  await expect(page.getByTestId("session-menu")).toBeVisible();
  await expect(page.getByTestId("session-fork")).toBeDisabled();
  await expect(page.getByTestId("session-terminal")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A message sent while a turn runs waits for the turn to end.
  const composer = page.getByLabel("输入消息");
  await composer.fill("[[slow]]");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "排队" })).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveAttribute("placeholder", /这一轮结束后发给它/);
  await composer.fill("顺便看看测试");
  await page.getByRole("button", { name: "排队" }).click();
  await expect(page.getByTestId("msg-user").filter({ hasText: "顺便看看测试" })).toBeVisible();
  // 2026-11-04: it waits (等待送达), and 打断 sends it as the next turn instead of dropping it.
  await expect(page.getByTestId("msg-delivery").last()).toHaveAttribute("data-delivery", "waiting");
  await screenshot(studio.app, "stage-17", "S17-dsh-queued", page);
  await page.getByRole("button", { name: "打断" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-DSH: 顺便看看测试", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("msg-delivery")).toHaveCount(0);
});

test("a subagent DSH starts itself: a ▸ row with its status, its own session read from DSH's log (2026-11-06)", async () => {
  studio = await launchStudio({ dsh: true });
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "DSH 子 agent", workspaceId: ws.id, firstSession: { profileId: "dsh-mock", text: "[[subagent: 8000]]" } });
  await page.getByTestId("task-card").filter({ hasText: "DSH 子 agent" }).click();
  const row = page.getByTestId("msg-subagent");
  await expect(row).toContainText("数文件", { timeout: 30_000 });
  await expect(row.getByTestId("subagent-status")).toHaveText("◐ 进行中");
  // A message meanwhile waits for the subagent: DSH's turn ends only once it has, and the row says so.
  const composer = page.getByLabel("输入消息");
  await composer.fill("顺便说一句");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-delivery").last()).toContainText("等子 agent 跑完后送到");
  await screenshot(studio.app, "studio", "dsh-subagent-running", page);
  // Its own session: what it does, as it goes; it takes no messages of its own.
  await row.getByRole("button", { name: "查看" }).click();
  await expect(page.getByTestId("thread-head")).toContainText("数文件");
  await expect(page.getByLabel("输入消息")).toHaveAttribute("placeholder", "子 agent 不能单独接收消息，请在父会话里继续。");
  await expect(page.getByTestId("msg-agent").filter({ hasText: "共 2 个文件" })).toBeVisible({ timeout: 30_000 });
  await screenshot(studio.app, "studio", "dsh-subagent-session", page);
  await page.getByTestId("nav-back").click();
  await expect(row.getByTestId("subagent-status")).toHaveText("✓ 已完成", { timeout: 30_000 });
  await expect(page.getByTestId("msg-agent").filter({ hasText: "SUB DONE" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-DSH: 顺便说一句", { timeout: 30_000 });
  await expect(page.getByTestId("msg-delivery")).toHaveCount(0);
  await screenshot(studio.app, "studio", "dsh-subagent-done", page);
});

test("a DSH goal going on by itself: each round a turn, the answers stay in sight, 打断 stops it (问题 #13)", async () => {
  // 标准 view: finished turns fold (the tests' default 完全展开 never folds).
  studio = await launchStudio({ dsh: true, transcriptView: "standard" });
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "DSH 目标", workspaceId: ws.id, firstSession: { profileId: "dsh-mock", text: "一直做 [[goal: 2]]" } });
  await page.getByTestId("task-card").filter({ hasText: "DSH 目标" }).click();
  const turns = page.getByTestId("turn");
  // Round 2 replied and DSH is still taken to be working (its turn ends after a quiet spell): three turns.
  await expect(page.getByTestId("msg-agent").filter({ hasText: "ROUND 2 DONE" })).toBeVisible({ timeout: 30_000 });
  await expect(turns).toHaveCount(3);
  // The person's turn and round 1 are over and folded, their answers outside the fold.
  await expect(turns.nth(0)).toHaveAttribute("data-folded", "true");
  await expect(turns.nth(0).getByTestId("msg-agent")).toContainText("MOCK-DSH: 一直做");
  await expect(turns.nth(1)).toHaveAttribute("data-folded", "true");
  await expect(turns.nth(1).getByTestId("msg-agent")).toContainText("ROUND 1 DONE");
  await expect(page.getByRole("button", { name: "打断" })).toBeVisible();
  await screenshot(studio.app, "stage-17", "S17-dsh-goal-rounds", page);
  await page.getByRole("button", { name: "打断" }).click();
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await expect(turns.nth(2).getByTestId("turn-fold")).toContainText("已停止");
  await expect(turns.nth(2).getByTestId("msg-agent")).toContainText("ROUND 2 DONE");
  await screenshot(studio.app, "stage-17", "S17-dsh-goal-stopped", page);
});


/** An asar archive with no files (its header pickles, as @electron/asar writes them). */
function emptyAsar(): Buffer {
  const json = Buffer.from(JSON.stringify({ files: {} }));
  const header = Buffer.alloc(8 + json.length + ((4 - (json.length % 4)) % 4));
  header.writeUInt32LE(header.length - 4, 0);
  header.writeInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header]);
}

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
  await expect(section.getByTestId("dsh-check-result")).toContainText("可用 · ACP 1 · 3 个型号", { timeout: 30_000 });
  await screenshot(studio.app, "stage-17", "S17-dsh-settings", page);

  // The models DSH offered are the session's choices.
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.profiles.find((p) => p.id === "dsh-mock")?.runtime).toBe("dsh");
  const choices = await studio.api<{ models: Array<{ id: string }> }>("GET", "/api/profiles/dsh-mock/choices");
  expect(choices.models.map((m) => m.id)).toEqual(["deepseek-official/deepseek-v4-flash", "deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"]);

  // The desktop app installed in another folder (2026-11-02): chosen here, then back to looking for it.
  const app = studio.workspace("D-Apps-DeepSeek Harness");
  mkdirSync(join(app, "resources"), { recursive: true });
  writeFileSync(join(app, "DeepSeek Harness.exe"), "");
  // A real (empty) archive: the Host runs on Electron, whose fs takes a broken .asar for missing.
  writeFileSync(join(app, "resources", "app.asar"), emptyAsar());
  await section.getByTestId("dsh-desktop-path").fill(join(studio.workspace("nowhere")));
  await section.getByTestId("dsh-desktop-save").click();
  await expect(dialog.getByText(/里没有 DeepSeek Harness 桌面版/)).toBeVisible();
  await section.getByTestId("dsh-desktop-path").fill(app);
  await section.getByTestId("dsh-desktop-save").click();
  await expect(section.getByTestId("dsh-desktop")).toContainText(`${app}，你选的文件夹`);
  await expect(section.getByText("现在用的是桌面版")).toBeVisible();
  await screenshot(studio.app, "studio", "dsh-desktop-chosen", page);
  await section.getByTestId("dsh-desktop-clear").click();
  await expect(section.getByTestId("dsh-desktop")).toContainText("没找到 DeepSeek Harness 桌面版");
  await expect(section.getByText("现在用的是源码克隆")).toBeVisible();
});

test("设置 → 模型 → DeepSeek: signs in with the DSH desktop app's account or an API key (2026-11-03)", async () => {
  // The desktop app's DSH home of this test, never this machine's.
  const home = mkdtempSync(join(tmpdir(), "amo-e2e-dsh-home-"));
  try {
    studio = await launchStudio({ dsh: true, env: { DSH_HOME: home } });
    const { page } = studio;
    await page.getByRole("button", { name: "设置" }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    await dialog.getByRole("tab", { name: "模型" }).click();
    await dialog.locator('[data-testid="channel-nav"][data-id="dsh-mock"]').click();
    const section = dialog.getByTestId("dsh-section");
    // A key is saved here: it is what DeepSeek uses until the account is chosen.
    await expect(section.getByTestId("dsh-auth-key")).toHaveAttribute("aria-pressed", "true");
    await expect(section.getByTestId("dsh-key")).toContainText("Key 已保存");
    await expect(section.getByTestId("dsh-key-input")).toHaveAttribute("type", "password");

    await section.getByTestId("dsh-auth-account").click();
    await expect(section.getByTestId("dsh-auth-account")).toHaveAttribute("aria-pressed", "true");
    await expect(section.getByTestId("dsh-account")).toContainText("桌面版还没有登录 DeepSeek 账号");
    await screenshot(studio.app, "studio", "dsh-auth-signed-out", page);
    // Signed in in the app: 重新检测 finds it.
    writeFileSync(join(home, ".credentials.yaml"), ["version: 1", "records:", "  deepseek-account-platform/default:", "    kind: grant", ""].join("\n"));
    await section.getByTestId("dsh-account-recheck").click();
    await expect(section.getByTestId("dsh-account")).toContainText("✓ 桌面版已登录 DeepSeek 账号");
    await expect(section.getByTestId("dsh-account")).toContainText(join(home, ".credentials.yaml"));
    await screenshot(studio.app, "studio", "dsh-auth-account", page);
    const choices = await studio.api<{ models: Array<{ id: string }> }>("GET", "/api/profiles/dsh-mock/choices");
    expect(choices.models.map((m) => m.id)).toEqual(["deepseek-account/deepseek-flash", "deepseek-account/deepseek-v4-pro"]);

    await section.getByTestId("dsh-auth-key").click();
    await expect(section.getByTestId("dsh-key")).toContainText("Key 已保存");
    await screenshot(studio.app, "studio", "dsh-auth-key", page);
  } finally {
    await studio?.close();
    studio = undefined;
    removeTempDir(home);
  }
});
