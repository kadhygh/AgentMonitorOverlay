/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import { screenshot, studioRoot } from "../support/studio.js";

// AMO 平台 (plans/amo-lan-platform.md, step 2) against testkit's fake team server: log in, install a stand-in tool
// (a .cmd, not a real build), a new version published → update, 回滚, 卸载; Studio only opens once its data dir is set.
// Everything under temp folders (AMO_HOME, AMO_LOCAL_HOME; the self-update tests unpack the platform there instead and
// point %LOCALAPPDATA% there): the real %APPDATA%\AMO and %LOCALAPPDATA%\AMO stay untouched.

const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;
const MAIN = join(studioRoot, "packages", "platform", "dist", "main.js");

/** A pretend tool: its "exe" is a .cmd that leaves a mark (with Studio's data dir, for Studio) and ends. */
const tool = (id: string, version: string, extra: Record<string, string> = {}) => ({
  "run.cmd": `@echo off\r\necho ${id} ${version} %AMO_STUDIO_DATA_DIR%>"%AMO_FAKE_TOOL_MARK%.${id}"\r\n`,
  "resources/app.txt": `${id} ${version}`,
  "resources/runtime.bin": "R".repeat(256 * 1024),
  "LICENSE.txt": "MIT",
  ...extra,
});

let server: FakePlatformServer;
let app: ElectronApplication | undefined;
let root = "";

test.beforeAll(async () => {
  // gzip: as the real server sends the objects it stores gzipped (2026-10-29).
  server = await startFakePlatformServer({ users: { 小王: "secret" }, gzip: true });
});
test.afterAll(() => server.close());
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root) removeTempDir(root);
});

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC_|AMO_)/.test(k)) env[k] = v;
  return { ...env, AMO_PLATFORM_TEST: "1", AMO_HOME: join(root, "roaming"), AMO_LOCAL_HOME: join(root, "local"), AMO_FAKE_TOOL_MARK: join(root, "launched") };
}

/**
 * `machine` lays out a pretend machine under the temp root and returns the environment that points at it. `again`
 * starts on the same machine as the last launch (its root kept), as a platform started a second time.
 */
