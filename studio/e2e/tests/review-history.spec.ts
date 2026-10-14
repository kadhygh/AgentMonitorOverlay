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
  await expect(review.getByTestId("diff-line")).toHaveCount(LINES + 2);
  // Drawn in chunks the browser may skip while off screen.
  const chunks = review.locator(".gr-chunk");
  expect(await chunks.count()).toBe(Math.ceil((LINES + 2) / 64));
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
