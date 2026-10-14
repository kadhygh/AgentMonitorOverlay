import { expect, test, type Page } from "@playwright/test";
import type { Scratchpad, Session, StudioSettings, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

// 便签 (S11-C): the scratchpad window opened from the task page, its pages, pasted images, the page count, the
// global shortcut and its setting. Tests never register real global keys: the app records what it would register.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** Pastes a small drawn PNG into the window's text, the way a screenshot from the clipboard arrives. */
async function pasteImage(pad: Page, label: string) {
  await pad.getByRole("textbox", { name: "便签内容" }).evaluate(async (el, text) => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#e4d6b8";
    g.fillRect(0, 0, 160, 100);
    g.fillStyle = "#22201c";
    g.font = "20px sans-serif";
    g.fillText(text, 16, 56);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "shot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, label);
}

const registered = (s: Studio) => s.app.evaluate(() => (globalThis as { __amoScratchpadShortcut?: string }).__amoScratchpadShortcut ?? "");
const toggle = (s: Studio) => s.app.evaluate(() => (globalThis as { __amoScratchpadToggle?: () => void }).__amoScratchpadToggle?.());
const padVisible = async (s: Studio) => (await windowState(s.app, "scratchpad")).visible;

test("the scratchpad window: pages, pasted images, page count, shortcut, and the task page's entry", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表", workspaceId: ws.id, firstSession: { profileId: "codex-mock" } });
  await page.getByTestId("task-card").first().click();

  // The right column's entry: the page the window shows, and 打开便签. The default shortcut is registered at start.
  const entry = page.getByRole("region", { name: "便签" });
  await expect(entry.getByTestId("scratchpad-page")).toHaveText("第 1 / 3 页");
  await expect(entry.getByTestId("scratchpad-preview")).toHaveText("这一页还是空的。");
  await expect.poll(() => registered(studio!)).toBe("Ctrl+Alt+Space");

  const opened = app.waitForEvent("window");
  await entry.getByRole("button", { name: "打开便签" }).click();
  const pad = await opened;
  await pad.waitForLoadState("domcontentloaded");
  // Red line 7 and the window's nature: off-screen in tests, never focused, on top.
  await expect.poll(() => windowState(app, "scratchpad")).toMatchObject({ visible: true, onScreen: false, anyFocused: false, focusable: false, alwaysOnTop: true });

  // Typing saves and the task page follows.
  const text = pad.getByRole("textbox", { name: "便签内容" });
  await text.fill("回复要点：\n- 掉落表按权重\n- 周五发版");
  await expect(pad.getByTestId("pad-status")).toContainText("已保存");
  await expect(entry.getByTestId("scratchpad-preview")).toHaveText("回复要点：\n- 掉落表按权重\n- 周五发版");

  // Another page, by its number; Ctrl+1 goes back. The task page shows whichever page the window shows.
  await pad.getByRole("button", { name: "第 2 页" }).click();
  await expect(text).toHaveValue("");
  await expect(entry.getByTestId("scratchpad-page")).toHaveText("第 2 / 3 页");
  await text.fill("第二页");
  await expect(pad.getByTestId("pad-status")).toContainText("已保存");
  await pad.keyboard.press("Control+1");
  await expect(text).toHaveValue("回复要点：\n- 掉落表按权重\n- 周五发版");
  await expect(entry.getByTestId("scratchpad-page")).toHaveText("第 1 / 3 页");
  await expect(pad.getByRole("button", { name: "第 2 页" })).toHaveAttribute("data-filled", "");

  // A pasted image joins the page as a thumbnail, in both windows; the text stays as it was.
  await pasteImage(pad, "截图 1");
  await expect(pad.getByTestId("pad-image")).toHaveCount(1);
  await expect(entry.getByTestId("pad-image")).toHaveCount(1);
  await expect(text).toHaveValue("回复要点：\n- 掉落表按权重\n- 周五发版");
  await pasteImage(pad, "截图 2");
  await expect(pad.getByTestId("pad-image")).toHaveCount(2);
  expect((await studio.api<Scratchpad>("GET", "/api/scratchpad")).pages[0]!.attachments).toHaveLength(2);
  await expect.poll(() => pad.getByTestId("pad-image").first().locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160);
  await screenshot(app, "stage-11", "S11-C-scratchpad-window", pad, "scratchpad");
  await screenshot(app, "stage-11", "S11-C-scratchpad-entry", page);

  // Larger view; Esc closes the picture, not the window. × takes an image off the page.
  await pad.getByRole("button", { name: "看大图 1" }).click();
  await expect(pad.getByTestId("pad-viewer")).toBeVisible();
  await screenshot(app, "stage-11", "S11-C-scratchpad-viewer", pad, "scratchpad");
  await pad.keyboard.press("Escape");
  await expect(pad.getByTestId("pad-viewer")).toHaveCount(0);
  expect(await padVisible(studio)).toBe(true);
  await pad.getByTestId("pad-image").nth(1).hover();
  await pad.getByRole("button", { name: "移除图片 2" }).click();
  await expect(pad.getByTestId("pad-image")).toHaveCount(1);
  await expect(entry.getByTestId("pad-image")).toHaveCount(1);

  // Page count: more pages, then fewer; a hidden page keeps its content and comes back.
  await pad.getByRole("button", { name: "增加页数" }).click();
  await expect(pad.getByTestId("pad-page-count")).toHaveText("4");
  await expect(pad.getByTestId("pad-page")).toHaveCount(4);
  await expect(entry.getByTestId("scratchpad-page")).toHaveText("第 1 / 4 页");
  for (const n of ["3", "2", "1"]) {
    await pad.getByRole("button", { name: "减少页数" }).click();
    await expect(pad.getByTestId("pad-page-count")).toHaveText(n);
  }
  await expect(pad.getByRole("button", { name: "减少页数" })).toBeDisabled();
  expect((await studio.api<Scratchpad>("GET", "/api/scratchpad")).keptPages).toEqual([2]);
  await pad.getByRole("button", { name: "增加页数" }).click();
  await pad.getByRole("button", { name: "第 2 页" }).click();
  await expect(text).toHaveValue("第二页");
  await pad.keyboard.press("Control+1");
  await expect(text).toHaveValue(/^回复要点/);

  // The shortcut hides and shows it; Esc hides it; 打开便签 brings it back (the same window).
  await toggle(studio);
  await expect.poll(() => padVisible(studio!)).toBe(false);
  await toggle(studio);
  await expect.poll(() => padVisible(studio!)).toBe(true);
  await pad.keyboard.press("Escape");
  await expect.poll(() => padVisible(studio!)).toBe(false);
  await entry.getByRole("button", { name: "打开便签" }).click();
  await expect.poll(() => padVisible(studio!)).toBe(true);
  expect(app.windows().filter((w) => w.url().endsWith("#scratchpad"))).toHaveLength(1);

  // 设置 → 便签: press a new combination; a key another program holds is reported and the old one stays.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "便签" }).click();
  const field = dialog.getByTestId("scratchpad-shortcut");
  const line = dialog.getByTestId("scratchpad-shortcut-status");
  await expect(field).toHaveValue("Ctrl + Alt + Space");
  await expect(line).toHaveText("已生效：Ctrl + Alt + Space");
  await field.click();
  await expect(field).toHaveValue("请按下新的组合键…");
  await page.keyboard.press("Control+Alt+KeyZ");
  await expect(field).toHaveValue("Ctrl + Alt + Z");
  await expect(line).toHaveText("已生效：Ctrl + Alt + Z");
  expect(await registered(studio)).toBe("Ctrl+Alt+Z");
  expect((await studio.api<StudioSettings>("GET", "/api/settings")).scratchpadShortcut).toBe("Ctrl+Alt+Z");

  await field.click();
  await page.keyboard.press("KeyQ");
  await expect(line).toContainText("需要 Ctrl、Alt 或 Win");
  await app.evaluate(() => ((globalThis as { __amoTakenShortcuts?: string[] }).__amoTakenShortcuts = ["Ctrl+Alt+X"]));
  await page.keyboard.press("Control+Alt+KeyX");
  await expect(line).toHaveText("「Ctrl+Alt+X」被其他程序占用了，仍在用「Ctrl+Alt+Z」");
  expect(await registered(studio)).toBe("Ctrl+Alt+Z");
  // The setting goes back to the key that works.
  await expect(field).toHaveValue("Ctrl + Alt + Z");
  await expect.poll(async () => (await studio!.api<StudioSettings>("GET", "/api/settings")).scratchpadShortcut).toBe("Ctrl+Alt+Z");
  await screenshot(app, "stage-11", "S11-C-scratchpad-settings", page);

  await dialog.getByRole("button", { name: "恢复默认" }).click();
  await expect(line).toHaveText("已生效：Ctrl + Alt + Space");
  expect(await registered(studio)).toBe("Ctrl+Alt+Space");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(field).toHaveValue("关闭");
  await expect(line).toContainText("快捷键已关闭");
  expect(await registered(studio)).toBe("");
});