async function launch(args: string[] = [], machine?: (root: string) => Record<string, string>, again = false): Promise<{ app: ElectronApplication; page: Page }> {
  if (!again || !root) root = mkdtempSync(join(tmpdir(), "amo-platform-e2e-"));
  app = await _electron.launch({ executablePath: electronPath, args: [MAIN, ...args], env: { ...cleanEnv(), ...machine?.(root) } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

const programs = () => JSON.parse(readFileSync(join(root, "roaming", "programs.json"), "utf8")) as { tools: Record<string, { version: string; dir: string; exe: string }> };
const row = (page: Page, id: string) => page.getByTestId(`tool-${id}`);
const status = (page: Page, id: string) => page.getByTestId(`tool-${id}-status`);
const result = (page: Page, id: string) => page.getByTestId(`tool-${id}-result`);
/** A tool's 「⋯」 and the menu it opens (回到 x, 卸载…). */
const more = (page: Page, id: string) => row(page, id).getByRole("button", { name: "更多操作" });
const menu = (page: Page, id: string) => row(page, id).getByRole("menu");
const refresh = (page: Page) => page.evaluate(() => (window as unknown as { amoPlatform: { call(m: string, a: unknown[]): Promise<unknown> } }).amoPlatform.call("refresh", []));

test("log in → install → a new version → update → 回滚 → 卸载; Studio waits for its data dir", async () => {
  const realHome = join(process.env.APPDATA ?? "", "AMO");
  const realLocal = join(process.env.LOCALAPPDATA ?? "", "AMO");
  const before = [realHome, realLocal].map((p) => (existsSync(p) ? statSync(p).mtimeMs : null));
  server.publish("reviewer", "1.0.0", tool("reviewer", "1.0.0"), { name: "AMO Reviewer", exe: "run.cmd", notes: "- 第一版：Git Review 和查看器", channel: "test" });
  server.publish("studio", "0.9.0", tool("studio", "0.9.0"), { name: "AMO Studio", exe: "run.cmd", notes: "- 看板、任务、会话", channel: "test" });
  server.publish("platform", "0.9.0", { "AMO Platform.exe": "p" }, { exe: "AMO Platform.exe", channel: "test" });

  const { app, page } = await launch(["--channel", "test"]);

  // Test windows stay off every screen and never take focus.
  const state = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    const b = w.getBounds();
    return { focusable: w.isFocusable(), focused: w.isFocused(), onScreen: screen.getAllDisplays().some((d) => b.x < d.bounds.x + d.bounds.width && b.x + b.width > d.bounds.x && b.y < d.bounds.y + d.bounds.height && b.y + b.height > d.bounds.y) };
  });
  expect(state).toEqual({ focusable: false, focused: false, onScreen: false });

  // ---- 登录
  const form = page.getByRole("form", { name: "登录" });
  await expect(form).toBeVisible();
  await screenshot(app, "platform", "P1-login", page);
  await form.getByLabel("服务器地址").fill(server.url.replace("http://", ""));
  await form.getByLabel("名字").fill("小王");
  await form.getByLabel("密码").fill("wrong");
  await form.getByRole("button", { name: "登录" }).click();
  await expect(form.getByRole("alert")).toHaveText("名字或密码不对");
  await screenshot(app, "platform", "P2-login-failed", page);
  await form.getByLabel("密码").fill("secret");
  await form.getByRole("button", { name: "登录" }).click();

  // ---- 工具: the channel's tools, not the platform itself
  await expect(page.getByRole("heading", { name: "工具" })).toBeVisible();
  await expect(page.getByTestId("pf-connection")).toContainText("服务器在线");
  await expect(status(page, "studio")).toHaveText("○ 没装 · 服务器上是 0.9.0");
  await expect(status(page, "reviewer")).toHaveText("○ 没装 · 服务器上是 1.0.0");
  await expect(page.getByTestId("tool-platform")).toHaveCount(0);
  await expect(row(page, "reviewer").locator("summary")).toHaveText("1.0.0 改了什么");
  await screenshot(app, "platform", "P3-tools", page);
  const account = JSON.parse(readFileSync(join(root, "roaming", "account.json"), "utf8")) as { server: string; name: string; key: string };
  expect(account).toMatchObject({ server: server.url, name: "小王" });

  // ---- install the Reviewer, then open it
  await row(page, "reviewer").getByRole("button", { name: "安装" }).click();
  await expect(status(page, "reviewer")).toHaveText("✓ 1.0.0 · 已是最新");
  await expect(result(page, "reviewer")).toContainText("已装好 1.0.0");
  expect(programs().tools.reviewer).toEqual({ version: "1.0.0", dir: join(root, "local", "apps", "reviewer", "current"), exe: "run.cmd" });
  // The runtime came gzipped and was unpacked on the way (the installer checked its sha256).
  expect(server.objectTraffic.gzipped).toBeGreaterThan(0);
  expect(server.objectTraffic.sent).toBeLessThan(server.objectTraffic.original / 2);
  expect(readFileSync(join(root, "local", "apps", "reviewer", "current", "resources", "runtime.bin"), "utf8")).toBe("R".repeat(256 * 1024));
  await screenshot(app, "platform", "P4-installed", page);
  await row(page, "reviewer").getByRole("button", { name: "打开" }).click();
  await expect.poll(() => (existsSync(join(root, "launched.reviewer")) ? readFileSync(join(root, "launched.reviewer"), "utf8").trim() : "")).toMatch(/^reviewer 1\.0\.0/);

  // ---- a new version is published: 有新版, its notes, update
  server.publish("reviewer", "1.1.0", tool("reviewer", "1.1.0"), { name: "AMO Reviewer", exe: "run.cmd", notes: "- 查看器：HTML 页面上右键就能写批注\n- 改了归档按钮的样子", channel: "test" });
  await refresh(page);
  await expect(status(page, "reviewer")).toHaveText("! 1.0.0 · 有新版 1.1.0");
  await expect(row(page, "reviewer").locator(".pf-notes-text")).toContainText("右键就能写批注");
  await screenshot(app, "platform", "P5-update-available", page);
  // Slow downloads, to see the bar while it works.
  server.delayObjects(1500);
  await row(page, "reviewer").getByRole("button", { name: "更新到 1.1.0" }).click();
  await expect(row(page, "reviewer").getByRole("status", { name: "AMO Reviewer 进度" })).toContainText("正在下载");
  await screenshot(app, "platform", "P6-updating", page);
  await expect(status(page, "reviewer")).toHaveText("✓ 1.1.0 · 已是最新", { timeout: 20_000 });
  server.delayObjects(0);
  // Only the changed files came down; the rest were hard-linked from 1.0.0.
  await expect(result(page, "reviewer")).toHaveText(/已更新到 1\.1\.0（2 个文件本机已经有了，没有重新下载）/);
  expect(programs().tools.reviewer!.version).toBe("1.1.0");
  await screenshot(app, "platform", "P7-updated", page);

  // ---- 回滚: not on the card (2026-10-28, the user), in its 「⋯」
  await expect(row(page, "reviewer").getByRole("button", { name: /回到|卸载/ })).toHaveCount(0);
  await expect(row(page, "reviewer").getByText("回到 1.0.0")).toHaveCount(0);
  await more(page, "reviewer").click();
  await expect(menu(page, "reviewer").getByRole("menuitem")).toHaveText([/^回到 1\.0\.0/, /^卸载…/]);
  await screenshot(app, "platform", "P28-more-menu", page);
  // Esc closes it, and so does a click elsewhere.
  await page.keyboard.press("Escape");
  await expect(menu(page, "reviewer")).toHaveCount(0);
  await more(page, "reviewer").click();
  await page.getByRole("heading", { name: "工具" }).click();
  await expect(menu(page, "reviewer")).toHaveCount(0);
  await more(page, "reviewer").click();
  await menu(page, "reviewer").getByRole("menuitem", { name: /^回到 1\.0\.0/ }).click();
  await expect(result(page, "reviewer")).toContainText("已回到 1.0.0");
  await expect(status(page, "reviewer")).toHaveText("! 1.0.0 · 有新版 1.1.0");
  expect(programs().tools.reviewer!.version).toBe("1.0.0");
  expect(readFileSync(join(root, "local", "apps", "reviewer", "current", "resources", "app.txt"), "utf8")).toBe("reviewer 1.0.0");
  await screenshot(app, "platform", "P8-rolled-back", page);

  // ---- 卸载 (in 「⋯」 too, and asks first)
  await more(page, "reviewer").click();
  await menu(page, "reviewer").getByRole("menuitem", { name: /^卸载/ }).click();
  const confirm = row(page, "reviewer").getByRole("group", { name: "卸载 AMO Reviewer" });
  await expect(confirm).toContainText("1.0.0 和留着的 1.1.0 都会删掉");
  await screenshot(app, "platform", "P9-uninstall-confirm", page);
  await confirm.getByRole("button", { name: "卸载" }).click();
  await expect(status(page, "reviewer")).toHaveText("○ 没装 · 服务器上是 1.1.0", { timeout: 20_000 });
  expect(programs().tools.reviewer).toBeUndefined();
  expect(existsSync(join(root, "local", "apps", "reviewer"))).toBe(false);

  // ---- Studio: installed, but not opened until its data dir is set
  await row(page, "studio").getByRole("button", { name: "安装" }).click();
  await expect(status(page, "studio")).toHaveText("✓ 0.9.0 · 已是最新");
  await expect(row(page, "reviewer")).toContainText("Studio 里已经带了 Reviewer");
  await row(page, "studio").getByRole("button", { name: "打开" }).click();
  await expect(page.getByRole("heading", { name: "目录" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Studio 数据目录" }).getByRole("alert")).toContainText("先设好 Studio 数据目录，再打开 Studio。");
  await expect(page.getByTestId("pf-studio-data")).toHaveText("还没设");
  await screenshot(app, "platform", "P10-dirs-need-studio", page);
  expect(existsSync(join(root, "launched.studio"))).toBe(false);
  const dataDir = join(root, "studio-data");
  await app.evaluate((_e, dir) => ((globalThis as { __platformPicks?: string[] }).__platformPicks = [dir]), dataDir);
  await page.getByRole("button", { name: "选择文件夹…" }).click();
  await expect(page.getByTestId("pf-studio-data")).toHaveText(dataDir);
  await screenshot(app, "platform", "P11-dirs", page);
  await page.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "工具" }).click();
  await row(page, "studio").getByRole("button", { name: "打开" }).click();
  await expect.poll(() => (existsSync(join(root, "launched.studio")) ? readFileSync(join(root, "launched.studio"), "utf8").trim() : "")).toBe(`studio 0.9.0 ${dataDir}`);

  // ---- 设置: the channel from --channel, starting with Windows recorded (not registered) in tests
  await page.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("radio", { name: "测试" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("--channel test")).toBeVisible();
  await page.getByTestId("pf-login-start").check();
  await expect.poll(() => app.evaluate(() => (globalThis as { __platformOpenAtLogin?: boolean }).__platformOpenAtLogin)).toBe(true);
  // Started from the sources: it does not update itself (the server's platform 0.9.0 is not offered), nor hint at it.
  await expect(page.getByTestId("pf-self-place")).toHaveText("开发版（从源码启动），不自己更新。");
  await expect(page.getByTestId("pf-self-status")).toHaveCount(0);
  await expect(page.getByTestId("pf-self-hint")).toHaveCount(0);
  await screenshot(app, "platform", "P12-settings", page);
  expect(JSON.parse(readFileSync(join(root, "roaming", "platform.json"), "utf8"))).toMatchObject({ server: server.url, recentServers: [server.url], studioDataDir: dataDir, openAtLogin: true });

  // ---- the tray: 打开 for what is installed; closing the window leaves the program running
  expect(await app.evaluate(() => (globalThis as { __platformTray?: () => string[] }).__platformTray!())).toEqual(["打开 AMO 平台", "—", "打开 AMO Studio", "—", "退出"]);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const reopened = app.waitForEvent("window");
  await app.evaluate(() => (globalThis as { __platformTrayClick?: (l: string) => void }).__platformTrayClick!("打开 AMO 平台"));
  const again = await reopened;
  await expect(again.getByRole("heading", { name: "工具" })).toBeVisible();

  // ---- 账号 (2026-10-28: out of 设置, with the profile editing that left the relay client)
  await again.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "设置" }).click();
  await expect(again.getByRole("button", { name: /退出登录/ })).toHaveCount(0);
  await expect(again.getByRole("region", { name: "团队服务器" })).toHaveCount(0);
  const navAccount = again.getByTestId("pf-nav-account");
  await expect(navAccount.locator(".pf-nav-me-name")).toHaveText("小王");
  await navAccount.click();
  await expect(again.getByRole("heading", { name: "账号", exact: true })).toBeVisible();
  await expect(again.getByTestId("pf-account-server")).toHaveText(server.url.replace("http://", ""));
  await expect(again.getByTestId("pf-account-name")).toContainText("小王");
  const profileForm = again.getByRole("form", { name: "编辑资料" });
  await expect(profileForm.getByLabel("负责什么")).toHaveValue("程序");
  await expect(profileForm.getByLabel("昵称")).toHaveValue("");
  await expect(profileForm.getByRole("button", { name: "保存" })).toBeDisabled();
  await screenshot(app, "platform", "P29-account", again);
  // A nickname, 负责什么 and a picture (cut to a 128 px JPEG here), saved on the team server.
  await profileForm.getByLabel("昵称").fill("王哥");
  await profileForm.getByLabel("负责什么").fill("程序 · 战斗");
  await again.getByTestId("pf-avatar-file").setInputFiles(join(studioRoot, "packages", "app", "assets", "icon.png"));
  await expect(profileForm.locator("img.pf-face.big")).toBeVisible();
  await expect(again.getByTestId("pf-profile-preview")).toHaveText("别人看到的是王哥(小王)");
  await profileForm.getByRole("button", { name: "保存" }).click();
  await expect(again.getByTestId("pf-profile-result")).toHaveText("✓ 已保存，团队里的人都会看到，AMO 中转里也是");
  const saved = server.profile("小王")!;
  expect(saved).toMatchObject({ nick: "王哥", role: "程序 · 战斗" });
  expect(saved.avatar).toMatch(/^data:image\/jpeg;base64,/);
  await expect(navAccount.locator(".pf-nav-me-name")).toHaveText("王哥");
  await expect(navAccount.locator("img.pf-face")).toHaveAttribute("src", saved.avatar!);
  await expect(profileForm.getByRole("button", { name: "保存" })).toBeDisabled();
  await screenshot(app, "platform", "P30-account-saved", again);
  // A refusal comes back to the page in the service's words (the account module checks first, as store.setProfile does).
  await profileForm.getByLabel("昵称").fill("王\u0007哥");
  await profileForm.getByRole("button", { name: "保存" }).click();
  await expect(again.getByTestId("pf-profile-result")).toHaveText("! 昵称里不能有控制字符");
  await profileForm.getByRole("button", { name: "还原" }).click();
  await expect(profileForm.getByLabel("昵称")).toHaveValue("王哥");
  // Back to the text face.
  await profileForm.getByRole("button", { name: "用文字头像" }).click();
  await profileForm.getByRole("button", { name: "保存" }).click();
  await expect(again.getByTestId("pf-profile-result")).toContainText("已保存");
  expect(server.profile("小王")).toEqual({ nick: "王哥", role: "程序 · 战斗", avatar: null });
  await expect(navAccount.locator(".pf-face")).toHaveText("王");
  // A narrow window (the platform's smallest): the page still fits.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 520));
  await expect.poll(() => again.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(app, "platform", "P31-account-narrow", again);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));

  // ---- 退出登录 (on 账号) → the login page, with the recent server and the name filled in
  await again.getByRole("button", { name: "退出登录…" }).click();
  await again.getByRole("button", { name: "退出登录", exact: true }).click();
  const form2 = again.getByRole("form", { name: "登录" });
  await expect(form2.getByLabel("服务器地址")).toHaveValue(server.url.replace("http://", ""));
  await expect(form2.getByLabel("名字")).toHaveValue("小王");
  await expect(form2.getByRole("button", { name: server.url.replace("http://", "") })).toBeVisible();
  expect(existsSync(join(root, "roaming", "account.json"))).toBe(false);
  await screenshot(app, "platform", "P13-logged-out", again);

  // Nothing landed in the real shared folders.
  expect([realHome, realLocal].map((p) => (existsSync(p) ? statSync(p).mtimeMs : null))).toEqual(before);
});

