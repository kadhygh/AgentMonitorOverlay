import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { screenshot, studioRoot } from "./studio.js";

// AMO 便签 as a program of its own (2026-10-23): its window in the final look, its keys, its files in its home, its
// settings window, and only one running at a time.

const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;
const MAIN = join(studioRoot, "packages", "notes", "dist", "main.js");
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

/** The environment without anything a developer's shell or a Studio session put there. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC_|AMO_)/.test(k)) env[k] = v;
  return { ...env, AMO_NOTES_TEST: "1", AMO_NOTES_HOME: home };
}

let app: ElectronApplication | undefined;
let home = "";

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (home) removeTempDir(home);
});

async function launch(): Promise<{ app: ElectronApplication; pad: Page }> {
  home = mkdtempSync(join(tmpdir(), "amo-notes-e2e-"));
  app = await _electron.launch({ executablePath: electronPath, args: [MAIN], env: cleanEnv(home) });
  const pad = await app.firstWindow();
  await expect(pad.locator(".pad-root")).toBeVisible();
  return { app, pad };
}

const running = () => JSON.parse(readFileSync(join(home, "running.json"), "utf8")) as { url: string; token: string; pid: number };
const copied = (a: ElectronApplication) => a.evaluate(() => (globalThis as { __notesCopied?: string[] }).__notesCopied?.at(-1) ?? null);
const padVisible = (a: ElectronApplication) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("#scratchpad"))!.isVisible());

/** Pastes a small drawn PNG into the page, the way a screenshot from the clipboard arrives. */
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
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { url, token } = running();
  const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await res.json()) as T;
}

test("the window: an empty page lists its keys, typing saves to the work folder, Ctrl+Enter copies and hides", async () => {
  const { app, pad } = await launch();
  // An empty page: the keys, with the show / hide shortcut as bound.
  const keys = pad.getByTestId("pad-keys");
  await expect(keys).toContainText("复制这一页并隐藏");
  await expect(keys).toContainText("Ctrl Alt Space 随时叫回来");
  await expect(pad.getByTestId("pad-status")).toContainText("空白页");
  await expect(pad.getByRole("button", { name: "复制" })).toBeDisabled();
  await screenshot(app, "notes", "N1-empty", pad, "scratchpad");

  await pad.getByLabel("便签内容").fill("回复要点：\n- 掉落表按权重\n- 周五发版");
  await expect(keys).toHaveCount(0);
  await expect(pad.getByTestId("pad-status")).toContainText("已保存");
  expect(JSON.parse(readFileSync(join(home, "data", "pages.json"), "utf8")).pages[0].text).toContain("周五发版");
  await expect(pad.locator(".pad-hint")).toHaveText("Ctrl 1–3");
  await expect(pad.getByRole("button", { name: "复制" }).locator("kbd")).toHaveText("Ctrl ↵");
  await screenshot(app, "notes", "N2-page", pad, "scratchpad");

  // Ctrl+Enter: the page on the clipboard (recorded in tests), the window hidden.
  await pad.getByLabel("便签内容").press("Control+Enter");
  await expect.poll(() => copied(app)).toBe("回复要点：\r\n- 掉落表按权重\r\n- 周五发版");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false);
  // The shortcut brings it back (tests press it through the program).
  await app.evaluate(() => (globalThis as { __notesToggle?: () => void }).__notesToggle?.());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
  expect(await app.evaluate(() => (globalThis as { __notesShortcut?: string }).__notesShortcut)).toBe("Ctrl+Alt+Space");
});

test("one at a time: starting it again shows the running one and the second ends", async () => {
  const { app } = await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  const second = spawn(electronPath, [MAIN], { env: cleanEnv(home), stdio: "ignore", windowsHide: true });
  const code = await new Promise<number | null>((done) => second.on("exit", done));
  expect(code).toBe(0);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
  // Still the first one's server.
  expect(running().pid).toBe(await app.evaluate(() => process.pid));
});

