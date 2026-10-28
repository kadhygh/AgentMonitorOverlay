/// <reference lib="dom" />
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import { screenshot, studioRoot } from "../support/studio.js";

// AMO 平台 (plans/amo-lan-platform.md, step 2) against testkit's fake team server: log in, install a stand-in tool
// (a .cmd, not a real build), a new version published → update, 回滚, 卸载; Studio only opens once its data dir is set.
// Everything under temp folders (AMO_HOME, AMO_LOCAL_HOME): the real %APPDATA%\AMO and %LOCALAPPDATA%\AMO stay untouched.

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
  server = await startFakePlatformServer({ users: { 小王: "secret" } });
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

async function launch(args: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  root = mkdtempSync(join(tmpdir(), "amo-platform-e2e-"));
  app = await _electron.launch({ executablePath: electronPath, args: [MAIN, ...args], env: cleanEnv() });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

const programs = () => JSON.parse(readFileSync(join(root, "roaming", "programs.json"), "utf8")) as { tools: Record<string, { version: string; dir: string; exe: string }> };
const row = (page: Page, id: string) => page.getByTestId(`tool-${id}`);
const status = (page: Page, id: string) => page.getByTestId(`tool-${id}-status`);
const result = (page: Page, id: string) => page.getByTestId(`tool-${id}-result`);
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
  await expect(result(page, "reviewer")).toHaveText(/已更新到 1\.1\.0（2 个文件和上一版一样，没有重新下载）/);
  expect(programs().tools.reviewer!.version).toBe("1.1.0");
  await screenshot(app, "platform", "P7-updated", page);

  // ---- 回滚
  await row(page, "reviewer").getByRole("button", { name: "回到 1.0.0" }).click();
  await expect(result(page, "reviewer")).toContainText("已回到 1.0.0");
  await expect(status(page, "reviewer")).toHaveText("! 1.0.0 · 有新版 1.1.0");
  expect(programs().tools.reviewer!.version).toBe("1.0.0");
  expect(readFileSync(join(root, "local", "apps", "reviewer", "current", "resources", "app.txt"), "utf8")).toBe("reviewer 1.0.0");
  await screenshot(app, "platform", "P8-rolled-back", page);

  // ---- 卸载 (asks first)
  await row(page, "reviewer").getByRole("button", { name: "卸载" }).click();
  const confirm = row(page, "reviewer").getByRole("group", { name: "卸载 AMO Reviewer" });
  await expect(confirm).toContainText("1.0.0 和留着的 1.1.0 都会删掉");
  await screenshot(app, "platform", "P9-uninstall-confirm", page);
  await confirm.getByRole("button", { name: "卸载" }).click();
  await expect(status(page, "reviewer")).toHaveText("○ 没装 · 服务器上是 1.1.0");
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

  // ---- 退出登录 → the login page, with the recent server and the name filled in
  await again.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "设置" }).click();
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
    await page.getByRole("navigation", { name: "页面" }).getByRole("button", { name: "设置" }).click();
    await expect(page.getByText("已登录：小李")).toBeVisible();
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
