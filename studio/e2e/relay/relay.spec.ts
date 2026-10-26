import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

// AMO 中转's desktop client (plans/relay.md) against a real service in this process: first start (loader → content
// download → login), register two people, a request sent by an AI through the command line the client installs,
// answered one by one in the other client, a direct chat, updates (installed by the loader at start; applied by itself
// while signed in, when the window is not in use), and the service going away and coming back (the bar, the login
// screen's status). Needs `npm run relay:release` first (release/relay/client).

// Async: the service runs in this process, so a blocking exec would stall it.
const exec = async (file: string, args: string[]) => (await promisify(execFile)(file, args, { encoding: "utf8" })).stdout;
const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const electronPath = createRequire(import.meta.url)("electron") as string;
const built = join(studio, "release", "relay", "client");
const shots = join(studio, "screenshots", "relay");

const relay = await import(pathToFileURL(join(studio, "packages", "relay", "dist", "index.js")).href) as typeof import("../../packages/relay/src/index.js");

let root: string;
let publicDir: string;
let store: InstanceType<typeof relay.RelayStore>;
let server: Awaited<ReturnType<typeof relay.startRelayServer>>;
const apps: ElectronApplication[] = [];

test.beforeAll(async () => {
  test.skip(!existsSync(join(built, "manifest.json")), "run npm run relay:release first");
  root = mkdtempSync(join(tmpdir(), "relay-e2e-"));
  publicDir = join(root, "public");
  cpSync(built, join(publicDir, "client"), { recursive: true });
  store = new relay.RelayStore(join(root, "server", "relay.db"));
  server = await startServer(0);
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await server?.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const startServer = (port: number) => relay.startRelayServer({ store, publicDir, host: "127.0.0.1", port, name: "测试组", clientWatchMs: 300 });

async function launch(who: string): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = join(root, who);
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(studio, "packages", "relay-app", "dist", "main.js"), "--server", server.url],
    env: { ...process.env, AMO_RELAY_HOME: home, AMO_RELAY_TEST: "1" },
  });
  apps.push(app);
  const page = await app.firstWindow();
  return { app, page, home };
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}

async function register(page: Page, name: string, role: string): Promise<void> {
  await expect(page.getByRole("button", { name: "没有账号？注册一个" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "没有账号？注册一个" }).click();
  await page.getByLabel("名字").fill(name);
  await page.getByLabel("密码", { exact: true }).fill("pw-1234");
  await page.getByLabel("再输一次密码").fill("pw-1234");
  await page.getByLabel(/负责什么/).fill(role);
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("button", { name: "复制用法" })).toBeVisible();
}

