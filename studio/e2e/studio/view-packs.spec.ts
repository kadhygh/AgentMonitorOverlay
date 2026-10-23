import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Session, SessionItem, Task, ViewOpenResult, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 查看包 (2026-10-23): an agent hands the person files and changes to look at in one go; the viewer window shows the
// pack — its items in a list, the one picked beside it, drawn by its kind.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

async function nextWindow(app: ElectronApplication, act: () => Promise<unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await act();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

/** A git project with a commit and uncommitted changes, and a session of a task in it. */
async function project(s: Studio): Promise<{ dir: string; ws: Workspace; session: Session }> {
  const dir = s.workspace("game");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.1\nlocal boss = 'Lv10'\nreturn { rate = rate, boss = boss }\n");
  writeFileSync(join(dir, "notes.md"), "# 掉落\n\n先改概率。\n");
  writeFileSync(join(dir, "shop.lua"), "return { price = 5 }\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.25\nlocal boss = 'Lv10'\nreturn { rate = rate, boss = boss }\n");
  writeFileSync(join(dir, "shop.lua"), "return { price = 8 }\n");
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { session } = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello" } });
  return { dir, ws, session };
}

test("files with 重点; the same session sending again a moment later adds to the same window", async () => {
  studio = await launchStudio();
  const { app } = studio;
  const { session } = await project(studio);

  const win = await nextWindow(app, () =>
    studio!.api<ViewOpenResult>("POST", "/api/viewpacks", {
      sessionId: session.id,
      title: "掉落相关",
      items: [{ kind: "file", path: "drop.lua", note: "概率改了，boss 等级没动", highlights: [{ line: 1, note: "0.1 → 0.25" }, { line: 2, endLine: 3, note: "这两行没变" }] }],
    }),
  );
  await expect(win.getByTestId("viewpack-title")).toHaveText("掉落相关");
  // One item: no list. Its 重点 on top and under their lines.
  await expect(win.getByTestId("viewpack-entry")).toHaveCount(0);
  await expect(win.getByTestId("viewpack-mark")).toHaveCount(2);
  await expect(win.getByTestId("highlight-note")).toHaveText([/第 1 行\s*0\.1 → 0\.25/, /第 2–3 行\s*这两行没变/]);
  await expect(win.locator(".gr-line.hl")).toHaveCount(3);
  // Tab / Shift+Tab between the 重点, round at the ends, as between comments in Git Review (2026-10-23); the row on top
  // follows, as if its button had been clicked. Opened at the first, Tab goes on from there.
  const at = (line: number) => win.locator(`.gr-line.active[data-line="new:${line}"]`);
  const chips = win.getByTestId("viewpack-mark");
  await expect(at(1)).toHaveCount(1);
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
  await win.locator("body").press("Tab");
  await expect(at(2)).toHaveCount(1);
  await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "false");
  await win.locator("body").press("Tab");
  await expect(at(1)).toHaveCount(1);
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
  await win.locator("body").press("Shift+Tab");
  await expect(at(2)).toHaveCount(1);
  // A click on the button of the 重点 Tab left goes back to it.
  await chips.nth(0).click();
  await expect(at(1)).toHaveCount(1);
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
  // The keys are written down: under the file, and r on 重新载入.
  await expect(win.getByTestId("viewer-keys")).toContainText("下一处 / 上一处重点或批注");
  await expect(win.getByTestId("viewer-keys")).toContainText("翻页");
  await expect(win.getByRole("button", { name: /重新载入/ }).locator("kbd")).toHaveText("R");
  // The overview ruler is the scrollbar here too (2026-10-23): the 重点 on it (lines 1–3, one run).
  await expect(win.locator('[data-testid="ruler-mark"][data-kind="hl"]')).toHaveCount(1);

  // A second call a moment later: the same window, now with a list; what was added is shown.
  await studio.api("POST", "/api/viewpacks", { sessionId: session.id, items: [{ kind: "file", path: "notes.md" }] });
  await expect(win.getByTestId("viewpack-entry")).toHaveCount(2);
  await expect(win.getByTestId("viewpack-entry").nth(1)).toHaveAttribute("aria-current", "true");
  await expect(win.getByTestId("viewpack-file")).toContainText("先改概率");
  await win.getByTestId("viewpack-entry").first().click();
  await expect(win.getByTestId("highlight-note")).toHaveCount(2);
  await screenshot(app, "stage-18", "S23-viewpack-files", win, "viewer");
});