test("a second tool downloads only its own files: the shared runtime is hard-linked from the first; uninstalling one leaves the other whole", async () => {
  // A server of its own, so the traffic counts only this test's downloads.
  const shared = await startFakePlatformServer({ users: { 小王: "secret" }, gzip: true });
  try {
    // As the platform's builds (2026-10-29, 「共用 Electron」): the same runtime files in both tools, their own app.
    const runtime = { "resources/electron.pak": randomBytes(512 * 1024) };
    shared.publish("reviewer", "1.0.0", { ...tool("reviewer", "1.0.0"), ...runtime }, { name: "AMO Reviewer", exe: "run.cmd" });
    const notes = shared.publish("notes", "1.0.0", { ...tool("notes", "1.0.0"), ...runtime }, { name: "AMO Notes", exe: "run.cmd" });
    const { page } = await launch();
    const form = page.getByRole("form", { name: "登录" });
    await form.getByLabel("服务器地址").fill(shared.url.replace("http://", ""));
    await form.getByLabel("名字").fill("小王");
    await form.getByLabel("密码").fill("secret");
    await form.getByRole("button", { name: "登录" }).click();
    await expect(status(page, "notes")).toHaveText("○ 没装 · 服务器上是 1.0.0");

    await row(page, "reviewer").getByRole("button", { name: "安装" }).click();
    await expect(status(page, "reviewer")).toHaveText("✓ 1.0.0 · 已是最新");
    const afterFirst = shared.objectTraffic.original;
    await row(page, "notes").getByRole("button", { name: "安装" }).click();
    await expect(status(page, "notes")).toHaveText("✓ 1.0.0 · 已是最新");
    // Only run.cmd and app.txt came down; the runtime, the pak and the licence were already here (the Reviewer's).
    await expect(result(page, "notes")).toHaveText(/已装好 1\.0\.0（3 个文件本机已经有了，没有重新下载）/);
    const own = notes.files.filter((f) => f.path === "run.cmd" || f.path === "resources/app.txt").reduce((n, f) => n + f.size, 0);
    expect(shared.objectTraffic.original - afterFirst).toBe(own);
    const apps = join(root, "local", "apps");
    const ino = (p: string) => statSync(p, { bigint: true }).ino;
    expect(ino(join(apps, "notes", "1.0.0", "resources", "electron.pak"))).toBe(ino(join(apps, "reviewer", "1.0.0", "resources", "electron.pak")));
    expect(existsSync(join(root, "local", "apps", "file-index.json"))).toBe(true);
    await screenshot(app!, "platform", "P17-shared-runtime", page);

    // A narrow window: the 「⋯」 menu opens inside it.
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 520));
    await more(page, "reviewer").click();
    await expect(menu(page, "reviewer")).toBeVisible();
    const box = await menu(page, "reviewer").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    await screenshot(app!, "platform", "P32-more-menu-narrow", page);
    await page.keyboard.press("Escape");
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));

    // The Reviewer uninstalled: the 便签's copy of the shared files is still whole.
    await more(page, "reviewer").click();
    await menu(page, "reviewer").getByRole("menuitem", { name: /^卸载/ }).click();
    await row(page, "reviewer").getByRole("group", { name: "卸载 AMO Reviewer" }).getByRole("button", { name: "卸载" }).click();
    // Uninstalling asks Windows what runs first (PowerShell, a few seconds on a busy machine).
    await expect(status(page, "reviewer")).toHaveText("○ 没装 · 服务器上是 1.0.0", { timeout: 20_000 });
    expect(existsSync(join(apps, "reviewer"))).toBe(false);
    expect(readFileSync(join(apps, "notes", "current", "resources", "electron.pak"))).toEqual(runtime["resources/electron.pak"]);
    expect(readFileSync(join(apps, "notes", "current", "resources", "runtime.bin"), "utf8")).toBe("R".repeat(256 * 1024));
  } finally {
    await shared.close();
  }
});

