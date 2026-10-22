import { expect, test } from "@playwright/test";
import type { GitChangedFile, GitChanges, GitFileDiff, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("keyboard file selection stays in view in large flat and tree lists, including distant lazy chunks", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("large-review");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const files: GitChangedFile[] = Array.from({ length: 600 }, (_, i) => ({
    path: `folder-${String(Math.floor(i / 30)).padStart(2, "0")}/File-${String(i).padStart(3, "0")}.cs`,
    status: "modified", additions: 1, deletions: 0, binary: false,
  }));
  // Only list scrolling is under test: fixed Git responses avoid spawning git for each of the many key presses.
  const changes: GitChanges = { range: "working", files, truncated: false, status: { repo: true, root: dir, branch: "main", head: "a".repeat(40), upstream: null, base: null, mergeBase: null } };
  await app.context().route(`**/api/workspaces/${ws.id}/git/changes?*`, (route) => route.fulfill({ json: changes }));
  await app.context().route(`**/api/workspaces/${ws.id}/git/log*`, (route) => route.fulfill({ json: { branch: "main", head: changes.status.head, commits: [], truncated: false } }));
  await app.context().route(`**/api/workspaces/${ws.id}/git/diff?*`, (route) => {
    const diff: GitFileDiff = { range: "working", path: new URL(route.request().url()).searchParams.get("path")!, binary: false, tooLarge: false, lines: [{ kind: "add", oldLine: null, newLine: 1, text: "public int Value = 1;" }], hunks: [{ start: 0, end: 1, oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }] };
    return route.fulfill({ json: diff });
  });
  const opened = app.waitForEvent("window");
  const openFile = (file: string) => page.evaluate((target) => (window as unknown as { amo: { openReview(t: unknown): Promise<void> } }).amo.openReview(target), { workspaceId: ws.id, file });
  await openFile(files[0]!.path);
  const review = await opened;
  await review.waitForLoadState("domcontentloaded");
  const list = review.getByRole("navigation", { name: "改动的文件", exact: true });
  const selected = list.locator('[data-testid="review-file"][aria-current="true"]');
  const press = async (key: string) => {
    // Let the previous selection's passive effects settle before sending the next native key event.
    await review.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await review.keyboard.press(key);
  };
  for (const layout of ["平铺", "目录树"]) {
    await review.getByRole("button", { name: layout, exact: true }).click();
    await openFile(files[0]!.path);
    await expect(selected).toHaveAttribute("title", files[0]!.path);
    await expect(selected).toBeInViewport({ ratio: 1 });
    const startingScroll = await list.evaluate((el) => el.scrollTop);
    for (let i = 1; i <= 45; i++) {
      await press(i % 2 ? "j" : "ArrowDown");
      await expect(selected).toHaveAttribute("title", files[i]!.path);
      if (i === 1) expect(await list.evaluate((el) => el.scrollTop)).toBe(startingScroll);
    }
    await expect(selected).toBeInViewport({ ratio: 1 });
    const down = await list.evaluate((el) => el.scrollTop);
    expect(down).toBeGreaterThan(0);
    for (let i = 44; i >= 0; i--) {
      await press(i % 2 ? "k" : "ArrowUp");
      await expect(selected).toHaveAttribute("title", files[i]!.path);
    }
    await expect(selected).toBeInViewport({ ratio: 1 });
    expect(await list.evaluate((el) => el.scrollTop)).toBeLessThan(down);

    // An externally selected file far beyond the first two chunks is drawn and revealed as well.
    await openFile(files[350]!.path);
    await expect(selected).toHaveAttribute("title", files[350]!.path);
    await expect(selected).toBeInViewport({ ratio: 1 });
    expect(await list.getByTestId("review-file").count()).toBeLessThan(files.length);
    await review.keyboard.press("j");
    await expect(selected).toHaveAttribute("title", files[351]!.path);
    await expect(selected).toBeInViewport({ ratio: 1 });
    await review.evaluate(() => {
      for (let i = 0; i < 8; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    await expect(selected).toHaveAttribute("title", files[359]!.path);
    await expect(selected).toBeInViewport({ ratio: 1 });
    if (layout === "目录树") {
      const nextFolder = list.locator('[data-testid="review-folder"][title="folder-12"]');
      await nextFolder.click();
      await expect(nextFolder).toHaveAttribute("aria-expanded", "false");
      await press("j");
      await expect(selected).toHaveAttribute("title", files[360]!.path);
      await expect(nextFolder).toHaveAttribute("aria-expanded", "true");
      await expect(selected).toBeInViewport({ ratio: 1 });
    }
    if (layout === "目录树") await screenshot(app, "stage-18", "S18-review-file-scroll", review, "review");
  }
});
