/// <reference lib="dom" />
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

/** `machine` lays out a pretend machine under the temp root and returns the environment that points at it. */
async function launch(args: string[] = [], machine?: (root: string) => Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  root = mkdtempSync(join(tmpdir(), "amo-platform-e2e-"));
  app = await _electron.launch({ executablePath: electronPath, args: [MAIN, ...args], env: { ...cleanEnv(), ...machine?.(root) } });
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
    expect(existsSync(join(root, "local", "file-index.json"))).toBe(true);
    await screenshot(app!, "platform", "P17-shared-runtime", page);

    // The Reviewer uninstalled: the 便签's copy of the shared files is still whole.
    await row(page, "reviewer").getByRole("button", { name: "卸载" }).click();
    await row(page, "reviewer").getByRole("group", { name: "卸载 AMO Reviewer" }).getByRole("button", { name: "卸载" }).click();
    await expect(status(page, "reviewer")).toHaveText("○ 没装 · 服务器上是 1.0.0");
    expect(existsSync(join(apps, "reviewer"))).toBe(false);
    expect(readFileSync(join(apps, "notes", "current", "resources", "electron.pak"))).toEqual(runtime["resources/electron.pak"]);
    expect(readFileSync(join(apps, "notes", "current", "resources", "runtime.bin"), "utf8")).toBe("R".repeat(256 * 1024));
  } finally {
    await shared.close();
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