/**
 * The platform as unpacked from the download page (2026-10-28: it and its tools stay in that folder): 0.9.1's entry at
 * <root>\<where>\AMO Platform, with a file of the person's own beside it. No AMO_LOCAL_HOME — the folder comes from where
 * the program is (test mode: AMO_PLATFORM_TEST_EXE) — and %LOCALAPPDATA% in the temp root, for the Chromium profile.
 */
function unpackedPlatform(r: string, where: string, extra: (dir: string) => void = () => undefined): string {
  const dir = join(r, where, "AMO Platform");
  mkdirSync(join(dir, "resources", "app"), { recursive: true });
  writeFileSync(join(dir, "AMO Platform.exe"), "the unpacked platform 0.9.1");
  writeFileSync(join(dir, "resources", "app", "package.json"), '{"version":"0.9.1"}');
  writeFileSync(join(dir, "resources", "app", "main.js"), "platform 0.9.1");
  writeFileSync(join(dir, "resources", "app", "only-in-0.9.1.js"), "old");
  writeFileSync(join(dir, "使用说明.txt"), "0.9.1");
  writeFileSync(join(dir, "我的笔记.txt"), "mine");
  extra(dir);
  return dir;
}
const asPlatform = (r: string, exe: string, version: string) => ({ AMO_LOCAL_HOME: "", LOCALAPPDATA: join(r, "localappdata"), AMO_PLATFORM_TEST_EXE: exe, AMO_PLATFORM_TEST_VERSION: version });

