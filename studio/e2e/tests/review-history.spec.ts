import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, studioRoot, type Studio } from "./studio.js";

// S13-B: the Review window draws long diffs in chunks (smooth resizing), shows an overview ruler beside the scrollbar,
// and lists the branch's commits; a commit opens in a window of its own, read-only.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

const LINES = 600;
const base = Array.from({ length: LINES }, (_, i) => `    public int Field${i} = ${i};`);

async function openReview(s: Studio, workspaceId: string): Promise<Page> {
  const opened = s.app.waitForEvent("window");
  await s.page.evaluate((id) => (window as unknown as { amo: { openReview(t: { workspaceId: string }): Promise<void> } }).amo.openReview({ workspaceId: id }), workspaceId);
  const review = await opened;
  await review.waitForLoadState("domcontentloaded");
  return review;
}

test("long diffs come in chunks, with an overview ruler that jumps to the changes", async () => {
  studio = await launchStudio();
  const dir = studio.workspace("big");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "Big.cs"), base.join("\n") + "\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  // An added line near the top, a changed one in the middle, a removed one near the end.
  const next = [...base];
  next[500] = "    public int Field500 = -1;";
  next.splice(580, 1);
  next.splice(20, 0, "    public int Added = 1;");
  writeFileSync(join(dir, "Big.cs"), next.join("\n") + "\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });

  const review = await openReview(studio, ws.id);
  await review.getByRole("button", { name: "完整文件" }).click();
  // Drawn in chunks the browser may skip while off screen; since 2026-10-20 only the chunks near the view have their
  // rows at all, the others are empty boxes as tall as they would be.
  const chunks = review.locator(".gr-chunk");
  await expect(chunks).toHaveCount(Math.ceil((LINES + 2) / 64));
  await expect(review.getByTestId("diff-line").first()).toBeVisible();
  expect(await review.getByTestId("diff-line").count()).toBeLessThan(LINES + 2);
  expect(await review.locator(".gr-chunk.far").count()).toBeGreaterThan(0);
  expect(await chunks.first().evaluate((c) => getComputedStyle(c).contentVisibility)).toBe("auto");

  // One mark a change: added (green) near the top, modified (yellow) and deleted (red) further down.
  const ruler = review.getByTestId("overview-ruler");
  const marks = ruler.getByTestId("ruler-mark");
  await expect(marks).toHaveCount(3);
  await expect(marks.nth(0)).toHaveAttribute("data-kind", "add");
  await expect(marks.nth(1)).toHaveAttribute("data-kind", "mod");
  await expect(marks.nth(2)).toHaveAttribute("data-kind", "del");
  const tops = await marks.evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetTop));
  const height = await ruler.evaluate((r) => r.clientHeight);
  expect(tops[0]! / height).toBeLessThan(0.1);
  expect(tops[1]! / height).toBeGreaterThan(0.7);
  expect(tops[2]! / height).toBeGreaterThan(tops[1]! / height);

  // A click on the modified mark scrolls there: the changed line comes on screen, and the view box follows.
  const scroller = review.locator(".gr-scroll");
  expect(await scroller.evaluate((s) => s.scrollTop)).toBe(0);
  const box = await marks.nth(1).boundingBox();
  await review.mouse.click(box!.x + box!.width / 2, box!.y + 1);
  await expect.poll(() => scroller.evaluate((s) => s.scrollTop)).toBeGreaterThan(0);
  await expect(review.locator('[data-line="new:502"]')).toBeInViewport();
  await expect.poll(async () => (await review.getByTestId("ruler-view").boundingBox())!.y).toBeGreaterThan(box!.y - 200);
  await screenshot(studio.app, "stage-13", "S13-B-ruler", review, "review");

  // Side by side: the same three runs (the changed line pairs its old and new halves).
  await review.getByRole("button", { name: "左右对照" }).click();
  await expect(marks).toHaveCount(3);
  await expect(marks.nth(1)).toHaveAttribute("data-kind", "mod");
  // 只看改动: hunks only, still three marks.
  await review.getByRole("button", { name: "只看改动" }).click();
  await expect(review.getByTestId("diff-hunk")).toHaveCount(3);
  await expect(marks).toHaveCount(3);
});