test("the settings window: shortcut, start with Windows, the work folder, its size and cache", async () => {
  const { app, pad } = await launch();
  await pad.getByLabel("便签内容").fill("有一张图");
  await expect(pad.getByTestId("pad-status")).toContainText("已保存");
  // An image a page no longer holds is cache.
  const img = await fetch(`${running().url}/api/attachments?type=image/png&name=a.png`, { method: "POST", headers: { authorization: `Bearer ${running().token}`, "content-type": "image/png" }, body: PNG }).then((r) => r.json() as Promise<{ id: string }>);
  await api("PUT", "/api/scratchpad/pages/2", { attachments: [img.id] });
  await api("PUT", "/api/scratchpad/pages/2", { attachments: [] });

  const opened = app.waitForEvent("window");
  await app.evaluate(() => (globalThis as { __notesOpenSettings?: () => void }).__notesOpenSettings?.());
  const settings = await opened;
  await expect(settings.getByTestId("ns-folder")).toHaveText(join(home, "data"));
  await expect(settings.getByTestId("ns-cache")).not.toHaveText("0 B");
  await expect(settings.getByTestId("ns-shortcut-status")).toContainText("已生效：Ctrl + Alt + Space");
  await screenshot(app, "notes", "N3-settings", settings, "main");

  // A new shortcut, pressed in the field.
  await settings.getByTestId("ns-shortcut").focus();
  await settings.getByTestId("ns-shortcut").press("Control+Alt+KeyN");
  await expect(settings.getByTestId("ns-shortcut-status")).toContainText("已生效：Ctrl + Alt + N");
  expect(await app.evaluate(() => (globalThis as { __notesShortcut?: string }).__notesShortcut)).toBe("Ctrl+Alt+N");
  // The empty page's list follows it.
  await pad.getByLabel("便签内容").fill("");
  await pad.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(pad.getByTestId("pad-keys")).toContainText("Ctrl Alt N 随时叫回来");

  await settings.getByTestId("ns-login").check();
  await expect.poll(() => app.evaluate(() => (globalThis as { __notesOpenAtLogin?: boolean }).__notesOpenAtLogin)).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toMatchObject({ openAtLogin: true, shortcut: "Ctrl+Alt+N" });

  await settings.getByTestId("ns-clear-cache").click();
  await expect(settings.getByTestId("ns-cache")).toHaveText("0 B");
  await expect(settings.getByText(/清理了 /)).toBeVisible();

  // Moving the work folder (the picker is the system's; the route behind it here).
  const target = join(home, "elsewhere");
  mkdirSync(target);
  await api("POST", "/api/notes/folder", { path: target, move: true });
  await settings.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(settings.getByTestId("ns-folder")).toHaveText(target);
  expect(existsSync(join(target, "pages.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).workFolder).toBe(target);
});

test("pages from Studio come over once, with a notice in the window until it is closed", async () => {
  const { pad } = await launch();
  const imgPath = join(home, "from-studio.png");
  writeFileSync(imgPath, PNG);
  const id = "att-22222222-2222-4222-8222-222222222222";
  const r = await api<{ pages: number; images: number }>("POST", "/api/notes/import", { pages: [{ text: "Studio 的第一页", attachments: [id] }, { text: "", attachments: [] }, { text: "", attachments: [] }], pageCount: 3, activePage: 0, images: [{ id, name: "x.png", mime: "image/png", path: imgPath }] });
  expect(r).toEqual({ pages: 1, images: 1 });
  await pad.reload();
  await expect(pad.getByLabel("便签内容")).toHaveValue("Studio 的第一页");
  await expect(pad.getByTestId("pad-imported")).toContainText("已从 AMO Studio 搬过来");
  await expect(pad.getByTestId("pad-image")).toHaveCount(1);
  await pad.getByTestId("pad-imported").getByRole("button", { name: "知道了" }).click();
  await expect(pad.getByTestId("pad-imported")).toHaveCount(0);
  await pad.reload();
  await expect(pad.getByLabel("便签内容")).toHaveValue("Studio 的第一页");
  await expect(pad.getByTestId("pad-imported")).toHaveCount(0);
});

// Moved from Studio's own 便签 window (S11-C, S14-B; scratchpad.spec.ts) with the window itself.
test("pages, pasted images, 复制's line breaks, and the page count in the settings", async () => {
  const { app, pad } = await launch();
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
  expect((await api<{ activePage: number }>("GET", "/api/scratchpad")).activePage).toBe(0);

  // Pasted images join the page as thumbnails; the large view closes on Esc, not the window; × takes one off.
  await pasteImage(pad, "截图 1");
  await expect(pad.getByTestId("pad-image")).toHaveCount(1);
  await pasteImage(pad, "截图 2");
  await expect(pad.getByTestId("pad-image")).toHaveCount(2);
  await expect.poll(() => pad.getByTestId("pad-image").first().locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160);
  await screenshot(app, "notes", "N4-images", pad, "scratchpad");
  await pad.getByRole("button", { name: "看大图 1" }).click();
  await expect(pad.getByTestId("pad-viewer")).toBeVisible();
  await pad.keyboard.press("Escape");
  await expect(pad.getByTestId("pad-viewer")).toHaveCount(0);
  expect(await padVisible(app)).toBe(true);
  await pad.getByTestId("pad-image").nth(1).hover();
  await pad.getByRole("button", { name: "移除图片 2" }).click();
  await expect(pad.getByTestId("pad-image")).toHaveCount(1);

  // 复制 keeps the lines by default (Windows line breaks, trailing spaces and blank lines dropped) and hides.
  await pad.getByRole("button", { name: "复制" }).click();
  await expect.poll(() => copied(app)).toBe("回复要点：\r\n- 掉落表按权重\r\n- 周五发版");
  await expect.poll(() => padVisible(app)).toBe(false);

  // The settings: fewer pages hide the content beyond the count, more bring it back; 安全换行 copies one line.
  const opened = app.waitForEvent("window");
  await app.evaluate(() => (globalThis as { __notesOpenSettings?: () => void }).__notesOpenSettings?.());
  const settings = await opened;
  await expect(settings.getByTestId("ns-page-count")).toHaveText("3");
  for (const n of ["2", "1"]) {
    await settings.getByRole("button", { name: "减少一页" }).click();
    await expect(settings.getByTestId("ns-page-count")).toHaveText(n);
  }
  await expect(settings.getByText("第 2 页还有内容，现在藏着。")).toBeVisible();
  await expect(pad.getByTestId("pad-page")).toHaveCount(1);
  await settings.getByRole("button", { name: "增加一页" }).click();
  await expect(pad.getByTestId("pad-page")).toHaveCount(2);
  await settings.getByTestId("ns-newlines-safe").click();
  await expect(settings.getByTestId("ns-newlines-safe")).toHaveAttribute("aria-checked", "true");
  await app.evaluate(() => (globalThis as { __notesToggle?: () => void }).__notesToggle?.());
  await expect.poll(() => padVisible(app)).toBe(true);
  await pad.keyboard.press("Control+1");
  await pad.getByRole("button", { name: "复制" }).click();
  await expect.poll(() => copied(app)).toBe("回复要点： - 掉落表按权重 - 周五发版");
});