test("平台更新: tools go into the unpacked folder's apps → 更新平台 → apps\\platform\\0.9.2 → 重启平台 (recorded); the old entry forwards there; run from there, the entry becomes 0.9.2 and opens it directly", async () => {
  const realHome = join(process.env.APPDATA ?? "", "AMO");
  const realLocal = join(process.env.LOCALAPPDATA ?? "", "AMO");
  const before = [realHome, realLocal].map((p) => (existsSync(p) ? statSync(p).mtimeMs : null));
  // A server of its own; the platform shares its runtime file with the 便签 (共用 Electron), so its update links it.
  const own = await startFakePlatformServer({ users: { 小王: "secret" }, gzip: true });
  try {
    const runtime = { "resources/electron.pak": randomBytes(256 * 1024) };
    own.publish("notes", "1.0.0", { ...tool("notes", "1.0.0"), ...runtime }, { name: "AMO Notes", exe: "run.cmd" });
    own.publish("platform", "0.9.2", { "AMO Platform.exe": "a stand-in platform", "resources/app/package.json": '{"version":"0.9.2"}', "resources/app/main.js": "platform 0.9.2", "使用说明.txt": "0.9.2", ...runtime }, { name: "AMO Platform", exe: "AMO Platform.exe", notes: "- 平台能自己更新了：设置里的「平台更新」\n- 顶栏有一个不占地方的提示" });
    const unpacked = () => join(root, "TOOLS", "AMO Platform");
    const entry = () => join(unpacked(), "AMO Platform.exe");
    const apps = () => join(unpacked(), "apps");
    const v092 = () => join(apps(), "platform", "0.9.2");
    const restartSpec = () => app!.evaluate(() => (globalThis as { __platformRestart?: { file: string; args: string[]; cwd: string; env: Record<string, string> } }).__platformRestart ?? null);
    const forwardSpec = () => app!.evaluate(() => (globalThis as { __platformForward?: { file: string; args: string[]; cwd: string } }).__platformForward ?? null);
    const loginExe = () => app!.evaluate(() => (globalThis as { __platformOpenAtLoginExe?: string | null }).__platformOpenAtLoginExe);
    const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "页面" }).getByRole("button", { name }).click();
    const ino = (p: string) => statSync(p, { bigint: true }).ino;

    let { page } = await launch([], (r) => asPlatform(r, join(unpackedPlatform(r, "TOOLS"), "AMO Platform.exe"), "0.9.1"));
    const form = page.getByRole("form", { name: "登录" });
    await form.getByLabel("服务器地址").fill(own.url.replace("http://", ""));
    await form.getByLabel("名字").fill("小王");
    await form.getByLabel("密码").fill("secret");
    await form.getByRole("button", { name: "登录" }).click();
    await expect(status(page, "notes")).toHaveText("○ 没装 · 服务器上是 1.0.0");
    // The platform is not a tool on 工具; the title bar says, quietly, that it has a new version. The folder is fine.
    await expect(page.getByTestId("tool-platform")).toHaveCount(0);
    await expect(page.getByTestId("pf-self-hint")).toHaveText("! 平台有新版 0.9.2");
    await expect(page.getByTestId("pf-root-issue")).toHaveCount(0);
    // A tool goes into the folder the platform was unpacked to, not into AppData.
    await row(page, "notes").getByRole("button", { name: "安装" }).click();
    await expect(status(page, "notes")).toHaveText("✓ 1.0.0 · 已是最新");
    expect(programs().tools.notes).toEqual({ version: "1.0.0", dir: join(apps(), "notes", "current"), exe: "run.cmd" });
    expect(existsSync(join(apps(), "file-index.json"))).toBe(true);
    expect(existsSync(join(root, "localappdata", "AMO", "apps"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "roaming", "platform.json"), "utf8")).root).toBe(unpacked());

    // 目录: where the tools are, and how to move them.
    await nav(page, "目录");
    await expect(page.getByTestId("pf-root")).toHaveText(unpacked());
    await expect(page.getByRole("region", { name: "工具装在哪" })).toContainText("工具装在平台所在的文件夹里；要换位置，把整个文件夹移过去");
    await screenshot(app!, "platform", "P26-dirs-root", page);

    // 设置: starting with Windows registers the entry.
    await nav(page, "设置");
    await page.getByTestId("pf-login-start").check();
    await expect.poll(loginExe).toBe(entry());
    // The hint leads to 平台更新.
    await nav(page, "工具");
    await page.getByTestId("pf-self-hint").click();
    const section = page.getByRole("region", { name: "平台更新" });
    await expect(section.getByTestId("pf-self-status")).toHaveText("! 有新版 0.9.2");
    await expect(section.getByTestId("pf-self-place")).toHaveText(`从 ${entry()} 运行。新版会装进同一个文件夹的 apps\\platform，之后 AMO Platform.exe 跟着换成新版，以后还是双击它打开。`);
    await expect(section.locator(".pf-notes-text")).toContainText("平台能自己更新了");
    await expect(section.getByRole("button", { name: "更新平台" })).toBeEnabled();
    await screenshot(app!, "platform", "P19-self-update-available", page);

    // 更新平台: the same engine as the tools, into <root>\apps\platform\0.9.2 (slowed, to see the bar).
    own.delayObjects(1200);
    await section.getByRole("button", { name: "更新平台" }).click();
    await expect(section.getByRole("status", { name: "平台更新进度" })).toBeVisible();
    await expect(page.getByTestId("pf-self-hint")).toHaveText("◐ 正在更新平台…");
    await screenshot(app!, "platform", "P20-self-updating", page);
    await expect(section.getByTestId("pf-self-status")).toHaveText("✓ 0.9.2 已装好，点「重启平台」换成新版", { timeout: 20_000 });
    own.delayObjects(0);
    await expect(section.getByTestId("pf-self-result")).toHaveText(/已装好 0\.9\.2（1 个文件本机已经有了，没有重新下载）/);
    expect(readFileSync(join(v092(), "resources", "app", "main.js"), "utf8")).toBe("platform 0.9.2");
    expect(ino(join(v092(), "resources", "electron.pak"))).toBe(ino(join(apps(), "notes", "1.0.0", "resources", "electron.pak")));
    // The running entry is not touched; starting with Windows stays on it.
    expect(readFileSync(entry(), "utf8")).toBe("the unpacked platform 0.9.1");
    expect(await loginExe()).toBe(entry());
    await expect(section.getByTestId("pf-self-place")).toHaveText("新版已经装进同一个文件夹的 apps\\platform。点「重启平台」换过去，之后 AMO Platform.exe 也会换成新版。");
    await expect(page.getByTestId("pf-self-hint")).toHaveText("! 重启平台换成 0.9.2");
    // Nothing restarted by itself.
    expect(await restartSpec()).toBeNull();
    await screenshot(app!, "platform", "P21-self-restart", page);

    // 重启平台: apps\platform's real 0.9.2 folder would start, waiting for this one to go (recorded in tests).
    const pid = await app!.evaluate(() => process.pid);
    await section.getByRole("button", { name: "重启平台" }).click();
    await expect.poll(restartSpec).toMatchObject({ file: join(v092(), "AMO Platform.exe"), args: [`--after=${pid}`], cwd: v092() });
    const env = (await restartSpec())!.env as Record<string, string>;
    expect(env).toMatchObject({ AMO_HOME: join(root, "roaming") });
    expect(Object.keys(env).filter((k) => k.startsWith("AMO_PLATFORM_"))).toEqual([]);
    await app!.close();
    app = undefined;

    // The old entry double-clicked before the new one ever ran: it hands over to apps\platform\0.9.2 (with its own
    // arguments, and --after so the new one waits for it) and quits. Test mode records that and goes on, showing the
    // fallback 打开那个 a real entry only shows when it could not start the new one.
    ({ page } = await launch(["--channel", "stable"], (r) => asPlatform(r, join(r, "TOOLS", "AMO Platform", "AMO Platform.exe"), "0.9.1"), true));
    const entryPid = await app!.evaluate(() => process.pid);
    expect(await forwardSpec()).toMatchObject({ file: join(v092(), "AMO Platform.exe"), args: ["--channel", "stable", `--after=${entryPid}`], cwd: v092() });
    await expect(page.getByTestId("pf-self-hint")).toHaveText("! 有更新的平台 0.9.2");
    await page.getByTestId("pf-self-hint").click();
    await expect(page.getByTestId("pf-self-status")).toHaveText("! 有更新的平台 0.9.2，打开那个");
    await expect(page.getByTestId("pf-self-place")).toHaveText("这个是旧的 0.9.1。同一个文件夹的 apps\\platform 里有更新的平台，点「打开那个」换过去。");
    await screenshot(app!, "platform", "P23-self-newer-here", page);
    await app!.close();
    app = undefined;

    // Run from apps\platform\0.9.2, as the restart and the forward do: still logged in, up to date — and the entry's
    // files are 0.9.2's now (hard links of that folder's; its old file gone, the person's own file and apps\ untouched).
    const notesPak = readFileSync(join(apps(), "notes", "1.0.0", "resources", "electron.pak"));
    ({ page } = await launch([], (r) => asPlatform(r, join(r, "TOOLS", "AMO Platform", "apps", "platform", "0.9.2", "AMO Platform.exe"), "0.9.2"), true));
    await expect(page.getByRole("heading", { name: "工具" })).toBeVisible();
    await expect(page.getByTestId("pf-connection")).toContainText("服务器在线");
    await expect(status(page, "notes")).toHaveText("✓ 1.0.0 · 已是最新");
    await expect(page.getByTestId("pf-self-hint")).toHaveCount(0);
    for (const f of ["AMO Platform.exe", "resources/app/package.json", "resources/app/main.js", "使用说明.txt", "resources/electron.pak"]) expect(ino(join(unpacked(), ...f.split("/"))), f).toBe(ino(join(v092(), ...f.split("/"))));
    expect(JSON.parse(readFileSync(join(unpacked(), "resources", "app", "package.json"), "utf8")).version).toBe("0.9.2");
    expect(existsSync(join(unpacked(), "resources", "app", "only-in-0.9.1.js"))).toBe(false);
    expect(readFileSync(join(unpacked(), "我的笔记.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(apps(), "notes", "1.0.0", "resources", "electron.pak"))).toEqual(notesPak);
    expect(readFileSync(join(apps(), "notes", "current", "resources", "app.txt"), "utf8")).toBe("notes 1.0.0");
    await nav(page, "设置");
    await expect(page.getByTestId("pf-self-status")).toHaveText("✓ 已是最新");
    await expect(page.getByTestId("pf-self-place")).toHaveText(`正在运行 apps\\platform\\0.9.2 里的版本（平台的文件夹：${unpacked()}）。AMO Platform.exe 已经换成这一版，以后还是双击它打开平台。`);
    await expect(page.getByTestId("pf-login-start")).toBeChecked();
    await expect.poll(loginExe).toBe(entry());
    await screenshot(app!, "platform", "P22-self-entry-refreshed", page);
    await app!.close();
    app = undefined;

    // The entry double-clicked now: it is 0.9.2 itself, nothing to forward to.
    ({ page } = await launch([], (r) => asPlatform(r, join(r, "TOOLS", "AMO Platform", "AMO Platform.exe"), "0.9.2"), true));
    await expect(page.getByRole("heading", { name: "工具" })).toBeVisible();
    await expect(page.getByTestId("pf-connection")).toContainText("服务器在线");
    expect(await forwardSpec()).toBeNull();
    await expect(page.getByTestId("pf-self-hint")).toHaveCount(0);
    await nav(page, "设置");
    await expect(page.getByTestId("pf-self-status")).toHaveText("✓ 已是最新");
  } finally {
    await own.close();
  }
  expect([realHome, realLocal].map((p) => (existsSync(p) ? statSync(p).mtimeMs : null))).toEqual(before);
});