test("register, an AI's request answered in the other client, updates, the service away and back", async () => {
  const a = await launch("planner");
  await register(a.page, "策划小王", "策划");
  const b = await launch("coder");
  await register(b.page, "程序老李", "程序 · 战斗");
  await shot(b.app, "01-home-empty");

  // The planner's AI asks through the command line the client installed (its own exe as Node).
  const cli = join(a.home, "amo-relay.cmd");
  expect(existsSync(cli)).toBe(true);
  const req = join(root, "req.json");
  writeFileSync(req, JSON.stringify({ to: "程序老李", title: "技能冷却按等级递减", body: "方案：每升 1 级冷却 **-0.5s**，最低 3s。\n\n| 等级 | 冷却 |\n|---|---|\n| 1 | 8s |\n| 10 | 3.5s |", questions: [{ text: "现在的技能表能直接加这一列吗", options: ["能", "要改结构"] }, { text: "大概要几天" }] }));
  const asked = await exec("cmd.exe", ["/c", cli, "ask", "--json", req]);
  expect(asked).toContain("已发给 程序老李");

  // The coder sees it waiting, answers one by one.
  await expect(b.page.locator(".group.hl")).toContainText("技能冷却按等级递减");
  await b.page.locator(".group.hl .item").first().click();
  await expect(b.page.locator(".msg.kind-request")).toContainText("最低 3s");
  await expect(b.page.locator(".tag.ai")).toContainText("AI 代发");
  await b.page.locator(".reply-form .opt", { hasText: "能" }).click();
  await b.page.locator(".reply-form .rq").nth(1).locator("input").fill("两天");
  await b.page.getByPlaceholder("补充说明（支持 Markdown）").fill("配置在 `skill.xlsx`，我来加列。");
  await b.page.locator(".vbtn", { hasText: "同意" }).click();
  await shot(b.app, "02-reply-form");
  await b.page.getByRole("button", { name: "发送回复" }).click();
  await expect(b.page.locator(".msg.kind-reply")).toContainText("两天");

  // The planner sees the answer; the AI reads it back through the command line.
  await a.page.locator(".item", { hasText: "技能冷却按等级递减" }).click();
  await expect(a.page.locator(".msg.kind-reply .verdict")).toContainText("同意");
  await shot(a.app, "03-planner-reply");
  const threadId = /threadId: (\S+)/.exec(asked)![1]!;
  const replies = await exec("cmd.exe", ["/c", cli, "replies", threadId]);
  expect(replies).toContain("**现在的技能表能直接加这一列吗** → 能");

  // Direct chat both ways.
  await b.page.locator(".person", { hasText: "策划小王" }).click();
  await b.page.getByPlaceholder("发给 策划小王…").fill("下午三点对一下数值？");
  await b.page.keyboard.press("Control+Enter");
  await a.page.locator(".group", { hasText: "私聊" }).locator(".item", { hasText: "程序老李" }).click();
  await expect(a.page.locator(".msg")).toContainText("下午三点对一下数值？");
  await shot(a.app, "05-direct-chat");

  // A newer client on the service: the planner restarts and the loader installs it before the login screen.
  const manifestFile = join(publicDir, "client", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { version: string };
  const publish = (version: string) => writeFileSync(manifestFile, JSON.stringify({ ...manifest, version }));
  const next = `${manifest.version}-next`;
  publish(next);
  await a.app.close();
  const again = await launch("planner");
  await expect(again.page.locator(".login-foot")).toContainText(next, { timeout: 30_000 });
  await expect(again.page.locator(".notice.update")).toHaveCount(0);
  await expect(again.page.locator(".server-line")).toContainText("服务器在线");
  await expect(again.page.getByLabel("密码", { exact: true })).toHaveValue("pw-1234");
  await again.page.getByRole("button", { name: "登录" }).click();
  await again.page.locator(".item", { hasText: "技能冷却按等级递减" }).click();
  await expect(again.page.locator(".conn-chip")).toHaveText("在线");

  // Published while signed in, the window closed to the tray (not in use): it updates by itself and comes back signed
  // in, the same conversation open.
  const third = `${manifest.version}-third`;
  publish(third);
  await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  await expect.poll(() => again.page.evaluate(async () => (await (window as unknown as { relayShell: { info(): Promise<{ contentVersion: string }> } }).relayShell.info()).contentVersion), { timeout: 30_000 }).toBe(third);
  await expect(again.page.locator(".item.on")).toContainText("技能冷却按等级递减", { timeout: 15_000 });
  await expect(again.page.locator(".msg.kind-reply")).toContainText("两天");
  await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive());

  // The service goes away: the bar over the conversation, members' state unknown; the other one logs out and its
  // login screen says the service is offline. It comes back: both see it without doing anything.
  const port = server.port;
  await server.close();
  await expect(again.page.locator(".conn-bar")).toContainText("和服务器断开了", { timeout: 15_000 });
  await expect(again.page.locator(".conn-chip")).toHaveText("离线");
  await expect(again.page.locator(".lists")).toContainText("在线状态未知");
  await shot(again.app, "06-offline-bar");
  await b.page.getByRole("button", { name: "退出" }).click();
  await expect(b.page.locator(".server-down")).toContainText("服务器离线", { timeout: 15_000 });
  await expect(b.page.getByRole("button", { name: /服务器离线/ })).toBeDisabled();
  await shot(b.app, "07-login-offline");
  server = await startServer(port);
  await again.page.getByRole("button", { name: "立即重连" }).click();
  await expect(again.page.locator(".conn-bar")).toHaveCount(0, { timeout: 15_000 });
  await expect(again.page.locator(".conn-chip")).toHaveText("在线");
  await expect(b.page.locator(".server-line")).toContainText("服务器在线", { timeout: 15_000 });
  await b.page.getByRole("button", { name: "登录" }).click();
  await expect(b.page.getByRole("button", { name: "复制用法" })).toBeVisible();
});
