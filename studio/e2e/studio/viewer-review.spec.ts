import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// S14-A: comments in the viewer's 文件 mode (on the file and line, sent with the same bar, by default to the
// conversation that opened the file), what is being written surviving 文件 / 改动, 只看改动 / 完整文件 and 单栏 /
// 左右对照 with the place kept, the ruler as the only vertical scrollbar, Ctrl+F and Ctrl+G.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

/** 400 lines, committed; then changes at lines 40 and 335 in the working tree. */
function makeRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  const lines = Array.from({ length: 400 }, (_, i) => `local value_${i + 1} = ${i + 1} -- line ${i + 1}`);
  writeFileSync(join(dir, "big.lua"), `${lines.join("\n")}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  lines[39] = "local value_40 = 4000 -- tuned rate";
  lines[334] = "local value_335 = 33500 -- tuned rate";
  writeFileSync(join(dir, "big.lua"), `${lines.join("\n")}\n`);
}

async function openViewer(app: ElectronApplication, page: Page, target: Record<string, unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.evaluate((t) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(t), target);
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

const inView = (win: Page, selector: string) =>
  win.evaluate((sel) => {
    const el = document.querySelector(sel);
    const box = el?.closest(".gr-scroll")?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    return !!box && !!r && r.bottom > box.top && r.top < box.bottom;
  }, selector);

test("comments in the viewer's 文件 mode survive switching views, keep their place, and go to the conversation", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("game");
  makeRepo(dir);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "调数值",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "看看 big.lua" },
  });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 看看 big.lua", { timeout: 30_000 });

  // Opened from the conversation at line 335: the line is marked and in view; comments go to that session.
  const viewer = await openViewer(app, page, { path: join(dir, "big.lua"), workspaceId: ws.id, line: 335, sessionId: session.id });
  const code = viewer.getByTestId("viewer-code");
  await expect(code.locator(".gr-line.marked")).toHaveAttribute("data-line", "new:335");
  expect(await inView(viewer, '[data-line="new:335"]')).toBe(true);

  // A comment on line 335, half written; 改动 and back: still there, still in view.
  await code.locator('[data-line="new:335"] [data-testid="add-comment"]').click();
  await code.getByTestId("comment-draft").locator("textarea").fill("这个值从哪来");
  await viewer.getByTestId("viewer-mode-changes").click();
  await expect(viewer.getByTestId("review-file-head")).toContainText("big.lua");
  await viewer.getByTestId("viewer-mode-file").click();
  await expect(code.getByTestId("comment-draft").locator("textarea")).toHaveValue("这个值从哪来");
  expect(await inView(viewer, '.vw-review [data-testid="comment-draft"]')).toBe(true);
  await code.getByTestId("comment-draft").locator("textarea").press("Control+Enter");
  await expect(code.getByTestId("review-comment")).toContainText("这个值从哪来");
  // The send bar shows with the drafts, at the conversation that opened the file.
  await expect(code.getByTestId("review-session")).toHaveValue(session.id);
  await screenshot(app, "stage-14", "S14-A-viewer-comment", viewer, "viewer");

  // In 改动 (the project's Review) the same comment sits on line 335 of the new file.
  await viewer.getByTestId("viewer-mode-changes").click();
  const changes = viewer.locator(".vw-changes");
  await changes.getByRole("button", { name: "完整文件" }).click();
  const card = changes.getByTestId("review-comment").filter({ hasText: "这个值从哪来" });
  await expect(card).toBeVisible();
  // Editing it, half done; 只看改动, then back to 完整文件: the box is still open with the text, and in view.
  await card.getByRole("button", { name: "编辑" }).click();
  await card.locator("textarea").fill("这个值从哪来？改成 335 合理吗");
  await changes.getByRole("button", { name: "只看改动" }).click();
  await expect(changes.locator('[data-anchor="new:335"] textarea')).toHaveValue("这个值从哪来？改成 335 合理吗");
  expect(await inView(viewer, '.vw-changes [data-anchor="new:335"]')).toBe(true);
  await changes.getByRole("button", { name: "左右对照" }).click();
  await expect(changes.locator('[data-anchor="new:335"] textarea')).toHaveValue("这个值从哪来？改成 335 合理吗");
  expect(await inView(viewer, '.vw-changes [data-anchor="new:335"]')).toBe(true);
  await changes.getByRole("button", { name: "单栏" }).click();
  await changes.getByRole("button", { name: "完整文件" }).click();
  expect(await inView(viewer, '.vw-changes [data-anchor="new:335"]')).toBe(true);
  await changes.locator('[data-anchor="new:335"] textarea').press("Control+Enter");
  await expect(changes.getByTestId("review-comment").filter({ hasText: "改成 335 合理吗" })).toBeVisible();

  // No comment open: the line at the top of the view stays at the top across 只看改动 / 完整文件. (Up there first:
  // rows far from the view are not drawn, 2026-10-20.)
  await viewer.evaluate(() => (document.querySelector(".vw-changes .gr-scroll")!.scrollTop = 0));
  await changes.locator('[data-line="new:40"]').scrollIntoViewIfNeeded();
  await viewer.evaluate(() => {
    const scroller = document.querySelector(".vw-changes .gr-scroll")!;
    const row = document.querySelector('.vw-changes [data-line="new:40"]')!;
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  await changes.getByRole("button", { name: "只看改动" }).click();
  expect(await inView(viewer, '.vw-changes [data-line="new:40"]')).toBe(true);

  // B2: with the ruler, the diff has no vertical scrollbar of its own (the ruler is it).
  expect(await viewer.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".vw-changes .gr-scroll")!;
    return [el.classList.contains("ruled"), el.offsetWidth - el.clientWidth];
  })).toEqual([true, 0]);
  await expect(changes.getByTestId("overview-ruler")).toBeVisible();

  // Ctrl+F in Review: the matches of the rows' text, the current one made the active line.
  await viewer.keyboard.press("Control+f");
  const find = changes.getByTestId("find-bar");
  await find.getByTestId("find-input").fill("tuned rate");
  await expect(find.getByTestId("find-count")).toHaveText(/共 2 个/);
  await find.getByTestId("find-input").press("Enter");
  await expect(changes.locator(".gr-line.active")).toContainText("tuned rate");
  await find.getByTestId("find-input").press("Escape");
  await expect(find).toHaveCount(0);

  // Back in 文件: Ctrl+F finds in the whole file (rows not drawn yet too), Ctrl+G goes to a line.
  await viewer.getByTestId("viewer-mode-file").click();
  await viewer.keyboard.press("Control+f");
  const fileFind = viewer.locator(".vw-review").getByTestId("find-bar");
  await fileFind.getByTestId("find-input").fill("value_39 =");
  await expect(fileFind.getByTestId("find-count")).toHaveText(/共 1 个/);
  await expect(code.locator(".gr-line.active")).toHaveAttribute("data-line", "new:39");
  expect(await inView(viewer, '.vw-review [data-line="new:39"]')).toBe(true);
  await screenshot(app, "stage-14", "S14-A-find", viewer, "viewer");
  await fileFind.getByTestId("find-input").press("Escape");
  await viewer.keyboard.press("Control+g");
  await viewer.getByTestId("goto-input").fill("250");
  await viewer.getByTestId("goto-input").press("Enter");
  await expect(code.locator(".gr-line.active")).toHaveAttribute("data-line", "new:250");
  expect(await inView(viewer, '.vw-review [data-line="new:250"]')).toBe(true);

  // 发给会话: both comments (written in 文件 and edited in 改动) go to the conversation as one message.
  await viewer.locator(".vw-review").getByTestId("review-send").click();
  await expect
    .poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).some((i) => i.type === "user" && i.text.startsWith("文件批注：") && i.text.includes("big.lua:335")))
    .toBe(true);
  await expect(viewer.locator(".vw-review").getByTestId("review-send")).toHaveCount(0);
});