test("a platform folder it cannot write to (no administrator rights): 工具 says to move it; 安装 and 更新平台 are greyed out", async () => {
  const own = await startFakePlatformServer({ users: { 小王: "secret" } });
  const who = `${process.env.USERDOMAIN ?? "."}\\${process.env.USERNAME ?? ""}`;
  let locked = "";
  try {
    own.publish("notes", "1.0.0", tool("notes", "1.0.0"), { name: "AMO Notes", exe: "run.cmd" });
    own.publish("platform", "0.9.2", { "AMO Platform.exe": "p" }, { name: "AMO Platform", exe: "AMO Platform.exe" });
    // Unpacked as into Program Files: files can be read there, none made (this user denied adding files and folders).
    const { app, page } = await launch([], (r) => {
      const dir = unpackedPlatform(r, "Program Files");
      execFileSync("icacls", [dir, "/deny", `${who}:(WD,AD)`], { stdio: "ignore" });
      locked = dir;
      return asPlatform(r, join(dir, "AMO Platform.exe"), "0.9.1");
    });
    const form = page.getByRole("form", { name: "登录" });
    await form.getByLabel("服务器地址").fill(own.url.replace("http://", ""));
    await form.getByLabel("名字").fill("小王");
    await form.getByLabel("密码").fill("secret");
    await form.getByRole("button", { name: "登录" }).click();
    // The list shows once Windows has said what runs (PowerShell, a few seconds on a busy machine).
    await expect(status(page, "notes")).toHaveText("○ 没装 · 服务器上是 1.0.0", { timeout: 20_000 });
    await expect(page.getByTestId("pf-root-issue")).toHaveText(`! 这个文件夹不能写入（${locked}），平台装不了工具也更新不了。把整个文件夹移到能写的位置（比如 D:\\TOOLS）再打开。`);
    await expect(row(page, "notes").getByRole("button", { name: "安装" })).toBeDisabled();
    await screenshot(app, "platform", "P27-root-readonly", page);
    await page.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "设置" }).click();
    const section = page.getByRole("region", { name: "平台更新" });
    await expect(section.getByRole("button", { name: "更新平台" })).toBeDisabled();
    await expect(section.getByRole("alert")).toContainText("这个文件夹不能写入");
    expect(existsSync(join(locked, "apps"))).toBe(false);
  } finally {
    if (locked) execFileSync("icacls", [locked, "/remove:d", who], { stdio: "ignore" });
    await own.close();
  }
});

