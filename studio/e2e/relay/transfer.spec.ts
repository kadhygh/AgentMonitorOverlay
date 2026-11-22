import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { programLaunch } from "../support/packed.js";

// 传文件 (2026-11-23, plans/relay-file-transfer.md 第 2 项) in the desktop client, against a real service in this process:
// 老戴 on two computers (台式机, 笔记本) and 老李 on one. 老戴 sends a folder (a file of more than one 8 MB piece in it,
// an empty file, an empty folder) and a file from his 台式机 to 老李's computer and to his own 笔记本; the 笔记本 declines,
// 老李 accepts into a folder that already has one of the same name (it becomes 「素材 (1)」); the bytes go up and down
// in pieces and land checked; both sides end with 已收到 / 都收到了 and the service drops the content. Needs `npm run
// relay:release` first (release/relay/client), like relay.spec.ts.

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const built = join(process.env.AMO_RELAY_E2E_RELEASE ?? join(studio, "release", "relay"), "client");
const shots = join(studio, "screenshots", "relay");
const relay = (await import(pathToFileURL(join(studio, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");

let root: string;
let store: InstanceType<typeof relay.RelayStore>;
let server: Awaited<ReturnType<typeof relay.startRelayServer>>;
const apps: ElectronApplication[] = [];
const pageErrors: string[] = [];

test.beforeAll(async () => {
  test.skip(!existsSync(join(built, "manifest.json")), "run npm run relay:release first");
  root = mkdtempSync(join(tmpdir(), "relay-e2e-xfer-"));
  cpSync(built, join(root, "public", "client"), { recursive: true });
  store = new relay.RelayStore(join(root, "server", "relay.db"));
  server = await relay.startRelayServer({ store, publicDir: join(root, "public"), filesDir: join(root, "files"), transfersDir: join(root, "transfers"), host: "127.0.0.1", port: 0, name: "测试组", clientWatchMs: 300, transferFreeBytes: async () => 100 * 1024 ** 3 });
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await server?.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function launch(who: string): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = join(root, who);
  const launched = programLaunch("relay-app", join(studio, "packages", "relay-app", "dist", "main.js"));
  // AMO_HOME is each client's own: its own device.json, as on three computers.
  const app = await _electron.launch({
    executablePath: launched.executablePath,
    args: [...launched.args, "--server", server.url],
    env: { ...process.env, AMO_RELAY_HOME: home, AMO_HOME: join(home, "amo-home"), AMO_STUDIO_HOME: join(home, "studio-home"), AMO_RELAY_TEST: "1", COMPUTERNAME: who },
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.stack ?? e.message}`));
  return { app, page, home };
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}

async function login(page: Page, name: string): Promise<void> {
  await expect(page.getByRole("button", { name: "没有账号？注册一个" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("名字").fill(name);
  await page.getByLabel("密码", { exact: true }).fill("pw-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".view-tabs")).toBeVisible();
}

/** The next system picker in that client answers with these paths. */
const queuePick = (app: ElectronApplication, paths: string[] | null) => app.evaluate((_e, p) => (globalThis as unknown as { __relayQueuePick: (p: string[] | null) => void }).__relayQueuePick(p), paths);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("a folder and a file to another person's computer and to my own other one: accepted, declined, sent in pieces, saved under free names", async () => {
  test.setTimeout(180_000);
  const anon = new relay.RelayClient(server.url);
  await anon.register("老戴", "pw-1234", { role: "策划" });
  await anon.register("老李", "pw-1234", { role: "程序" });
  const desk = await launch("台式机");
  await login(desk.page, "老戴");
  const laptop = await launch("笔记本");
  await login(laptop.page, "老戴");
  const li = await launch("老李的电脑");
  await login(li.page, "老李");

  // What 老戴 sends: a folder with a file of two pieces, an empty file and an empty folder; and a file beside it.
  const src = join(root, "src");
  mkdirSync(join(src, "素材", "ui"), { recursive: true });
  mkdirSync(join(src, "素材", "空文件夹"), { recursive: true });
  const big = Buffer.alloc(9 * 1024 * 1024 + 123);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
  writeFileSync(join(src, "素材", "ui", "atlas.bin"), big);
  writeFileSync(join(src, "素材", "空.txt"), "");
  writeFileSync(join(src, "说明.md"), "# 素材说明\n\n这一批是战斗 UI。");
  // 老李 already has a 素材 where things are saved.
  const liInbox = join(li.home, "Downloads", "AMO 中转");
  mkdirSync(join(liInbox, "素材"), { recursive: true });
  writeFileSync(join(liInbox, "素材", "旧的.txt"), "old");

  await desk.page.locator(".view-tab", { hasText: "传文件" }).click();
  await expect(desk.page.locator(".scope-nav")).toContainText("这台电脑：台式机");
  await desk.page.getByRole("button", { name: "＋ 发文件" }).first().click();
  const dialog = desk.page.getByRole("dialog", { name: "发文件" });
  await queuePick(desk.app, [join(src, "素材")]);
  await dialog.getByRole("button", { name: "选文件夹" }).click();
  await queuePick(desk.app, [join(src, "说明.md")]);
  await dialog.getByRole("button", { name: "选文件", exact: true }).click();
  await expect(dialog.locator(".xfer-roots .att")).toHaveCount(2);
  await expect(dialog).toContainText("3 个文件，共 9.0 MB");
  // My other computer and 老李's, both online.
  await expect(dialog.locator('.xfer-person[data-person="老戴"] .att')).toHaveText(/笔记本/);
  await expect(dialog.locator('.xfer-person[data-person="老李"] .att .dot.on')).toHaveCount(1);
  await dialog.locator('.xfer-person[data-person="老戴"] .att', { hasText: "笔记本" }).click();
  await dialog.locator('.xfer-person[data-person="老李"] .att', { hasText: "老李的电脑" }).click();
  await shot(desk.app, "44-transfer-send");
  await dialog.getByRole("button", { name: "发出" }).click();
  await expect(dialog).toHaveCount(0);
  const card = (page: Page) => page.locator(".xfer-card").first();
  await expect(card(desk.page)).toContainText("素材 等 2 项");
  await expect(card(desk.page)).toContainText("等对方确认");

  // The 笔记本 hears of it on the tab and declines; 老李 too, and accepts into his folder.
  await expect(laptop.page.locator(".view-tab", { hasText: "传文件" }).locator(".badge")).toHaveText("1");
  await laptop.page.locator(".view-tab", { hasText: "传文件" }).click();
  await expect(card(laptop.page)).toContainText("等你确认");
  await card(laptop.page).getByRole("button", { name: "拒绝" }).click();
  await expect(card(desk.page)).toContainText("笔记本：拒绝了");

  await expect(li.page.locator(".view-tab", { hasText: "传文件" }).locator(".badge")).toHaveText("1");
  await li.page.locator(".view-tab", { hasText: "传文件" }).click();
  await shot(li.app, "45-transfer-pending");
  await card(li.page).getByRole("button", { name: "接收…" }).click();
  const accept = li.page.getByRole("dialog", { name: "接收文件" });
  await expect(accept).toContainText("素材/ui/atlas.bin");
  await expect(accept).toContainText("素材/空文件夹/");
  await expect(accept.locator(".xfer-dir-path")).toHaveText(liInbox);
  await shot(li.app, "46-transfer-accept");
  await accept.getByRole("button", { name: "接收", exact: true }).click();
  await expect(accept).toHaveCount(0);

  // Up from the 台式机, down to 老李's, in pieces; both end done.
  await li.page.locator(".scope-nav .nav-row", { hasText: "收到的" }).click();
  await expect(card(li.page)).toContainText("已收到", { timeout: 60_000 });
  await expect(card(desk.page)).toContainText("都收到了", { timeout: 30_000 });
  await expect(card(desk.page)).toContainText("老李的电脑：已收完");
  expect(sha(join(liInbox, "素材 (1)", "ui", "atlas.bin"))).toBe(sha(join(src, "素材", "ui", "atlas.bin")));
  expect(readFileSync(join(liInbox, "素材 (1)", "空.txt"), "utf8")).toBe("");
  expect(existsSync(join(liInbox, "素材 (1)", "空文件夹"))).toBe(true);
  expect(readFileSync(join(liInbox, "说明.md"), "utf8")).toContain("战斗 UI");
  expect(readFileSync(join(liInbox, "素材", "旧的.txt"), "utf8")).toBe("old");
  expect(readdirSync(join(liInbox, "素材 (1)", "ui"))).toEqual(["atlas.bin"]);
  // The service keeps nothing once everyone is done.
  expect(readdirSync(join(root, "transfers"))).toEqual([]);
  await shot(li.app, "47-transfer-received");
  await shot(desk.app, "48-transfer-sent");

  // 打开文件夹 shows where it went (recorded in tests, no Explorer window).
  await card(li.page).getByRole("button", { name: "打开文件夹" }).click();
  await expect.poll(() => li.app.evaluate(() => (globalThis as unknown as { __relayOpened: () => string[] }).__relayOpened())).toEqual([liInbox]);
  expect(pageErrors).toEqual([]);
});
