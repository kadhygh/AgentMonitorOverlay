import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RemoteState, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程, step 4 (plans/remote-session.md 方式 2, 2026-10-29): two Studios on this machine (each its own AMO_HOME and data,
// the mock model), paired through a relay service started here — never the team server. B asks A to run a task from
// 设置 → 远程; A's Focus shows the request; A picks the project and an allowed model and allows it; B's board shows the
// task, running. A refuses a second request with a reason, and B reads it.

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

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function turnOnFocus(page: Page, app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  return opened;
}

async function openRemoteSettings(page: Page) {
  await page.getByRole("button", { name: "设置" }).first().click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("tab", { name: /远程/ }).click();
  return settings;
}

test("B asks A to run a task; A's Focus shows it, A picks the project and an allowed model and allows it, B's board shows it running; A refuses another, B reads why", async () => {
  test.setTimeout(300_000);
  root = mkdtempSync(join(tmpdir(), "amo-remote-requests-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const home = async (name: string, key: string, device: string) => {
    const dir = join(root, `home-${name}`);
    await account.saveAccount({ server: server!.url, name, key }, { env: { AMO_HOME: dir } });
    account.setDeviceName(device, { env: { AMO_HOME: dir } });
    return dir;
  };
  const a = await launchStudio({ env: { AMO_HOME: await home("台式机的我", store.register("台式机的我", "pw-aaaa").key, "A 台式机") } });
  studios.push(a);
  const b = await launchStudio({ env: { AMO_HOME: await home("笔记本的我", store.register("笔记本的我", "pw-bbbb").key, "B 笔记本") } });
  studios.push(b);
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "B online");
  await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "A online");
  await b.api("POST", "/api/remote/pair", { account: "台式机的我" });
  const asked = await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.incoming.length === 1, "A sees the pairing request");
  await a.api("POST", `/api/remote/requests/${asked.incoming[0]!.id}/answer`, { allow: true });
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.peers[0]?.online === true, "B sees A online");
  // A: a project to put the task in, and the model remote work may use (设置 → 远程 → 远端允许的模型).
  const proj = await a.api<Workspace>("POST", "/api/workspaces", { path: a.workspace("请求的项目") });
  await a.api("PUT", "/api/remote/allowed", { profiles: ["codex-mock"], defaultProfile: "codex-mock", permission: null });
  const aFocus = await turnOnFocus(a.page, a.app);

  // B: 设置 → 远程 → the paired device → 请它跑一个任务….
  const bSettings = await openRemoteSettings(b.page);
  const peer = bSettings.getByTestId("remote-peer").filter({ hasText: "A 台式机" });
  await peer.getByTestId("remote-ask-open").click();
  const ask = b.page.getByTestId("remote-ask-dialog");
  await ask.getByTestId("remote-ask-title").fill("远程请求的任务");
  await ask.getByTestId("remote-ask-text").fill("请帮我跑一下这个");
  await expect(ask).toContainText("只在 A 台式机 在线时能发");
  await screenshot(b.app, "studio", "remote-ask-dialog", b.page);
  await ask.getByTestId("remote-ask-send").click();
  await expect(ask).toHaveCount(0);
  await expect(bSettings.getByTestId("remote-message")).toHaveText("已发给 A 台式机，等它同意");
  await expect(peer.getByTestId("remote-ask")).toHaveAttribute("data-state", "pending");
  await expect(peer.getByTestId("remote-ask")).toContainText("等 A 台式机 同意 ·「远程请求的任务」");
  await screenshot(b.app, "studio", "remote-ask-pending", b.page);

  // A: Focus shows it as something to deal with; 设置 → 远程 has it with 同意… / 拒绝….
  const entry = aFocus.getByTestId("focus-task-request");
  await expect(entry).toContainText("任务请求 · B 笔记本", { timeout: 30_000 });
  await expect(entry).toContainText("请这台电脑跑「远程请求的任务」");
  await screenshot(a.app, "studio", "remote-request-focus", aFocus, "focus");
  const aSettings = await openRemoteSettings(a.page);
  const request = aSettings.getByTestId("remote-task-request");
  await expect(request).toContainText("B 笔记本（笔记本的我）请这台电脑跑：「远程请求的任务」");
  await request.getByTestId("remote-task-accept").click();
  const accept = a.page.getByTestId("remote-accept-dialog");
  await expect(accept.getByTestId("remote-accept-model")).toHaveValue("codex-mock");
  await expect(accept.getByTestId("remote-accept-model").locator("option")).toHaveCount(1);
  await accept.getByTestId("remote-accept-workspace").selectOption(proj.id);
  await screenshot(a.app, "studio", "remote-request-accept", a.page);
  await accept.getByTestId("remote-accept-confirm").click();
  await expect(accept).toHaveCount(0);
  await expect(aSettings.getByTestId("remote-task-request")).toHaveCount(0);
  await expect(aFocus.getByTestId("focus-task-request")).toHaveCount(0);
  // The task on A: in the project, granted to B, its session started with the request.
  await expect(aSettings.getByTestId("remote-grant")).toContainText("远程请求的任务");
  await a.page.keyboard.press("Escape");

  // B: told it was allowed; the task is on its board and running.
  await expect(peer.getByTestId("remote-ask")).toHaveAttribute("data-state", "accepted", { timeout: 30_000 });
  await b.page.keyboard.press("Escape");
  const card = b.page.getByTestId("task-card").filter({ hasText: "远程请求的任务" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  await expect(b.page.getByTestId("msg-agent").last()).toContainText("MOCK: 请帮我跑一下这个", { timeout: 60_000 });
  await screenshot(b.app, "studio", "remote-request-running", b.page);
  await b.page.getByTestId("back").click();

  // A second request, refused with a reason: B reads it (and the dot beside 设置 says there is something to see).
  const again = await openRemoteSettings(b.page);
  await again.getByTestId("remote-peer").filter({ hasText: "A 台式机" }).getByTestId("remote-ask-open").click();
  await b.page.getByTestId("remote-ask-title").fill("第二个请求");
  await b.page.getByTestId("remote-ask-text").fill("这个也跑一下");
  await b.page.getByTestId("remote-ask-send").click();
  await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.taskRequests.length === 1, "A has the second request");
  const aAgain = await openRemoteSettings(a.page);
  await aAgain.getByTestId("remote-task-request").getByTestId("remote-task-refuse").click();
  await a.page.getByTestId("remote-refuse-reason").fill("今天不跑这个");
  await a.page.getByTestId("remote-refuse-confirm").click();
  await expect(aAgain.getByTestId("remote-task-request")).toHaveCount(0);
  const refused = again.getByTestId("remote-ask").filter({ hasText: "第二个请求" });
  await expect(refused).toHaveAttribute("data-state", "refused", { timeout: 30_000 });
  await expect(refused).toContainText("A 台式机 拒绝了「第二个请求」：今天不跑这个");
  await expect(b.page.getByTestId("settings-remote-dot")).toBeVisible();
  await screenshot(b.app, "studio", "remote-ask-refused", b.page);
  await refused.getByTestId("remote-ask-withdraw").click();
  await expect(again.getByTestId("remote-ask").filter({ hasText: "第二个请求" })).toHaveCount(0);
});