test("注册 on the login page: the passphrase only when the server wants one, errors in the form, then 工具; log out and back in", async () => {
  const realHome = join(process.env.APPDATA ?? "", "AMO");
  const before = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
  // A second team server, with an invite passphrase and a name of its own.
  const invited = await startFakePlatformServer({ users: { 小王: "secret" }, passphrase: "芝麻开门", name: "策划组" });
  try {
    invited.publish("reviewer", "1.0.0", tool("reviewer", "1.0.0"), { name: "AMO Reviewer", exe: "run.cmd", notes: "- 第一版" });
    const { app, page } = await launch();
    await page.getByRole("form", { name: "登录" }).getByRole("button", { name: "没有账号？注册一个" }).click();
    const form = page.getByRole("form", { name: "注册" });
    await expect(form.getByRole("heading", { name: "注册账号" })).toBeVisible();

    // A server without a passphrase: no field for one.
    await form.getByLabel("服务器地址").fill(server.url.replace("http://", ""));
    await expect(form.getByTestId("pf-server-check")).toHaveText("✓ 服务器在线 · AMO 中转");
    await expect(form.getByLabel("邀请口令")).toHaveCount(0);
    // One with: the field shows up.
    await form.getByLabel("服务器地址").fill(invited.url.replace("http://", ""));
    await expect(form.getByTestId("pf-server-check")).toHaveText("✓ 服务器在线 · 策划组 · 注册要邀请口令");
    await expect(form.getByLabel("邀请口令")).toBeVisible();
    await form.getByLabel("名字").fill("小李");
    await form.getByLabel("密码", { exact: true }).fill("pass1");
    await form.getByLabel("再输一次密码").fill("pass2");
    await form.getByLabel("负责什么").fill("策划 · 关卡");
    await screenshot(app, "platform", "P14-register", page);

    // Mistakes, each said in the form: the passwords differ, the passphrase is wrong, the name is taken.
    await form.getByRole("button", { name: "注册并登录" }).click();
    await expect(form.getByRole("alert")).toHaveText("两次输入的密码不一样");
    await form.getByLabel("再输一次密码").fill("pass1");
    await form.getByLabel("邀请口令").fill("芝麻");
    await form.getByRole("button", { name: "注册并登录" }).click();
    await expect(form.getByRole("alert")).toHaveText("邀请口令不对");
    await form.getByLabel("邀请口令").fill("芝麻开门");
    await form.getByLabel("名字").fill("小王");
    await form.getByRole("button", { name: "注册并登录" }).click();
    await expect(form.getByRole("alert")).toHaveText("名字「小王」已经有人用了");
    await screenshot(app, "platform", "P15-register-taken", page);
    expect(existsSync(join(root, "roaming", "account.json"))).toBe(false);

    // Registered: straight to 工具, logged in as the new account.
    await form.getByLabel("名字").fill("小李");
    await form.getByRole("button", { name: "注册并登录" }).click();
    await expect(page.getByRole("heading", { name: "工具" })).toBeVisible();
    await expect(page.getByTestId("pf-connection")).toContainText("服务器在线");
    await expect(status(page, "reviewer")).toHaveText("○ 没装 · 服务器上是 1.0.0");
    expect(invited.members()["小李"]).toEqual({ password: "pass1", role: "策划 · 关卡" });
    expect(JSON.parse(readFileSync(join(root, "roaming", "account.json"), "utf8"))).toMatchObject({ server: invited.url, name: "小李" });
    // 账号: the new account, with the 负责什么 given when registering.
    await page.getByTestId("pf-nav-account").click();
    await expect(page.getByTestId("pf-account-name")).toContainText("小李");
    await expect(page.getByTestId("pf-account-server")).toHaveText(invited.url.replace("http://", ""));
    await expect(page.getByRole("region", { name: "登录" })).toContainText("团队「策划组」");
    await expect(page.getByRole("form", { name: "编辑资料" }).getByLabel("负责什么")).toHaveValue("策划 · 关卡");
    await screenshot(app, "platform", "P16-registered", page);

    // 退出登录, then in again with the new account (its name and server filled in).
    await page.getByRole("button", { name: "退出登录…" }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    const login = page.getByRole("form", { name: "登录" });
    await expect(login.getByLabel("服务器地址")).toHaveValue(invited.url.replace("http://", ""));
    await expect(login.getByLabel("名字")).toHaveValue("小李");
    await login.getByLabel("密码").fill("pass1");
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "工具" })).toBeVisible();
    expect(JSON.parse(readFileSync(join(root, "roaming", "account.json"), "utf8"))).toMatchObject({ server: invited.url, name: "小李" });
  } finally {
    await invited.close();
  }
  expect(existsSync(realHome) ? statSync(realHome).mtimeMs : null).toBe(before);
});

