import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 接续已有会话 (2026-11-05, plans/resume-cli-sessions.md): on the new-task page, a Claude session of the desktop app or a
// terminal is picked from the person's own Claude Code dir (a stand-in here, signed in), and the task goes on from a
// copy of it: its conversation shown, the model answering with all of it (the mock Anthropic API).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** A transcript as Claude Code writes one, in the config dir `mine`. */
function writeTranscript(mine: string, cwd: string, entrypoint: string, turns: Array<[string, string]>, title?: string): string {
  const id = randomUUID();
  const base = { isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.300", gitBranch: "main", entrypoint };
  const lines: object[] = [];
  let parent: string | null = null;
  let t = Date.now() - 2 * 3600_000;
  turns.forEach(([ask, reply], i) => {
    for (const entry of [
      { type: "user", message: { role: "user", content: ask } },
      { type: "assistant", message: { id: `msg_${i}`, type: "message", role: "assistant", model: "claude-mock", content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    ]) {
      const uuid = randomUUID();
      lines.push({ ...base, parentUuid: parent, uuid, timestamp: new Date((t += 60_000)).toISOString(), ...entry });
      parent = uuid;
    }
  });
  if (title) lines.push({ type: "custom-title", customTitle: title, sessionId: id });
  const dir = join(mine, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return id;
}

test("接续已有会话: pick a desktop app session on the new-task page, go on from a copy of it", async ({}, info) => {
  const mine = join(info.outputDir, "my-claude");
  mkdirSync(mine, { recursive: true });
  const expiresAt = Date.now() + 365 * 24 * 3600_000;
  writeFileSync(join(mine, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-e2e-local", refreshToken: "sk-ant-ort01-e2e-local", expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
  studio = await launchStudio({ env: { CLAUDE_CONFIG_DIR: mine } });
  const { page, app } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  // The desktop app works in a worktree under the project; a terminal in a folder no project has.
  const worktree = join(alpha.path, ".claude", "worktrees", "brave-otter");
  const desktop = writeTranscript(mine, worktree, "claude-desktop", [["每天的巡检：先跑 verify，再看问题页。记住暗号 PINEAPPLE-42", "好的，巡检流程记下了。"], ["今天的巡检做完了吗？", "做完了，没有新问题。"]], "每日巡检");
  const elsewhere = studio.workspace("scratch");
  writeTranscript(mine, elsewhere, "cli", [["整理一下下载目录", "整理好了。"]]);

  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByTestId("draft-resume-open").click();
  const dialog = page.getByTestId("resume-dialog");
  await expect(dialog.getByTestId("resume-item")).toHaveCount(2);
  // Grouped by project: alpha first, the folder in no project last.
  await expect(dialog.getByRole("group", { name: "alpha" }).getByTestId("resume-item")).toContainText("每日巡检");
  await expect(dialog.getByRole("group", { name: "不在已有项目里" }).getByTestId("resume-item")).toContainText("整理一下下载目录");
  await expect(dialog.getByTestId("resume-item").first()).toContainText("Claude 桌面版");
  // The end of its conversation, to know it by.
  await expect(dialog.getByTestId("resume-tail")).toContainText("做完了，没有新问题。");
  await expect(dialog.getByTestId("resume-count")).toHaveText("4 条");
  await screenshot(app, "resume-outside", "resume-01-picker", page);
  await dialog.getByTestId("resume-pick").click();
  await expect(dialog).toHaveCount(0);

  // The draft is filled in: the name, the project, the Claude subscription; where it goes on is said.
  const banner = page.getByTestId("draft-resume");
  await expect(banner).toContainText("每日巡检");
  await expect(page.getByLabel("任务名")).toHaveValue("每日巡检");
  await expect(page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("draft-resume-where")).toContainText("brave-otter");
  await expect(page.getByTestId("draft-start")).toHaveText(/接续/);
  await screenshot(app, "resume-outside", "resume-02-draft", page);

  // 接续 with a first message: the old conversation, then the reply; the model got the whole of it.
  await page.getByLabel("第一句话").fill("暗号是什么？");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 暗号是什么？", { timeout: 60_000 });
  await expect(page.getByTestId("msg-user").first()).toContainText("每天的巡检");
  await expect(page.getByText("接续自 Studio 之外的会话「每日巡检」")).toBeVisible();
  expect(JSON.stringify(studio.claudeMock!.requests.at(-1)!.body.messages)).toContain("PINEAPPLE-42");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const session = state.sessions.find((s) => s.title === "每日巡检")!;
  expect(session.runtimeRef).not.toBe(desktop);
  // The original is left as it was.
  expect(readFileSync(join(mine, "projects", worktree.replace(/[^a-zA-Z0-9]/g, "-"), `${desktop}.jsonl`), "utf8")).not.toContain("暗号是什么");
  await screenshot(app, "resume-outside", "resume-03-thread", page);

  // Only the terminal one is left; its folder becomes a project in one click, and it is taken on without a message.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByTestId("draft-resume-open").click();
  await expect(dialog.getByTestId("resume-item")).toHaveCount(1);
  await dialog.getByTestId("resume-item").dblclick();
  await expect(page.getByTestId("draft-resume-where")).toContainText("公共目录");
  await page.getByTestId("draft-resume-add-project").click();
  await expect(page.getByRole("group", { name: "项目" }).getByRole("button", { name: "scratch" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("draft-resume-where")).toHaveCount(0);
  await page.getByTestId("draft-start").click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("整理好了。", { timeout: 30_000 });
  await expect(page.getByTestId("msg-user")).toHaveCount(1);
});
