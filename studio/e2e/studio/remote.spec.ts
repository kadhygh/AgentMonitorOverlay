import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程, step 1 (plans/remote-session.md, 2026-10-29): two Studios on this machine, each with its own AMO_HOME logged in
// (as the AMO platform would) to a relay service started here on a free port — never the team server. B asks A's
// account to pair; A sees it on the top bar's 「远程」 and on Focus and allows; both list the other and 测试连接 goes
// round; A ends it and B's list empties too. Since 2026-10-29 evening 远程 is a page of its own (the top bar's button,
// plans/remote-page-and-new-task.md), and the pair dialog lists the account's other online devices to pick from.

const relay = (await import(pathToFileURL(join(studioRoot, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");
const account = (await import(pathToFileURL(join(studioRoot, "packages", "account", "dist", "index.js")).href)) as typeof import("../../packages/account/src/index.js");

let root = "";
let store: InstanceType<typeof relay.RelayStore> | undefined;
let server: Awaited<ReturnType<typeof relay.startRelayServer>> | undefined;
const studios: Studio[] = [];

test.afterEach(async () => {
  for (const s of studios.splice(0)) await s.close().catch(() => undefined);
  await server?.close();
  store?.close();
  server = undefined;
  store = undefined;
  if (root) removeTempDir(root);
  root = "";
});

/** An AMO_HOME logged in as `name` to the test's relay (account.json encrypted for this Windows user, as the platform does). */
async function home(name: string, key: string, device: string, dirName = name): Promise<string> {
  const dir = join(root, `home-${dirName}`);
  await account.saveAccount({ server: server!.url, name, key }, { env: { AMO_HOME: dir } });
  account.setDeviceName(device, { env: { AMO_HOME: dir } });
  return dir;
}

/** The top bar's 「远程」 → the remote page. */
async function openRemote(page: Page) {
  await page.getByTestId("topbar-remote").click();
  const remote = page.getByRole("region", { name: "远程", exact: true });
  await expect(remote).toBeVisible();
  return remote;
}

async function turnOnFocus(page: Page, app: ElectronApplication): Promise<Page> {
  const toggle = page.getByRole("button", { name: /^Focus/ });
  const opened = app.waitForEvent("window");
  await toggle.click();
  return opened;
}

test("B asks to pair, A allows from Focus, both test the connection, A unpairs and B forgets it too", async () => {
  test.setTimeout(180_000);
  root = mkdtempSync(join(tmpdir(), "amo-remote-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const keyA = store.register("台式机的我", "pw-aaaa").key;
  const keyB = store.register("笔记本的我", "pw-bbbb").key;

  const a = await launchStudio({ env: { AMO_HOME: await home("台式机的我", keyA, "A 台式机") } });
  studios.push(a);
  const b = await launchStudio({ env: { AMO_HOME: await home("笔记本的我", keyB, "B 笔记本") } });
  studios.push(b);

  // B: connected as itself, nothing paired yet; the top bar says just 「远程」.
  await expect(b.page.getByTestId("topbar-remote")).toHaveText("远程");
  const bRemote = await openRemote(b.page);
  await expect(b.page.getByTestId("topbar-remote")).toHaveAttribute("aria-current", "page");
  await expect(bRemote.getByTestId("remote-account")).toHaveText("笔记本的我");
  await expect(bRemote.getByTestId("remote-connection")).toHaveAttribute("data-state", "online", { timeout: 20_000 });
  await expect(bRemote.getByTestId("remote-device-label")).toHaveText("B 笔记本");
  await expect(bRemote.getByTestId("remote-no-peers")).toBeVisible();
  // 等你处理 only when something waits.
  await expect(bRemote.getByTestId("remote-waiting")).toHaveCount(0);
  await expect(bRemote.getByTestId("remote-no-grants")).toBeVisible();
  await expect(bRemote.getByTestId("remote-no-copies")).toBeVisible();

  const aFocus = await turnOnFocus(a.page, a.app);
  await expect(aFocus.getByTestId("focus-needs")).toHaveText("没有待处理");

  // B asks A's account (another account: by name, folded in the pair dialog).
  await bRemote.getByTestId("remote-pair-open").click();
  const pair = b.page.getByTestId("remote-pair-dialog");
  await expect(pair.getByTestId("remote-own-only")).toHaveText("只配对你自己的其他设备：远程会话用的是这台电脑上的模型账号，个人订阅不能给别人用。");
  await expect(pair.getByTestId("remote-online-empty")).toBeVisible();
  await pair.getByTestId("remote-pair-by-account").click();
  await pair.getByTestId("remote-pair-account").fill("台式机的我");
  await pair.getByTestId("remote-pair-send").click();
  await expect(pair.getByTestId("remote-pair-outgoing")).toContainText("等 台式机的我 允许");
  await pair.getByTestId("remote-pair-close").click();
  await expect(pair).toHaveCount(0);
  await expect(bRemote.getByTestId("remote-outgoing")).toContainText("等 台式机的我 允许配对");
  await screenshot(b.app, "studio", "remote-b-asked", b.page);

  // A: a dot on the top bar's 「远程」 (none beside 设置 any more), and the request on Focus.
  await expect(a.page.getByTestId("topbar-remote-dot")).toBeVisible({ timeout: 20_000 });
  await expect(a.page.getByTestId("settings-dot")).toHaveCount(0);
  const request = aFocus.getByTestId("focus-pair-request");
  await expect(request).toContainText("配对请求 · 笔记本的我（B 笔记本）");
  await expect(aFocus.getByTestId("focus-needs")).toHaveText("需要你 1");
  await screenshot(a.app, "studio", "remote-focus-request", aFocus, "focus");

  // 「在远程页里看」 opens the remote page in the workbench, where the request waits under 「等你处理」.
  await expect(request.getByTestId("focus-pair-settings")).toHaveText("在远程页里看");
  await request.getByTestId("focus-pair-settings").click();
  const aRemote = a.page.getByRole("region", { name: "远程", exact: true });
  await expect(aRemote.getByTestId("remote-waiting").getByTestId("remote-request")).toContainText("笔记本的我（B 笔记本）想和这台电脑配对");
  await screenshot(a.app, "studio", "remote-a-request", a.page);

  // Allowed on Focus: it leaves Focus and the page, and the dot goes.
  await request.getByTestId("focus-pair-allow").click();
  await expect(aFocus.getByTestId("focus-pair-request")).toHaveCount(0);
  await expect(aFocus.getByTestId("focus-needs")).toHaveText("没有待处理");
  await expect(aRemote.getByTestId("remote-request")).toHaveCount(0);
  await expect(aRemote.getByTestId("remote-waiting")).toHaveCount(0);
  await expect(a.page.getByTestId("topbar-remote-dot")).toHaveCount(0);
  await expect(a.page.getByTestId("topbar-remote")).toHaveText("远程 · 1 在线");
  const aPeer = aRemote.getByTestId("remote-peer");
  await expect(aPeer).toHaveCount(1);
  await expect(aPeer).toContainText("B 笔记本");
  await expect(aPeer).toContainText("笔记本的我");
  await expect(aPeer.getByTestId("remote-presence")).toHaveText("在线");
  await expect(aPeer).toContainText("这台电脑允许了它");
  // Only a device that allowed this computer can run a task for it.
  await expect(aPeer.getByTestId("remote-new-task")).toHaveCount(0);

  // B: A is there, online; the request is gone from its list.
  const bPeer = bRemote.getByTestId("remote-peer");
  await expect(bPeer).toHaveCount(1, { timeout: 20_000 });
  await expect(bPeer).toContainText("A 台式机");
  await expect(bPeer).toContainText("它允许了这台电脑");
  await expect(bPeer.getByTestId("remote-new-task")).toHaveText("在它上面新建任务");
  await expect(bRemote.getByTestId("remote-outgoing")).toHaveCount(0);
  await expect(b.page.getByTestId("topbar-remote")).toHaveText("远程 · 1 在线");

  // 测试连接 both ways.
  await bPeer.getByTestId("remote-ping").click();
  await expect(bPeer.getByTestId("remote-ping-result")).toHaveText(/^对方在线，往返 \d+ 毫秒$/);
  await aPeer.getByTestId("remote-ping").click();
  await expect(aPeer.getByTestId("remote-ping-result")).toHaveText(/^对方在线，往返 \d+ 毫秒$/);
  await screenshot(b.app, "studio", "remote-b-paired", b.page);
  await screenshot(a.app, "studio", "remote-a-paired", a.page);

  // 远程设置: folded; the top line's button opens it. The device name is text until 改名.
  await expect(bRemote.getByTestId("remote-allowed")).toHaveCount(0);
  await bRemote.getByTestId("remote-settings-open").click();
  await expect(bRemote.getByTestId("remote-allowed")).toBeVisible();
  await expect(bRemote.getByTestId("remote-device-current")).toHaveText("B 笔记本");
  await expect(bRemote.getByTestId("remote-device-name")).toHaveCount(0);
  await bRemote.getByTestId("remote-device-rename").click();
  await bRemote.getByTestId("remote-device-name").fill("我的笔记本");
  await bRemote.getByTestId("remote-device-save").click();
  await expect(bRemote.getByTestId("remote-device-current")).toHaveText("我的笔记本");
  await expect(bRemote.getByTestId("remote-device-label")).toHaveText("我的笔记本");
  await expect(aPeer).toContainText("我的笔记本", { timeout: 20_000 });
  await screenshot(b.app, "studio", "remote-b-settings", b.page);

  // A ends it, after reading what that means; B's list empties by itself.
  await aPeer.getByTestId("remote-unpair").click();
  const confirm = a.page.getByTestId("remote-unpair-confirm");
  await expect(confirm).toContainText("解除和「我的笔记本」的配对？");
  await expect(confirm).toContainText("两边的「已配对的设备」里都不再有对方");
  await screenshot(a.app, "studio", "remote-unpair-confirm", a.page);
  await confirm.getByTestId("confirm-action").click();
  await expect(aRemote.getByTestId("remote-peer")).toHaveCount(0);
  await expect(aRemote.getByTestId("remote-no-peers")).toBeVisible();
  await expect(bRemote.getByTestId("remote-peer")).toHaveCount(0, { timeout: 20_000 });
  await expect(bRemote.getByTestId("remote-no-peers")).toBeVisible();
  await expect(b.page.getByTestId("topbar-remote")).toHaveText("远程");
  // ← returns to the board it was opened from.
  await b.page.getByTestId("back").click();
  await expect(b.page.getByRole("region", { name: "远程", exact: true })).toHaveCount(0);
  await expect(b.page.getByTestId("topbar-remote")).not.toHaveAttribute("aria-current", "page");
});

test("the pair dialog lists this account's other online devices; picking one asks it alone, and it allows", async () => {
  test.setTimeout(180_000);
  root = mkdtempSync(join(tmpdir(), "amo-remote-pair-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  // One account, two computers (as a person's desktop and laptop).
  const key = store.register("我", "pw-mine").key;
  const a = await launchStudio({ env: { AMO_HOME: await home("我", key, "台式机", "desk") } });
  studios.push(a);
  const b = await launchStudio({ env: { AMO_HOME: await home("我", key, "笔记本", "laptop") } });
  studios.push(b);

  const bRemote = await openRemote(b.page);
  await expect(bRemote.getByTestId("remote-connection")).toHaveAttribute("data-state", "online", { timeout: 20_000 });
  await bRemote.getByTestId("remote-pair-open").click();
  const pair = b.page.getByTestId("remote-pair-dialog");
  // A may connect a moment after B: 刷新 until it is there.
  await expect(async () => {
    await pair.getByTestId("remote-pair-refresh").click();
    await expect(pair.getByTestId("remote-online-device")).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  const desk = pair.getByTestId("remote-online-device").filter({ hasText: "台式机" });
  await expect(desk).toContainText(/上线/);
  // The by-account form stays folded: the account's own devices are the usual case.
  await expect(pair.getByTestId("remote-pair-account")).toHaveCount(0);
  await screenshot(b.app, "studio", "remote-pair-dialog", b.page);
  await desk.getByTestId("remote-pair-device").click();
  await expect(desk.getByTestId("remote-pair-waiting")).toHaveText("等 台式机 允许");
  await expect(desk.getByTestId("remote-pair-withdraw")).toHaveText("撤回");
  await screenshot(b.app, "studio", "remote-pair-waiting", b.page);

  // A: the dot, the request under 「等你处理」; allowed there.
  await expect(a.page.getByTestId("topbar-remote-dot")).toBeVisible({ timeout: 20_000 });
  const aRemote = await openRemote(a.page);
  const request = aRemote.getByTestId("remote-request");
  await expect(request).toContainText("我（笔记本）想和这台电脑配对");
  await request.getByTestId("remote-allow").click();
  await expect(aRemote.getByTestId("remote-message")).toHaveText("已和 我（笔记本）配对");
  await expect(a.page.getByTestId("topbar-remote-dot")).toHaveCount(0);
  await expect(a.page.getByTestId("topbar-remote")).toHaveText("远程 · 1 在线");

  // B: the dialog says 已配对; the card is on the page.
  await expect(desk.getByTestId("remote-online-paired")).toBeVisible({ timeout: 20_000 });
  await pair.getByTestId("remote-pair-close").click();
  await expect(bRemote.getByTestId("remote-peer")).toContainText("台式机");
  await expect(bRemote.getByTestId("remote-peer")).toContainText("它允许了这台电脑");
  await expect(b.page.getByTestId("topbar-remote")).toHaveText("远程 · 1 在线");
  await screenshot(b.app, "studio", "remote-page-paired", b.page);
});

test("without the AMO platform's login, 远程 says where to log in and the rest of Studio works", async () => {
  // launchStudio's own AMO_HOME: an empty folder, nobody logged in.
  const s = await launchStudio();
  studios.push(s);
  await expect(s.page.getByTestId("topbar-remote")).toHaveText("远程");
  await expect(s.page.getByTestId("topbar-remote-dot")).toHaveCount(0);
  const remote = await openRemote(s.page);
  await expect(remote.getByTestId("remote-account")).toHaveText("在 AMO 平台里登录");
  await expect(remote.getByTestId("remote-login-hint")).toContainText("登录只在 AMO 平台里做");
  await expect(remote.getByTestId("remote-peers")).toHaveCount(0);
  await expect(remote.getByTestId("remote-pair-open")).toHaveCount(0);
  await screenshot(s.app, "studio", "remote-no-login", s.page);

  // 设置 has no 远程 page any more, only the line saying where it went.
  await s.page.getByRole("button", { name: "设置" }).first().click();
  const dialog = s.page.getByRole("dialog", { name: "设置" });
  await expect(dialog.getByRole("tab", { name: /远程/ })).toHaveCount(0);
  await dialog.getByRole("tab", { name: "界面" }).click();
  await expect(dialog.getByTestId("settings-remote-moved")).toContainText("远程功能在顶栏的「远程」里");
  await dialog.getByTestId("settings-open-remote").click();
  await expect(dialog).toHaveCount(0);
  await expect(remote).toBeVisible();
});
