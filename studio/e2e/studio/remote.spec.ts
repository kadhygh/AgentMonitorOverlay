import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程, step 1 (plans/remote-session.md, 2026-10-29): two Studios on this machine, each with its own AMO_HOME logged in
// (as the AMO platform would) to a relay service started here on a free port — never the team server. B asks A's
// account to pair; A sees it beside 设置 and on Focus and allows; both list the other and 测试连接 goes round; A ends it
// and B's list empties too.

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
async function home(name: string, key: string, device: string): Promise<string> {
  const dir = join(root, `home-${name}`);
  await account.saveAccount({ server: server!.url, name, key }, { env: { AMO_HOME: dir } });
  account.setDeviceName(device, { env: { AMO_HOME: dir } });
  return dir;
}

async function openRemote(page: Page) {
  await page.getByRole("button", { name: "设置" }).first().click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: /远程/ }).click();
  return dialog;
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

  // B: connected as itself, nothing paired yet.
  const bDialog = await openRemote(b.page);
  await expect(bDialog.getByTestId("remote-account")).toContainText("笔记本的我");
  await expect(bDialog.getByTestId("remote-connection")).toHaveAttribute("data-state", "online", { timeout: 20_000 });
  await expect(bDialog.getByTestId("remote-device-name")).toHaveValue("B 笔记本");
  await expect(bDialog.getByTestId("remote-no-peers")).toBeVisible();
  await expect(bDialog.getByTestId("remote-own-only")).toHaveText("只配对你自己的其他设备：远程会话用的是这台电脑上的模型账号，个人订阅不能给别人用。");

  const aFocus = await turnOnFocus(a.page, a.app);
  await expect(aFocus.getByTestId("focus-needs")).toHaveText("没有待处理");

  // B asks A's account.
  await bDialog.getByTestId("remote-pair-account").fill("台式机的我");
  await bDialog.getByTestId("remote-pair-send").click();
  await expect(bDialog.getByTestId("remote-outgoing")).toContainText("等 台式机的我 回复");
  await screenshot(b.app, "studio", "remote-b-asked", b.page);

  // A: a dot beside 设置, and the request on Focus.
  await expect(a.page.getByTestId("settings-dot")).toBeVisible({ timeout: 20_000 });
  const request = aFocus.getByTestId("focus-pair-request");
  await expect(request).toContainText("配对请求 · 笔记本的我（B 笔记本）");
  await expect(aFocus.getByTestId("focus-needs")).toHaveText("需要你 1");
  await screenshot(a.app, "studio", "remote-focus-request", aFocus, "focus");

  // 「在设置里看」 opens 设置 → 远程 in the workbench, where the request waits too.
  await request.getByTestId("focus-pair-settings").click();
  const aDialog = a.page.getByRole("dialog", { name: "设置" });
  await expect(aDialog.getByRole("tab", { name: /远程/ })).toHaveAttribute("aria-selected", "true");
  await expect(aDialog.getByTestId("settings-remote-dot")).toBeVisible();
  await expect(aDialog.getByTestId("remote-request")).toContainText("笔记本的我（B 笔记本）想和这台电脑配对");
  await screenshot(a.app, "studio", "remote-a-request", a.page);

  // Allowed on Focus: it leaves Focus and the settings page, and the dots go.
  await request.getByTestId("focus-pair-allow").click();
  await expect(aFocus.getByTestId("focus-pair-request")).toHaveCount(0);
  await expect(aFocus.getByTestId("focus-needs")).toHaveText("没有待处理");
  await expect(aDialog.getByTestId("remote-request")).toHaveCount(0);
  await expect(a.page.getByTestId("settings-dot")).toHaveCount(0);
  const aPeer = aDialog.getByTestId("remote-peer");
  await expect(aPeer).toHaveCount(1);
  await expect(aPeer).toContainText("B 笔记本");
  await expect(aPeer).toContainText("笔记本的我");
  await expect(aPeer.getByTestId("remote-presence")).toHaveText("在线");
  await expect(aPeer).toContainText("这台电脑允许了它");

  // B: A is there, online; the request is gone from its list.
  const bPeer = bDialog.getByTestId("remote-peer");
  await expect(bPeer).toHaveCount(1, { timeout: 20_000 });
  await expect(bPeer).toContainText("A 台式机");
  await expect(bPeer).toContainText("它允许了这台电脑");
  await expect(bDialog.getByTestId("remote-outgoing")).toHaveCount(0);

  // 测试连接 both ways.
  await bPeer.getByTestId("remote-ping").click();
  await expect(bPeer.getByTestId("remote-ping-result")).toHaveText(/^对方在线，往返 \d+ 毫秒$/);
  await aPeer.getByTestId("remote-ping").click();
  await expect(aPeer.getByTestId("remote-ping-result")).toHaveText(/^对方在线，往返 \d+ 毫秒$/);
  await screenshot(b.app, "studio", "remote-b-paired", b.page);
  await screenshot(a.app, "studio", "remote-a-paired", a.page);

  // A ends it, after reading what that means; B's list empties by itself.
  await aPeer.getByTestId("remote-unpair").click();
  const confirm = a.page.getByTestId("remote-unpair-confirm");
  await expect(confirm).toContainText("解除和「B 笔记本」的配对？");
  await expect(confirm).toContainText("两边的「已配对的设备」里都不再有对方");
  await screenshot(a.app, "studio", "remote-unpair-confirm", a.page);
  await confirm.getByTestId("confirm-action").click();
  await expect(aDialog.getByTestId("remote-peer")).toHaveCount(0);
  await expect(aDialog.getByTestId("remote-no-peers")).toBeVisible();
  await expect(bDialog.getByTestId("remote-peer")).toHaveCount(0, { timeout: 20_000 });
  await expect(bDialog.getByTestId("remote-no-peers")).toBeVisible();
});

test("without the AMO platform's login, 远程 says where to log in and the rest of Studio works", async () => {
  // launchStudio's own AMO_HOME: an empty folder, nobody logged in.
  const s = await launchStudio();
  studios.push(s);
  const dialog = await openRemote(s.page);
  await expect(dialog.getByTestId("remote-account")).toHaveText("没有登录：在 AMO 平台里登录后才能用远程功能");
  await expect(dialog.getByTestId("remote-login-hint")).toContainText("登录只在 AMO 平台里做");
  await expect(dialog.getByTestId("remote-peers")).toHaveCount(0);
  await expect(dialog.getByTestId("remote-pair")).toHaveCount(0);
  await screenshot(s.app, "studio", "remote-no-login", s.page);
  await dialog.getByRole("tab", { name: "界面" }).click();
  await expect(dialog.getByRole("tab", { name: "界面" })).toHaveAttribute("aria-selected", "true");
});
