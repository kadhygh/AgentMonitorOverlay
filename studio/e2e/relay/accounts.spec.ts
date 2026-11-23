import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, chromium, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { programLaunch } from "../support/packed.js";

// 账号类型 (2026-11-23, the user: 服务器后台可以设置账号类型，比如测试账号。然后停用和测试账号不在聊天列表里显示。服务器的账号
// 管理也要根据状态来排序账号): a test account and a turned-off one, both with chats with 程序老李 — left out of his 私聊 list,
// of who a group shows, of @, of 拉人 and of 发起协作's people, while what they wrote stays; 成员 keeps them folded at its
// foot; a kind set on the admin page reaches the client at once. The admin page (in the system's Edge) lists 正常 → 测试 →
// 已停用 under a heading each, a kind picked per account. Light and dark. Needs `npm run relay:release` first.

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
  root = mkdtempSync(join(tmpdir(), "relay-e2e-accounts-"));
  cpSync(built, join(root, "public", "client"), { recursive: true });
  store = new relay.RelayStore(join(root, "server", "relay.db"));
  server = await relay.startRelayServer({ store, publicDir: join(root, "public"), filesDir: join(root, "files"), transfersDir: join(root, "transfers"), host: "127.0.0.1", port: 0, name: "战斗组" });
  store.setAdminPassword("admin-pw");
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await server?.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function shot(app: ElectronApplication, name: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}
const theme = (page: Page, t: "light" | "dark") => page.evaluate((t) => (document.documentElement.dataset.theme = t), t);
const admin = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-amo-admin": "admin-pw" }, body: JSON.stringify(body) }).then((r) => expect(r.status).toBe(200));
const rail = (page: Page, name: string) => page.locator(".rail-item", { hasText: name }).click();
const person = (page: Page, name: string) => page.locator(`.person-node[data-person="${name}"]`);