test("环境: what the tools run on, found where Studio looks; 去下载 opens the official page, 复制 the install command", async () => {
  // A pretend machine: PATH, %USERPROFILE%, %APPDATA% and %LOCALAPPDATA% in the temp root, so the real Claude Code, Codex
  // and git here are not what is found. Claude Code: a file named claude.exe that is no program (found, does not answer);
  // no DSH app, no Codex, no git (Codex turns up later: a .cmd that says its version).
  const bin = () => join(root, "bin");
  const { app, page } = await launch([], (r) => {
    const dirs = { bin: join(r, "bin"), home: join(r, "home"), appdata: join(r, "appdata"), local: join(r, "localappdata") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    mkdirSync(join(dirs.home, ".local", "bin"), { recursive: true });
    writeFileSync(join(dirs.home, ".local", "bin", "claude.exe"), "not a program");
    return { PATH: [dirs.bin, join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(";"), USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.local };
  });
  const form = page.getByRole("form", { name: "登录" });
  await form.getByLabel("服务器地址").fill(server.url.replace("http://", ""));
  await form.getByLabel("名字").fill("小王");
  await form.getByLabel("密码").fill("secret");
  await form.getByRole("button", { name: "登录" }).click();
  await expect(page.getByTestId("pf-connection")).toContainText("服务器在线", { timeout: 20_000 });
  await page.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "环境" }).click();
  await expect(page.getByRole("heading", { name: "环境" })).toBeVisible();

  const item = (id: string) => page.getByTestId(`env-${id}`);
  const envStatus = (id: string) => page.getByTestId(`env-${id}-status`);
  await expect(envStatus("claude")).toHaveText("! 需要注意", { timeout: 30_000 });
  await expect(page.getByTestId("env-claude-note")).toContainText("没有回应 claude --version");
  await expect(item("claude")).toContainText(join(root, "home", ".local", "bin", "claude.exe"));
  await expect(item("claude")).toContainText("用在：Studio 里的 Claude 订阅、GLM 等 Claude 渠道");
  await expect(item("claude").locator("code").last()).toHaveText("irm https://claude.ai/install.ps1 | iex");
  await expect(envStatus("dsh")).toHaveText("○ 没装 · 推荐装桌面版");
  await expect(page.getByTestId("env-dsh-note")).toContainText(join(root, "localappdata", "Programs", "DeepSeek Harness"));
  await expect(envStatus("codex")).toHaveText("○ 没装");
  await expect(envStatus("git")).toHaveText("○ 没装");
  await expect(item("git")).toContainText("用在：Review、项目");
  await screenshot(app, "platform", "P17-environment", page);

  // 去下载: the official pages, recorded instead of opened in tests; 复制: the install command.
  const external = () => app.evaluate(() => (globalThis as { __platformExternal?: string[] }).__platformExternal ?? []);
  await item("git").getByRole("button", { name: "去下载" }).click();
  await expect.poll(external).toEqual(["https://git-scm.com/install/windows"]);
  await item("dsh").getByRole("button", { name: "去下载" }).click();
  await item("claude").getByRole("button", { name: "去下载" }).click();
  await expect.poll(external).toEqual(["https://git-scm.com/install/windows", "https://www.deepseek.com/harness/", "https://code.claude.com/docs/en/setup"]);
  await item("claude").getByRole("button", { name: "复制" }).click();
  await expect(item("claude").getByRole("button", { name: "已复制" })).toBeVisible();
  expect(await app.evaluate(() => (globalThis as { __platformCopied?: string }).__platformCopied)).toBe("irm https://claude.ai/install.ps1 | iex");

  // Codex installed since: 重新检测 finds it (the page keeps the last check until then).
  writeFileSync(join(bin(), "codex.cmd"), "@echo off\r\necho codex-cli 0.161.0\r\n");
  await page.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "工具" }).click();
  await page.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "环境" }).click();
  await expect(envStatus("codex")).toHaveText("○ 没装");
  await page.getByRole("button", { name: "重新检测" }).click();
  await expect(envStatus("codex")).toHaveText("✓ 已安装 · 0.161.0", { timeout: 30_000 });
  await expect(item("codex")).toContainText(join(root, "bin", "codex.cmd"));
  await expect(item("codex").getByRole("button", { name: "去下载" })).toHaveCount(0);
  await item("git").scrollIntoViewIfNeeded();
  await screenshot(app, "platform", "P18-environment-rechecked", page);
});

test("AMO 中转 from the platform (2026-10-28): listed after Studio as 「AMO 中转」, installed, opened with the team server's address, updated", async () => {
  const own = await startFakePlatformServer({ users: { 小王: "secret" }, gzip: true });
  try {
    // A stand-in relay client: records what it was started with (the server the platform hands it).
    const relayTool = (version: string) => ({ ...tool("relay", version), "run.cmd": `@echo off\r\necho relay ${version} %*>"%AMO_FAKE_TOOL_MARK%.relay"\r\n` });
    own.publish("studio", "0.9.0", tool("studio", "0.9.0"), { name: "AMO Studio", exe: "run.cmd", notes: "- 看板、任务、会话" });
    own.publish("notes", "1.0.0", tool("notes", "1.0.0"), { name: "AMO Notes", exe: "run.cmd" });
    own.publish("relay", "0.9.0", relayTool("0.9.0"), { name: "AMO Relay", exe: "run.cmd", notes: "- 第一个从 AMO 平台发布的版本" });
    const { app, page } = await launch();
    const form = page.getByRole("form", { name: "登录" });
    await form.getByLabel("服务器地址").fill(own.url.replace("http://", ""));
    await form.getByLabel("名字").fill("小王");
    await form.getByLabel("密码").fill("secret");
    await form.getByRole("button", { name: "登录" }).click();
    await expect(status(page, "relay")).toHaveText("○ 没装 · 服务器上是 0.9.0");
    await expect(row(page, "relay")).toContainText("AMO 中转");
    await expect(row(page, "relay")).toContainText("界面由服务器更新，桌面程序在这里更新");
    // Studio first, then AMO 中转, then the 便签 that Studio already carries.
    const order = await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")!).filter((id) => /^tool-[a-z]+$/.test(id)));
    expect(order).toEqual(["tool-studio", "tool-relay", "tool-notes"]);

    await row(page, "relay").getByRole("button", { name: "安装" }).click();
    await expect(status(page, "relay")).toHaveText("✓ 0.9.0 · 已是最新");
    expect(programs().tools.relay).toEqual({ version: "0.9.0", dir: join(root, "local", "apps", "relay", "current"), exe: "run.cmd" });
    await screenshot(app, "platform", "P24-relay-installed", page);
    await row(page, "relay").getByRole("button", { name: "打开" }).click();
    await expect.poll(() => (existsSync(join(root, "launched.relay")) ? readFileSync(join(root, "launched.relay"), "utf8").trim() : "")).toBe(`relay 0.9.0 --server ${own.url}`);

    // A new shell published: updated here like the others (a relay from the platform never replaces its own files).
    own.publish("relay", "0.9.1", relayTool("0.9.1"), { name: "AMO Relay", exe: "run.cmd", notes: "- 外壳的一处修正" });
    await refresh(page);
    await expect(status(page, "relay")).toHaveText("! 0.9.0 · 有新版 0.9.1");
    await expect(row(page, "relay").locator(".pf-notes-text")).toContainText("外壳的一处修正");
    await screenshot(app, "platform", "P25-relay-update", page);
    await row(page, "relay").getByRole("button", { name: "更新到 0.9.1" }).click();
    await expect(status(page, "relay")).toHaveText("✓ 0.9.1 · 已是最新", { timeout: 20_000 });
    expect(programs().tools.relay!.version).toBe("0.9.1");
  } finally {
    await own.close();
  }
});