/** Saves a PNG of the window whose address contains `part` (the shared helper takes the first review window). */
async function shoot(s: Studio, page: Page, part: string, name: string): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const base64 = await s.app.evaluate(async ({ BrowserWindow }, p) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p))!;
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  }, part);
  const file = join(studioRoot, "screenshots", "stage-13", `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(base64, "base64"));
}

const reviewWindows = (s: Studio) => s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()).filter((u) => u.includes("#review")));

test("历史 lists the branch's commits; one opens read-only in a window of its own", async () => {
  studio = await launchStudio();
  const dir = studio.workspace("game");
  const as = (who: string, ...args: string[]) => git(dir, "-c", `user.name=${who}`, "-c", `user.email=${who.toLowerCase()}@test.invalid`, ...args);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.1\nreturn rate\n");
  git(dir, "add", ".");
  as("Alice", "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.25\nreturn rate\n");
  writeFileSync(join(dir, "feature.lua"), "return { on = true }\n");
  git(dir, "add", ".");
  as("Bob", "commit", "-q", "-m", "tune drop rate");
  writeFileSync(join(dir, "README.md"), "# 掉落\n");
  git(dir, "add", ".");
  as("Alice", "commit", "-q", "-m", "docs: 说明");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.3\nreturn rate\n");
  const tune = git(dir, "rev-parse", "HEAD~1").trim();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });

  const review = await openReview(studio, ws.id);
  await expect(review.getByTestId("review-file")).toHaveCount(1);
  await review.getByTestId("review-history").click();
  const picker = review.getByTestId("commit-picker");
  const rows = picker.getByTestId("commit-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("docs: 说明");
  await expect(rows.nth(1)).toContainText("tune drop rate");
  await expect(rows.nth(1)).toContainText("Bob");
  await expect(rows.nth(2)).toContainText("base");
  await expect(picker).toContainText("main 最近 3 个提交");
  // One box for subject, hash and author.
  await picker.getByRole("textbox", { name: "搜索提交" }).fill("bob");
  await expect(rows).toHaveCount(1);
  await picker.getByRole("textbox", { name: "搜索提交" }).fill(tune.slice(0, 6));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-sha", tune);
  await picker.getByRole("textbox", { name: "搜索提交" }).fill("drop");
  await expect(rows).toHaveCount(1);
  await shoot(studio, review, "#review?workspace", "S13-B-history");

  // Enter opens the commit in another window; the working-tree review stays as it was.
  const opened = studio.app.waitForEvent("window");
  await review.keyboard.press("Enter");
  const shown = await opened;
  await shown.waitForLoadState("domcontentloaded");
  await expect(picker).toHaveCount(0);
  expect(shown.url()).toContain(`#review?workspace=${ws.id}&commit=${tune}`);
  await expect.poll(() => shown.title()).toContain(`提交 ${tune.slice(0, 7)} · tune drop rate`);
  await expect(shown.getByTestId("review-commit")).toContainText("tune drop rate");
  await expect(shown.getByTestId("review-commit")).toContainText("Bob");
  const files = shown.getByTestId("review-file");
  await expect(files).toHaveCount(2);
  await expect(files.nth(0)).toContainText("drop.lua");
  await expect(files.nth(0)).toContainText("+1 −1");
  await expect(files.nth(1)).toContainText("feature.lua");
  // The commit's own change (0.1 → 0.25), not the working tree's (0.3); read-only: no "+", no send bar.
  await expect(shown.locator('[data-line="new:1"]')).toContainText("local rate = 0.25");
  await expect(shown.locator('[data-line="old:1"]')).toContainText("local rate = 0.1");
  await expect(shown.getByTestId("add-comment")).toHaveCount(0);
  await expect(shown.getByTestId("review-send")).toHaveCount(0);
  await expect(shown.getByRole("group", { name: "对比范围" })).toHaveCount(0);
  await expect(shown.getByTestId("ruler-mark")).toHaveCount(1);
  await files.nth(1).click();
  await expect(shown.locator('[data-line="new:1"]')).toContainText("return { on = true }");
  await shoot(studio, shown, "&commit=", "S13-B-commit");
  expect(await reviewWindows(studio)).toHaveLength(2);
  await expect(review.getByTestId("review-send")).toBeVisible();

  // The same commit again: that window, not another; a name that is not a commit opens nothing.
  await studio.page.evaluate(
    ({ id, sha }) => (window as unknown as { amo: { openReview(t: { workspaceId: string; commit?: string }): Promise<void> } }).amo.openReview({ workspaceId: id, commit: sha }),
    { id: ws.id, sha: tune },
  );
  await studio.page.evaluate((id) => (window as unknown as { amo: { openReview(t: { workspaceId: string; commit?: string }): Promise<void> } }).amo.openReview({ workspaceId: id, commit: "HEAD~1" }), ws.id);
  await studio.page.waitForTimeout(300);
  expect(await reviewWindows(studio)).toHaveLength(2);
});

