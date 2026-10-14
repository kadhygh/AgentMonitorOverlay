import { expect, test, type Page } from "@playwright/test";
import type { Scratchpad, Session, StudioSettings, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

// 便签 (S11-C, S14-B): the scratchpad window opened from the title bar, its pages, pasted images, 复制 and its line
// breaks, and 设置 → 便签 (page count, line breaks, the global shortcut). The task page no longer shows it. Tests never register real global keys: the app records what it would register.

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

const copied = (s: Studio) => s.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1) ?? null);

test("the scratchpad window: pages, pasted images, 复制, and 设置 → 便签 (page count, line breaks, shortcut)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表", workspaceId: ws.id, firstSession: { profileId: "codex-mock" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByRole("complementary", { name: "批注" })).toBeVisible();

  // S14-B: the task page's right column has no scratchpad any more. The default shortcut is registered at start.
  await expect(page.getByRole("region", { name: "便签" })).toHaveCount(0);
  await expect(page.getByTestId("scratchpad-preview")).toHaveCount(0);
  await expect.poll(() => registered(studio!)).toBe("Ctrl+Alt+Space");

  // The title bar's 便签 opens the window.
  const opened = app.waitForEvent("window");
  await page.getByTestId("open-scratchpad").click();
  const pad = await opened;
  await pad.waitForLoadState("domcontentloaded");
  // Red line 7 and the window's nature: off-screen in tests, never focused, on top.
  await expect.poll(() => windowState(app, "scratchpad")).toMatchObject({ visible: true, onScreen: false, anyFocused: false, focusable: false, alwaysOnTop: true });
  // Its title has the scratchpad's mark (S14-B); the page count is no longer in the window.
  await expect(pad.locator(".pad-head .pad-name svg.pad-mark")).toBeVisible();
  await expect(pad.getByRole("button", { name: "增加页数" })).toHaveCount(0);

  // Typing saves.
  const text = pad.getByRole("textbox", { name: "便签内容" });
  await text.fill("回复要点：  \n- 掉落表按权重\n- 周五发版\n\n");
  await expect(pad.getByTestId("pad-status")).toContainText("已保存");

  // Another page, by its number; Ctrl+1 goes back.
  await pad.getByRole("button", { name: "第 2 页" }).click();
  await expect(text).toHaveValue("");
  await text.fill("第二页");
  await expect(pad.getByTestId("pad-status")).toContainText("已保存");
  await pad.keyboard.press("Control+1");
  await expect(text).toHaveValue("回复要点：  \n- 掉落表按权重\n- 周五发版\n\n");
  await expect(pad.getByRole("button", { name: "第 2 页" })).toHaveAttribute("data-filled", "");
  expect((await studio.api<Scratchpad>("GET", "/api/scratchpad")).activePage).toBe(0);

  // A pasted image joins the page as a thumbnail; the text stays as it was.
  await pasteImage(pad, "截图 1");
  await expect(pad.getByTestId("pad-image")).toHaveCount(1);
  await pasteImage(pad, "截图 2");
  await expect(pad.getByTestId("pad-image")).toHaveCount(2);
  expect((await studio.api<Scratchpad>("GET", "/api/scratchpad")).pages[0]!.attachments).toHaveLength(2);
  await expect.poll(() => pad.getByTestId("pad-image").first().locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160);
  await screenshot(app, "stage-14", "S14-B-scratchpad-window", pad, "scratchpad");

  // Larger view; Esc closes the picture, not the window. × takes an image off the page.
  await pad.getByRole("button", { name: "看大图 1" }).click();
  await expect(pad.getByTestId("pad-viewer")).toBeVisible();
  await pad.keyboard.press("Escape");
  await expect(pad.getByTestId("pad-viewer")).toHaveCount(0);
  expect(await padVisible(studio)).toBe(true);
  await pad.getByTestId("pad-image").nth(1).hover();
  await pad.getByRole("button", { name: "移除图片 2" }).click();
  await expect(pad.getByTestId("pad-image")).toHaveCount(1);

  // 复制 by default keeps the lines (Windows line breaks, trailing spaces and blank lines dropped) and hides the window.
  await pad.getByRole("button", { name: "复制", exact: true }).click();
  await expect.poll(() => copied(studio!)).toBe("回复要点：\r\n- 掉落表按权重\r\n- 周五发版");
  await expect.poll(() => padVisible(studio!)).toBe(false);

  // 设置 → 便签: the page count, the line breaks and the shortcut.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "便签" }).click();
  const pages = dialog.getByRole("region", { name: "便签页数" });
  await expect(pages.getByTestId("pad-page-count")).toHaveText("3");
  // Not in a plain browser: the page itself is edited in the scratchpad window, not here.
  await expect(dialog.getByRole("region", { name: "便签内容" })).toHaveCount(0);

  // More pages, then fewer; a hidden page keeps its content and comes back.
  await pages.getByRole("button", { name: "增加页数" }).click();
  await expect(pages.getByTestId("pad-page-count")).toHaveText("4");
  await expect(pad.getByTestId("pad-page")).toHaveCount(4);
  for (const n of ["3", "2", "1"]) {
    await pages.getByRole("button", { name: "减少页数" }).click();
    await expect(pages.getByTestId("pad-page-count")).toHaveText(n);
  }
  await expect(pages.getByRole("button", { name: "减少页数" })).toBeDisabled();
  await expect(pad.getByTestId("pad-page")).toHaveCount(1);
  expect((await studio.api<Scratchpad>("GET", "/api/scratchpad")).keptPages).toEqual([2]);
  await expect(pages.getByTestId("pad-kept-pages")).toHaveText("第 2 页还有内容，现在藏着。");
  await pages.getByRole("button", { name: "增加页数" }).click();
  await expect(pages.getByTestId("pad-kept-pages")).toHaveCount(0);
  await expect(pad.getByTestId("pad-page")).toHaveCount(2);

  // 复制时的换行: 常规 by default; 安全换行 joins the lines into one.
  const newlines = dialog.getByRole("radiogroup", { name: "复制时的换行" });
  await expect(newlines.getByTestId("pad-newlines-normal")).toHaveAttribute("aria-checked", "true");
  await newlines.getByTestId("pad-newlines-safe").click();
  await expect(newlines.getByTestId("pad-newlines-safe")).toHaveAttribute("aria-checked", "true");
  expect((await studio.api<StudioSettings>("GET", "/api/settings")).scratchpadSafeNewlines).toBe(true);
  await screenshot(app, "stage-14", "S14-B-scratchpad-settings", page);

  // The shortcut hides and shows the window; 复制 now gives one line; Esc hides it; the title bar's 便签 brings it back
  // (the same window).
  await toggle(studio);
  await expect.poll(() => padVisible(studio!)).toBe(true);
  await pad.getByRole("button", { name: "第 2 页" }).click();
  await expect(text).toHaveValue("第二页");
  await pad.keyboard.press("Control+1");
  await expect(text).toHaveValue(/^回复要点/);
  await pad.getByRole("button", { name: "复制", exact: true }).click();
  await expect.poll(() => copied(studio!)).toBe("回复要点： - 掉落表按权重 - 周五发版");
  await expect.poll(() => padVisible(studio!)).toBe(false);
  await toggle(studio);
  await expect.poll(() => padVisible(studio!)).toBe(true);
  await toggle(studio);
  await expect.poll(() => padVisible(studio!)).toBe(false);
  await toggle(studio);
  await expect.poll(() => padVisible(studio!)).toBe(true);
  await pad.keyboard.press("Escape");
  await expect.poll(() => padVisible(studio!)).toBe(false);
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await page.getByTestId("open-scratchpad").click();
  await expect.poll(() => padVisible(studio!)).toBe(true);
  expect(app.windows().filter((w) => w.url().endsWith("#scratchpad"))).toHaveLength(1);

  // 设置 → 便签: press a new combination; a key another program holds is reported and the old one stays.
  await page.getByRole("button", { name: "设置" }).click();
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
  
  await dialog.getByRole("button", { name: "恢复默认" }).click();
  await expect(line).toHaveText("已生效：Ctrl + Alt + Space");
  expect(await registered(studio)).toBe("Ctrl+Alt+Space");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(field).toHaveValue("关闭");
  await expect(line).toContainText("快捷键已关闭");
  expect(await registered(studio)).toBe("");
});
