import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { MOCK_SUGGESTION } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// Stage 12, S12-E: CLI features in the conversation — the / menu, context compaction, review mode, retries, notices,
// background commands, images read by a tool and Claude's suggested next message. The real Codex app-server and the
// real Claude Code CLI against the mock models; no model budget.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTask(s: Studio, workspace: string, firstSession: Record<string, unknown>) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: workspace });
  await s.api("POST", "/api/tasks", { title: "命令和后台", workspaceId: ws.id, firstSession });
  await s.page.getByTestId("task-card").first().click();
}

const reply = (page: Page, text: string) => expect(page.getByTestId("msg-agent").filter({ hasText: text }).first()).toBeVisible({ timeout: 60_000 });
const idle = (page: Page) => expect(page.getByTestId("run-status")).toHaveCount(0, { timeout: 60_000 });

async function send(page: Page, text: string) {
  const composer = page.getByLabel("输入消息");
  await composer.fill(text);
  await composer.press("Enter");
}

test("Codex: the / menu, compaction, review mode and retries", async () => {
  test.setTimeout(180_000);
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  // A git project with a skill of its own.
  const dir = studio.workspace("alpha");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".agents", "skills", "release-notes"), { recursive: true });
  writeFileSync(join(dir, ".agents", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: 根据这次的改动写发布说明\n---\n\n写发布说明。\n");
  writeFileSync(join(dir, "importer.py"), "def fetch(url):\n    return url\n");
  await openTask(studio, dir, { profileId: "codex-mock", text: "hello" });
  await reply(page, "MOCK: hello");
  await idle(page);

  // "/" opens the menu: Studio's commands first, then Codex's review mode and the project's skills.
  const composer = page.getByLabel("输入消息");
  await composer.fill("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("option", { name: /\/release-notes/ })).toBeVisible({ timeout: 30_000 });
  await expect(menu.locator(".suggest-h")).toHaveText(["Studio", "命令", "Skills"]);
  await expect(menu.getByRole("option").first()).toContainText("/compact");
  await expect(menu.getByRole("option", { name: /\/review/ }).first()).toContainText("Git Review");
  await expect(menu.getByRole("option", { name: /\/code-review/ })).toContainText("让 Codex 审查改动");
  await screenshot(app, "stage-12", "S12-E-slash-menu", page);

  // Filtering, keys: ↓ moves, Esc closes and keeps the text.
  await composer.fill("/re");
  await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option").first()).toContainText("/review");
  await composer.press("ArrowDown");
  await expect(menu.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await composer.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer).toHaveValue("/re");

  // /compact from the menu: Codex compacts in a turn of its own; the row says how large the context was.
  await composer.fill("/comp");
  await expect(menu.getByRole("option").first()).toContainText("/compact");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  const compaction = page.getByTestId("compaction");
  await expect(compaction).toHaveAttribute("data-state", "completed", { timeout: 60_000 });
  await expect(compaction).toContainText(/上下文已压缩（之前约 [\d.]+k? tok）/);
  // Codex's own warning after compacting is a notice row.
  await expect(page.getByTestId("msg-notice").filter({ hasText: "multiple compactions" })).toBeVisible();
  await idle(page);
  await expect(page.getByTestId("compact-button")).toBeEnabled();
  await screenshot(app, "stage-12", "S12-E-compaction", page);

  // /code-review runs Codex's review mode; the review is the answer, Codex's own prompt is not shown.
  await send(page, "/code-review");
  await expect(page.getByTestId("msg-notice").filter({ hasText: "Codex 开始审查：当前未提交的改动" })).toBeVisible({ timeout: 60_000 });
  await reply(page, "MOCK: Review the current code changes");
  await idle(page);
  await expect(page.getByTestId("msg-user").filter({ hasText: "Review the current code changes" })).toHaveCount(0);
  await expect(page.getByTestId("msg-user").last()).toHaveText("/code-review");
  await screenshot(app, "stage-12", "S12-E-review", page);

  // A dropped stream is retried without an error row; the turn goes on.
  await send(page, "[[retry]] again");
  await reply(page, "MOCK: [[retry]] again");
  await expect(page.getByTestId("msg-error")).toHaveCount(0);

  // Studio's /review opens the project's Git Review window.
  await send(page, "/review");
  await expect.poll(() => app.windows().some((w) => w.url().includes("#review")), { timeout: 20_000 }).toBe(true);
  await expect(composer).toHaveValue("");
});

test("Claude: commands, a background command, retries, notices, images and suggestions", async () => {
  test.setTimeout(240_000);
  studio = await launchStudio({ transcriptView: "verbose" });
  const { page, app } = studio;
  const dir = studio.workspace("beta");
  const picture = join(dir, "logo.png");
  copyFileSync(join(studioRoot, "design", "icon", "viewfinder-512.png"), picture);
  // Suggestions are off by default (one more model request per turn); this test turns them on.
  await studio.api("PUT", "/api/settings/chat", { promptSuggestions: true });
  await openTask(studio, dir, { profileId: "claude-mock", text: "[[suggest]] 你好" });
  await reply(page, "MOCK: [[suggest]] 你好");
  await idle(page);

  // After the second reply Claude suggests the next message: a chip that fills the composer.
  await send(page, "再来一次");
  await reply(page, "MOCK: 再来一次");
  const chips = page.getByTestId("suggestions");
  await expect(chips).toContainText(MOCK_SUGGESTION, { timeout: 30_000 });
  await screenshot(app, "stage-12", "S12-E-suggestion", page);
  await chips.getByRole("button", { name: MOCK_SUGGESTION }).click();
  const composer = page.getByLabel("输入消息");
  await expect(composer).toHaveValue(MOCK_SUGGESTION);
  await expect(chips).toHaveCount(0);

  // The / menu lists Claude Code's commands and skills (no /clear or /model: Studio keeps those).
  await composer.fill("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("option", { name: /^\/context/ })).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByRole("option", { name: /^\/clear/ })).toHaveCount(0);
  await expect(menu.getByRole("option", { name: /^\/model/ })).toHaveCount(0);
  await expect(menu.locator(".suggest-h").first()).toHaveText("Studio");
  await screenshot(app, "stage-12", "S12-E-slash-menu-claude", page);

  // /cost (an alias of /usage) runs without the model: its output is a record, not a reply.
  await composer.fill("/cost");
  await expect(menu.getByRole("option").first()).toContainText("/usage");
  await composer.press("Enter");
  const output = page.getByTestId("command-output");
  await expect(output).toContainText("/usage 的输出", { timeout: 60_000 });
  await expect(output).toContainText("Total cost");
  await idle(page);

  // A command left running in the background: listed above the composer with its output, and it can be stopped.
  await send(page, `[[bg: node -e "let i=0;setInterval(()=>console.log('tick '+(++i)),300)"]]`);
  const approval = page.getByTestId("approval").filter({ has: page.getByRole("button", { name: "批准" }) }).first();
  await approval.getByRole("button", { name: "批准" }).click({ timeout: 60_000 });
  const bg = page.getByTestId("background-task");
  await expect(bg).toHaveAttribute("data-state", "running", { timeout: 60_000 });
  await bg.getByRole("button", { name: "输出" }).click();
  await expect(page.getByTestId("background-output")).toContainText("tick 2", { timeout: 30_000 });
  await idle(page);
  await screenshot(app, "stage-12", "S12-E-background", page);
  await bg.getByRole("button", { name: "停止" }).click();
  await expect(bg).toHaveAttribute("data-state", "stopped", { timeout: 30_000 });
  await expect(bg).toContainText("已停止");

  // While the API is overloaded the status line says it retries; no error row once it goes through.
  await send(page, "[[retry:4]] 慢一点");
  await expect(page.getByTestId("run-status")).toContainText(/正在重试 \d+\/10 · 服务繁忙（529）/, { timeout: 30_000 });
  await screenshot(app, "stage-12", "S12-E-retry", page);
  await reply(page, "MOCK: [[retry:4]] 慢一点");
  await expect(page.getByTestId("msg-error")).toHaveCount(0);

  // An image file the agent reads shows on its tool row.
  await send(page, `[[read-image: ${picture}]]`);
  const thumb = page.getByTestId("tool-images").locator("img").last();
  await expect(thumb).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
  await idle(page);
  await screenshot(app, "stage-12", "S12-E-tool-image", page);

  // 压缩 beside the context readout compacts the conversation.
  await page.getByTestId("compact-button").click();
  await expect(page.getByTestId("compaction").last()).toHaveAttribute("data-state", "completed", { timeout: 60_000 });
  await expect(page.getByTestId("compaction").last()).toContainText("上下文已压缩");

  // A refusal: Claude Code's notices, not a silent stop (last: Claude Code refuses the rest of the session too).
  await send(page, "[[refuse]] 越界的请求");
  await expect(page.getByTestId("msg-notice").filter({ hasText: "拒绝了这次请求" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("msg-notice").filter({ hasText: "safeguards stopped the response" })).toBeVisible();
  // The withheld response leaves no empty reply behind.
  await expect(page.getByTestId("turn").last().locator(".stream-caret")).toHaveCount(0);
  await screenshot(app, "stage-12", "S12-E-notices", page);
});