test("历史 opened from a commit's window marks that commit [CURRENT] and starts the list there; a pick switches the window, a right click opens a new one (2026-10-16)", async () => {
  studio = await launchStudio();
  const dir = studio.workspace("game");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  for (let i = 1; i <= 60; i++) {
    writeFileSync(join(dir, "log.txt"), `step ${i}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `step ${i}`);
  }
  const old = git(dir, "rev-parse", "HEAD~44").trim(); // "step 16", far down the list
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });

  // The working tree's window: nothing is current.
  const review = await openReview(studio, ws.id);
  await review.getByTestId("review-history").click();
  await expect(review.getByTestId("commit-row").first()).toContainText("step 60");
  await expect(review.getByTestId("commit-current")).toHaveCount(0);
  await review.keyboard.press("Escape");

  // A commit's window: its row is marked, highlighted and scrolled into the list.
  const opened = studio.app.waitForEvent("window");
  await studio.page.evaluate(
    ({ id, sha }) => (window as unknown as { amo: { openReview(t: { workspaceId: string; commit?: string }): Promise<void> } }).amo.openReview({ workspaceId: id, commit: sha }),
    { id: ws.id, sha: old },
  );
  const shown = await opened;
  await expect(shown.getByTestId("review-commit")).toContainText("step 16");
  await shown.getByTestId("review-history").click();
  const picker = shown.getByTestId("commit-picker");
  const current = picker.locator(`[data-testid="commit-row"][data-sha="${old}"]`);
  await expect(current).toContainText("[CURRENT]");
  await expect(current).toHaveClass(/current/);
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByTestId("commit-current")).toHaveCount(1);
  await expect
    .poll(() =>
      current.evaluate((row) => {
        const list = row.closest<HTMLElement>(".file-picker-list")!.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        // In the middle part of the list, not just peeking in at an edge.
        return r.top >= list.top + list.height / 4 && r.bottom <= list.bottom - list.height / 4;
      }),
    )
    .toBe(true);
  await shoot(studio, shown, "&commit=", "history-current");
  // Searching moves the highlight as before; the mark stays on its row.
  await picker.getByRole("textbox", { name: "搜索提交" }).fill("step 1");
  await expect(picker.getByTestId("commit-row").first()).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("textbox", { name: "搜索提交" }).fill("step 16");
  await expect(current).toContainText("[CURRENT]");

  // A pick in a commit's window switches that window; a right click opens a new one.
  const step = (n: number) => git(dir, "rev-parse", `HEAD~${60 - n}`).trim();
  await picker.getByRole("textbox", { name: "搜索提交" }).fill("");
  await expect(picker).toContainText("回车在本窗口切换 · 右键在新窗口打开");
  const before = (await reviewWindows(studio)).length;
  await picker.locator(`[data-testid="commit-row"][data-sha="${step(17)}"]`).click();
  await expect(shown.getByTestId("review-commit")).toContainText("step 17");
  expect(shown.url()).toContain(`&commit=${step(17)}`);
  expect(await reviewWindows(studio)).toHaveLength(before);
  await shown.getByTestId("review-history").click();
  await expect(picker.locator(`[data-testid="commit-row"][data-sha="${step(17)}"]`)).toContainText("[CURRENT]");
  const another = studio.app.waitForEvent("window");
  await picker.locator(`[data-testid="commit-row"][data-sha="${step(10)}"]`).click({ button: "right" });
  const fresh = await another;
  await expect(fresh.getByTestId("review-commit")).toContainText("step 10");
  await expect(picker).toHaveCount(0);
  await expect(shown.getByTestId("review-commit")).toContainText("step 17");
  expect(await reviewWindows(studio)).toHaveLength(before + 1);
  // The switched window now counts as step 17's: opening step 17 again opens nothing new.
  await studio.page.evaluate(
    ({ id, sha }) => (window as unknown as { amo: { openReview(t: { workspaceId: string; commit?: string }): Promise<void> } }).amo.openReview({ workspaceId: id, commit: sha }),
    { id: ws.id, sha: step(17) },
  );
  await studio.page.waitForTimeout(300);
  expect(await reviewWindows(studio)).toHaveLength(before + 1);
});

test("keys of the review: l / ; step through the file's changes, h opens 历史 where j / k pick (2026-10-16)", async () => {
  studio = await launchStudio();
  const dir = studio.workspace("keys");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "Big.cs"), base.join("\n") + "\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "notes.md"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "notes");
  // Three changes far apart in the working tree.
  const next = [...base];
  next[500] = "    public int Field500 = -1;";
  next.splice(580, 1);
  next.splice(20, 0, "    public int Added = 1;");
  writeFileSync(join(dir, "Big.cs"), next.join("\n") + "\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });

  const review = await openReview(studio, ws.id);
  await expect(review.getByTestId("review-file-head")).toContainText("Big.cs");
  await expect(review.locator('[data-line="new:21"]')).toContainText("Added = 1");
  const active = review.locator(".gr-line.active");
  const row = async () => Number(await active.getAttribute("data-row"));
  // l on to the next change, ; back, like j / k between files.
  await review.locator("body").press("l");
  await expect(active).toContainText("Added = 1");
  const first = await row();
  await review.locator("body").press("l");
  await expect(active).toContainText("Field500 = 500");
  expect(await row()).toBeGreaterThan(first);
  await review.locator("body").press(";");
  await expect(active).toContainText("Added = 1");
  expect(await row()).toBe(first);

  // w / s: the file a page up / down; a / d: 只看改动 / 完整文件, the keys shown on the buttons and under the files (2026-10-22).
  await expect(review.getByTestId("review-keys")).toContainText("W / S 上下翻页，A 只看改动，D 完整文件，E 单栏 / 左右对照，Q 切换范围，R 刷新，H 历史");
  await expect(review.getByRole("button", { name: "只看改动" }).locator("kbd")).toHaveText("A");
  await expect(review.getByRole("button", { name: "完整文件" }).locator("kbd")).toHaveText("D");
  await expect(review.getByTestId("review-history").locator("kbd")).toHaveText("H");
  // Either case (2026-10-23): D as Caps Lock or Shift gives it.
  await review.locator("body").press("Shift+D");
  await expect(review.getByRole("button", { name: "完整文件" })).toHaveAttribute("aria-pressed", "true");
  await expect(review.getByTestId("diff-hunk")).toHaveCount(0);
  const scroll = review.locator(".gr-scroll");
  const top = () => scroll.evaluate((el) => el.scrollTop);
  await scroll.evaluate((el) => (el.scrollTop = 0));
  await review.locator("body").press("s");
  await expect.poll(top).toBeGreaterThan(100);
  const paged = await top();
  await review.locator("body").press("s");
  await expect.poll(top).toBeGreaterThan(paged);
  await review.locator("body").press("w");
  await review.locator("body").press("w");
  await expect.poll(top).toBe(0);
  await review.locator("body").press("a");
  await expect(review.getByRole("button", { name: "只看改动" })).toHaveAttribute("aria-pressed", "true");
  await expect(review.getByTestId("diff-hunk")).not.toHaveCount(0);
  await screenshot(studio.app, "stage-18", "S18-review-keys", review, "review");

  // h: 历史 with the list taking the keys, not the search box.
  await review.locator("body").press("h");
  const picker = review.getByTestId("commit-picker");
  const rows = picker.getByTestId("commit-row");
  const search = picker.getByRole("textbox", { name: "搜索提交" });
  await expect(rows).toHaveCount(2);
  await expect(search).not.toBeFocused();
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await review.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await review.keyboard.press("k");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveValue("");
  // The review behind does not move meanwhile.
  await expect(review.getByTestId("review-file-head")).toContainText("Big.cs");
  await expect(active).toContainText("Added = 1");
  // h again closes it; any other letter starts a search, the next ones go on in the box.
  await review.keyboard.press("h");
  await expect(picker).toHaveCount(0);
  await review.locator("body").press("h");
  await review.keyboard.press("n");
  await expect(search).toBeFocused();
  await review.keyboard.type("o");
  await expect(search).toHaveValue("no");
  await expect(rows).toHaveCount(1);
  await review.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  // j / k and Space (like Enter, 2026-10-22): the picked commit opens in its own window.
  await review.locator("body").press("h");
  await expect(rows).toHaveCount(2);
  await expect(picker).toContainText("空格同回车");
  await review.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  const opened = studio.app.waitForEvent("window");
  await review.keyboard.press(" ");
  const shown = await opened;
  await shown.waitForLoadState("domcontentloaded");
  await expect(shown.getByTestId("review-commit")).toContainText("base");
});