test("git items list the files pointed at first, above the rest, with their 重点; a 改动预览 is a diff whose comments go back to the conversation", async () => {
  studio = await launchStudio();
  const { app } = studio;
  const { dir, session } = await project(studio);

  const win = await nextWindow(app, () =>
    studio!.api<ViewOpenResult>("POST", "/api/viewpacks", {
      sessionId: session.id,
      items: [
        { kind: "git", files: ["drop.lua"], highlights: [{ path: "drop.lua", line: 1, note: "概率从 0.1 改到 0.25" }] },
        { kind: "git", source: "commit", commit: "HEAD", files: ["drop.lua", "nope.lua"] },
        { kind: "proposal", path: "drop.lua", note: "建议把 boss 也调一下", proposed: "local rate = 0.25\nlocal boss = 'Lv20'\nreturn { rate = rate, boss = boss }\n" },
      ],
    }),
  );
  // The list names what each compares (a commit with its first line) and the files it points at.
  await expect(win.getByTestId("viewpack-entry")).toHaveText([/未提交的改动.*drop\.lua · 1 处重点/, /提交 [0-9a-f]{7} · base.*drop\.lua、nope\.lua/, /drop\.lua（改动预览）/]);
  await expect(win.getByTestId("viewpack-keys")).toContainText("切换条目");
  await expect(win.getByTestId("viewpack-keys")).toContainText("切换里面的文件");

  // Uncommitted changes: drop.lua pointed at, on top; shop.lua (changed too) below it, still there (2026-10-23).
  await expect(win.getByTestId("review-group")).toHaveText([/重点文件\s*1/, /其他改动\s*1/]);
  await expect(win.getByTestId("review-file")).toHaveCount(2);
  await expect(win.getByTestId("review-file").nth(0)).toContainText("drop.lua");
  await expect(win.getByTestId("review-file").nth(1)).toContainText("shop.lua");
  // Its 重点 on the line (violet, with the icon on its first line), the note under it, and on the ruler.
  await expect(win.getByTestId("review-file-head")).toContainText("drop.lua");
  await expect(win.locator('.gr-line.hl.hl-start[data-line="new:1"]')).toHaveCount(1);
  await expect(win.getByTestId("highlight-note")).toContainText("概率从 0.1 改到 0.25");
  await expect(win.locator('[data-testid="ruler-mark"][data-kind="hl"]')).toHaveCount(1);
  // The embedded Review head fits: the window is kept wide enough for it beside the list (no page scrolling sideways).
  await expect.poll(() => win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await screenshot(app, "stage-18", "S23-viewpack-git-focus", win, "viewer");
  // Ctrl+J / Ctrl+K: the files here; j / k: the pack's list.
  await win.locator("body").press("Control+j");
  await expect(win.getByTestId("review-file-head")).toContainText("shop.lua");
  await win.locator("body").press("Control+k");
  await expect(win.getByTestId("review-file-head")).toContainText("drop.lua");
  await win.locator("body").press("Shift+J");
  await expect(win.getByTestId("viewpack-entry").nth(1)).toHaveAttribute("aria-current", "true");

  // The commit: drop.lua pointed at (added there), nope.lua said to have no changes in it, the rest below.
  await expect(win.getByTestId("review-unchanged")).toContainText("nope.lua在这个范围里没有改动");
  await expect(win.getByTestId("review-group")).toHaveText([/重点文件\s*1/, /其他改动\s*2/]);
  await win.locator("body").press("k");
  await expect(win.getByTestId("viewpack-entry").nth(0)).toHaveAttribute("aria-current", "true");
  await win.getByTestId("viewpack-entry").nth(1).click();

  // The proposal: the change as a diff; nothing on disk changed.
  await win.getByTestId("viewpack-entry").nth(2).click();
  const proposal = win.getByTestId("viewpack-proposal");
  await expect(proposal.locator(".gr-line.del")).toContainText("Lv10");
  await expect(proposal.locator(".gr-line.add")).toContainText("Lv20");
  expect(git(dir, "diff", "--", "drop.lua")).not.toContain("Lv20");
  await proposal.locator('[data-line="new:2"]').getByTestId("add-comment").click();
  await proposal.getByTestId("comment-draft").getByLabel("批注内容").fill("Lv20 太高，先 Lv15");
  await proposal.getByTestId("comment-draft").getByRole("button", { name: "保存" }).click();
  await expect(win.getByTestId("viewpack-send")).toContainText("1 条批注");
  await screenshot(app, "stage-18", "S23-viewpack-proposal", win, "viewer");
  // 复制注释 (2026-10-23, in place of 发回会话).
  await win.getByTestId("viewpack-copy").click();
  await expect(win.getByTestId("viewpack-send")).toHaveCount(0);
  await expect.poll(() => studio!.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1) ?? "")).toContain("【对改动预览的批注】drop.lua");
  const text = await studio!.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1) ?? "");
  expect(text).toContain("改后第 2 行");
  expect(text).toContain("Lv20 太高，先 Lv15");
});

test("an agent's view_open opens the pack; its tool row opens it again", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const { ws } = await project(studio);
  const args = { title: "给你看", items: [{ kind: "file", path: "drop.lua", highlights: [{ line: 1, note: "这里" }] }, { kind: "file", path: "shop.lua" }] };
  const win = await nextWindow(app, () =>
    studio!.api("POST", "/api/tasks", { title: "看文件", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: `[[mcp: view_open ${JSON.stringify(args)}]]` } }),
  );
  await expect(win.getByTestId("viewpack-title")).toHaveText("给你看");
  await expect(win.getByTestId("viewpack-entry")).toHaveCount(2);

  await page.getByTestId("task-card").filter({ hasText: "看文件" }).click();
  const reopen = page.getByTestId("tool-open-pack");
  await expect(reopen).toBeVisible({ timeout: 30_000 });
  await screenshot(app, "stage-18", "S23-viewpack-reopen", page);
  // The preview window shows another pack meanwhile; the tool row brings this one back into it.
  await studio.api("POST", "/api/viewpacks", { workspaceId: ws.id, title: "别的", items: [{ kind: "file", path: "notes.md" }] });
  await expect(win.getByTestId("viewpack-title")).toHaveText("别的");
  await reopen.click();
  await expect(win.getByTestId("viewpack-title")).toHaveText("给你看");
  await expect(win.getByTestId("viewpack-entry")).toHaveCount(2);
});
