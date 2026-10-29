import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-10-29 (the user: 书签's title bar was still Windows'; every window in AMO's style): 书签, the 画布小窗, Git
// Review and the viewer have no system title bar; a head row of the page drags the window and ends with the page's
// own window buttons (the 画布小窗: 最小化 and 关闭 only), which act on that window. Light and dark screenshots of each.

let studio: Studio | undefined;
test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

type Kind = "marks" | "canvas-mini" | "review" | "viewer";
/** What the pages ask Studio's preload for, here. */
type AmoWindow = {
  amo: {
    openMarks(t: object): Promise<void>;
    openCanvasMini(t: { topicId: string }): Promise<void>;
    openReview(t: { workspaceId: string }): Promise<void>;
    openViewer(t: { path: string; workspaceId: string }): Promise<void>;
  };
};

/** The window of `kind` has no system title bar: its content fills it (no caption above the page). */
function captionHeight(app: ElectronApplication, kind: Kind) {
  return app.evaluate(({ BrowserWindow }, part) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(`#${part}`))!;
    return win.getBounds().height - win.getContentBounds().height;
  }, kind);
}

async function opened(app: ElectronApplication, open: () => Promise<unknown>): Promise<Page> {
  const next = app.waitForEvent("window");
  await open();
  const win = await next;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

/** The head row is the title bar: it drags the window, its buttons do not; the window buttons at its right end. */
async function expectTitleBar(win: Page, head: string, buttons: string[]) {
  const bar = win.locator(head);
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("drag");
  const controls = bar.getByTestId("win-controls");
  await expect(controls).toHaveCount(1);
  await expect(controls.getByRole("button")).toHaveCount(buttons.length);
  for (const name of buttons) await expect(controls.getByRole("button", { name, exact: true })).toBeVisible();
  expect(await controls.getByRole("button").first().evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
  // At the window's top right corner.
  const box = (await controls.boundingBox())!;
  const width = await win.evaluate(() => document.documentElement.clientWidth);
  expect(Math.round(box.x + box.width)).toBe(width);
  expect(Math.round(box.y)).toBe(0);
}

async function shoot(app: ElectronApplication, win: Page, kind: Kind, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await win.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await screenshot(app, "studio", `titlebar-${name}-${theme}`, win, kind);
  }
  await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

test("书签, 画布小窗, Git Review and the viewer draw their own title bars and window buttons", async () => {
  studio = await launchStudio();
  const s = studio;
  const { app, page } = s;
  const dir = s.workspace("game");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.1\nreturn rate\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.25\nreturn rate\n");
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const topic = await s.api<Topic>("POST", "/api/topics", { title: "掉落调整" });

  // 书签.
  const marks = await opened(app, () => page.evaluate(() => (window as unknown as AmoWindow).amo.openMarks({})));
  await expect(marks.locator(".mk-title")).toHaveText("书签");
  await expectTitleBar(marks, ".mk-head", ["最小化", "最大化", "关闭"]);
  expect(await captionHeight(app, "marks")).toBe(0);
  await expect(marks).toHaveTitle("书签");
  await shoot(app, marks, "marks", "marks");

  // 画布小窗: not maximisable, so no 最大化.
  const mini = await opened(app, () => page.evaluate((id) => (window as unknown as AmoWindow).amo.openCanvasMini({ topicId: id }), topic.id));
  await expect(mini.getByTestId("canvas-mini")).toBeVisible();
  await expectTitleBar(mini, ".canvas-mini-bar", ["最小化", "关闭"]);
  expect(await captionHeight(app, "canvas-mini")).toBe(0);
  await expect(mini).toHaveTitle("画布小窗 · 掉落调整");
  await shoot(app, mini, "canvas-mini", "canvas-mini");

  // Git Review.
  const review = await opened(app, () => page.evaluate((id) => (window as unknown as AmoWindow).amo.openReview({ workspaceId: id }), ws.id));
  await expect(review.getByTestId("review-file")).toHaveCount(1);
  await expectTitleBar(review, ".gr-head", ["最小化", "最大化", "关闭"]);
  expect(await captionHeight(app, "review")).toBe(0);
  await expect(review).toHaveTitle("Git Review · game");
  await shoot(app, review, "review", "review");

  // The viewer; in 改动 mode the Review inside it has no buttons of its own (one set, the viewer's).
  const viewer = await opened(app, () => page.evaluate(([path, id]) => (window as unknown as AmoWindow).amo.openViewer({ path: path!, workspaceId: id! }), [join(dir, "drop.lua"), ws.id]));
  await expect(viewer.getByTestId("viewer-name")).toHaveText("drop.lua");
  await expectTitleBar(viewer, ".vw-head", ["最小化", "最大化", "关闭"]);
  expect(await captionHeight(app, "viewer")).toBe(0);
  await expect(viewer).toHaveTitle("drop.lua · 查看器");
  await shoot(app, viewer, "viewer", "viewer");
  await viewer.getByTestId("viewer-mode-changes").click();
  await expect(viewer.getByTestId("review-file")).toHaveCount(1);
  await expect(viewer.getByTestId("win-controls")).toHaveCount(1);

  // × closes that window (only the workbench's hides it); the others stay.
  const closed = marks.waitForEvent("close");
  await marks.getByTestId("win-controls").getByRole("button", { name: "关闭" }).click();
  await closed;
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("#marks")))).toBe(false);
  await expect(review.getByTestId("win-controls")).toBeVisible();
  // 最小化 acts on the window that asked, not on the workbench.
  await mini.getByTestId("win-controls").getByRole("button", { name: "最小化" }).click();
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => [w.webContents.getURL().includes("#canvas-mini") ? "mini" : w.webContents.getURL().includes("#") ? "other" : "main", w.isMinimized()] as const)))
    .toContainEqual(["mini", true]);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes("#"))!.isMinimized())).toBe(false);
});