test("测试 and turned-off accounts: out of the chat list and the pickers, their messages kept, folded at 成员's foot; the kind set on the admin page arrives at once", async () => {
  test.setTimeout(120_000);
  const planner = new relay.RelayClient(server.url, store.register("策划小王", "pw-1234", "策划").key);
  const zhao = new relay.RelayClient(server.url, store.register("测试小赵", "pw-1234", "测试用").key);
  const zhou = new relay.RelayClient(server.url, store.register("离职老周", "pw-1234", "美术").key);

  const home = join(root, "coder");
  const launched = programLaunch("relay-app", join(studio, "packages", "relay-app", "dist", "main.js"));
  const app = await _electron.launch({ executablePath: launched.executablePath, args: [...launched.args, "--server", server.url], env: { ...process.env, AMO_RELAY_HOME: home, AMO_HOME: join(home, "amo-home"), AMO_STUDIO_DATA_DIR: join(home, "studio-data") } });
  apps.push(app);
  const page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
  await expect(page.getByRole("button", { name: "没有账号？注册一个" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "没有账号？注册一个" }).click();
  await page.getByLabel("名字").fill("程序老李");
  await page.getByLabel("密码", { exact: true }).fill("pw-1234");
  await page.getByLabel("再输一次密码").fill("pw-1234");
  await page.getByLabel(/负责什么/).fill("程序 · 战斗");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.locator(".rail")).toBeVisible();

  // Chats with each of them, and a group the test account wrote in; then they become 测试 and 停用.
  const d1 = await zhao.direct("程序老李");
  await zhao.send(d1.id, { kind: "text", body: "我是测试号，来试一下私聊" });
  const d2 = await zhou.direct("程序老李");
  await zhou.send(d2.id, { kind: "text", body: "交接文档放在共享盘了" });
  const g = await planner.direct("程序老李");
  await planner.send(g.id, { kind: "text", body: "下午对一下数值" });
  await planner.addMembers(g.id, ["测试小赵"]);
  await zhao.send(g.id, { kind: "text", body: "测试号在群里说的话" });
  await admin("/api/admin/kind", { name: "测试小赵", kind: "test" });
  await admin("/api/admin/disable", { name: "离职老周", disabled: true });

  await theme(page, "light");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await rail(page, "聊天");
  // 私聊: only 策划小王; the group shows two people, and what the test account wrote is still there.
  await expect(person(page, "策划小王")).toBeVisible();
  await expect(person(page, "测试小赵")).toHaveCount(0);
  await expect(person(page, "离职老周")).toHaveCount(0);
  await page.locator(".chat-row.group").first().click();
  await expect(page.locator(".page-head .faces .face")).toHaveCount(2);
  await expect(page.locator(".page-head .faces")).toContainText("2 人");
  await expect(page.locator(".view")).toContainText("测试号在群里说的话");
  // The group read, nothing is left to count: their plain chats with me are not in the list, so not in 聊天's badge.
  await expect(page.locator(".rail-item", { hasText: "聊天" }).locator(".badge")).toHaveCount(0);
  // @: the people offered are the listed ones.
  const box = page.locator(".mention-box textarea");
  await box.fill("@");
  await expect(page.locator(".mention-pop [role=option]").first()).toBeVisible();
  await expect(page.locator(".mention-pop")).toContainText("策划小王");
  await expect(page.locator(".mention-pop")).not.toContainText("测试小赵");
  await expect(page.locator(".mention-pop")).not.toContainText("离职老周");
  await box.fill("");
  // 拉人: nobody left to bring in (策划小王 is here; the other two are not offered).
  await page.getByRole("button", { name: "＋ 拉人" }).click();
  await expect(page.locator(".overlay .dialog")).toContainText("大家都在这里了。");
  await page.locator(".overlay .dialog").getByRole("button", { name: "取消" }).click();
  await shot(app, "K01-chat-group-hidden-left-out");

  // 发起协作: the people to bring in are the listed ones.
  await rail(page, "协作");
  await page.getByRole("button", { name: "＋ 发起协作" }).click();
  const pick = page.locator(".cw-pick-people");
  await expect(pick).toContainText("策划小王");
  await expect(pick).not.toContainText("测试小赵");
  await expect(pick).not.toContainText("离职老周");
  await page.locator(".overlay .dialog").getByRole("button", { name: "取消" }).click();

  // 成员: the two at the foot, folded; opened, each says why.
  await rail(page, "成员");
  const fold = page.getByTestId("people-hidden");
  await expect(fold).toHaveText("▸ 已停用 / 测试账号 2");
  await expect(page.locator(".person-row", { hasText: "测试小赵" })).toHaveCount(0);
  await shot(app, "K02-members-folded");
  await fold.click();
  await expect(page.locator(".person-row", { hasText: "测试小赵" })).toContainText("测试账号");
  await expect(page.locator(".person-row", { hasText: "离职老周" })).toContainText("! 已停用");
  await shot(app, "K03-members-hidden-open");
  await theme(page, "dark");
  await shot(app, "K04-members-hidden-open-dark");
  await theme(page, "light");

  // Set on the admin page, it arrives at once: 策划小王 as a test account leaves the 私聊 list, and comes back.
  await admin("/api/admin/kind", { name: "策划小王", kind: "test" });
  await expect(fold).toHaveText("▾ 已停用 / 测试账号 3");
  await rail(page, "聊天");
  await expect(person(page, "策划小王")).toHaveCount(0);
  await admin("/api/admin/kind", { name: "策划小王", kind: "normal" });
  await expect(person(page, "策划小王")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("the admin page: 正常, then 测试, then 已停用, each under its heading; a kind picked per account", async () => {
  // Sorted by the service: within 正常 the one online first. This test's accounts are from the one above, plus two more.
  store.register("美术小孙", "pw-1234", "美术");
  store.register("测试小钱", "pw-1234", "测试用");
  store.setKind("测试小钱", "test");
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
      await page.goto(`${server.url}/admin`);
      await page.locator("#pw").fill("admin-pw");
      await page.getByRole("button", { name: "进入" }).click();
      await expect(page.locator("#rows tr[data-name]")).toHaveCount(6);
      expect(await page.locator("#rows tr.part").allTextContents()).toEqual(["正常 · 3", "测试账号 · 2", "已停用 · 1"]);
      const names = await page.locator("#rows tr[data-name]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-name")));
      expect(names.slice(3)).toEqual(["测试小赵", "测试小钱", "离职老周"]);
      expect(names.slice(0, 3).sort()).toEqual(["程序老李", "策划小王", "美术小孙"].sort());
      // 程序老李's client is still open: online, so first.
      expect(names[0]).toBe("程序老李");
      await expect(page.locator('#rows tr[data-name="离职老周"]')).toContainText("! 已停用");
      await expect(page.locator('#rows tr[data-name="测试小赵"] select')).toHaveValue("test");
      await page.screenshot({ path: join(shots, `K1${scheme === "light" ? "0" : "1"}-admin-kinds${scheme === "light" ? "" : "-dark"}.png`), fullPage: false });
      await page.close();
    }
    // Picking a kind saves it: 美术小孙 moves to the 测试 part.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${server.url}/admin`);
    await page.locator("#pw").fill("admin-pw");
    await page.getByRole("button", { name: "进入" }).click();
    await page.locator('#rows tr[data-name="美术小孙"] select').selectOption("test");
    await expect(page.locator("#msg")).toContainText("「美术小孙」现在是测试账号");
    await expect(page.locator("#rows tr.part")).toContainText(["正常 · 2", "测试账号 · 3", "已停用 · 1"]);
    expect(store.members().find((m) => m.name === "美术小孙")?.kind).toBe("test");
  } finally {
    await browser.close();
  }
});
