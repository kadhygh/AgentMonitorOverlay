import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RemoteState, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程, step 4 (plans/remote-session.md 方式 2, 2026-10-29): two Studios on this machine (each its own AMO_HOME and data,
// the mock model), paired through a relay service started here — never the team server. B asks A to run a task (as an
// older B does: a new one creates it from its new-task page, remote-create.spec.ts); A's Focus shows the request; A picks the project and an allowed model and allows it; B's board shows the
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

/** The top bar's 「远程」 → the 远程 dialog. */
async function openRemote(page: Page) {
  await page.getByTestId("topbar-remote").click();
  const remote = page.getByRole("dialog", { name: "远程", exact: true });
  await expect(remote).toBeVisible();
  return remote;
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
  // A looks every 500 ms whether its tasks are used from elsewhere (it keeps the computer awake meanwhile).
  const a = await launchStudio({ env: { AMO_HOME: await home("台式机的我", store.register("台式机的我", "pw-aaaa").key, "A 台式机"), AMO_STUDIO_REMOTE_WATCH_MS: "500" } });
  studios.push(a);
  const b = await launchStudio({ env: { AMO_HOME: await home("笔记本的我", store.register("笔记本的我", "pw-bbbb").key, "B 笔记本") } });
  studios.push(b);
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "B online");
  await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "A online");
  await b.api("POST", "/api/remote/pair", { account: "台式机的我" });
  const asked = await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.incoming.length === 1, "A sees the pairing request");
  await a.api("POST", `/api/remote/requests/${asked.incoming[0]!.id}/answer`, { allow: true });
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.peers[0]?.online === true, "B sees A online");
  const sleepBlocked = () => a.app.evaluate(() => (globalThis as { __amoSleepBlocked?: boolean }).__amoSleepBlocked ?? null);
  await expect.poll(sleepBlocked).toBe(false);
  // A: a project to put the task in, and the model remote work may use (远程 → 远程设置 → 远端允许的模型).
  const proj = await a.api<Workspace>("POST", "/api/workspaces", { path: a.workspace("请求的项目") });
  await a.api("PUT", "/api/remote/allowed", { profiles: ["codex-mock"], defaultProfile: "codex-mock", permission: null });
  const aFocus = await turnOnFocus(a.page, a.app);

  // B sends a request as an older B would (远程创建 replaced the request dialog, 2026-10-29: a new B creates the task
  // from its new-task page, remote-create.spec.ts); A still answers requests, and B still lists what it sent.
  const bSettings = await openRemote(b.page);
  const sentA = (await b.api<RemoteState>("GET", "/api/remote")).peers.find((p) => p.role === "guest")!;
  await b.api("POST", "/api/remote/asks", { account: sentA.account, device: sentA.device, title: "远程请求的任务", text: "请帮我跑一下这个" });
  // The request waits under 「在别的设备上跑的」.
  const sent = bSettings.getByTestId("remote-copies").getByTestId("remote-ask");
  await expect(sent).toHaveAttribute("data-state", "pending");
  await expect(sent).toContainText("等 A 台式机 同意 ·「远程请求的任务」");
  await screenshot(b.app, "studio", "remote-ask-pending", b.page);

  // A: Focus shows it as something to deal with; 「去处理」 opens 远程, where it waits under 「等你处理」 with 同意… / 拒绝….
  const entry = aFocus.getByTestId("focus-task-request");
  await expect(entry).toContainText("任务请求 · B 笔记本", { timeout: 30_000 });
  await expect(entry).toContainText("请这台电脑跑「远程请求的任务」");
  await screenshot(a.app, "studio", "remote-request-focus", aFocus, "focus");
  await entry.getByTestId("focus-task-request-open").click();
  const aSettings = a.page.getByRole("dialog", { name: "远程", exact: true });
  await expect(a.page.getByTestId("topbar-remote-dot")).toBeVisible();
  const request = aSettings.getByTestId("remote-waiting").getByTestId("remote-task-request");
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
  await expect(aSettings.getByTestId("remote-waiting")).toHaveCount(0);
  await expect(a.page.getByTestId("topbar-remote-dot")).toHaveCount(0);

  // B: told it was allowed; 远程 lists the copy; the task is on its board and running.
  await expect(sent).toHaveAttribute("data-state", "accepted", { timeout: 30_000 });
  await expect(bSettings.getByTestId("remote-copy")).toContainText("远程请求的任务");
  await expect(bSettings.getByTestId("remote-copy")).toContainText("在 A 台式机");
  await screenshot(b.app, "studio", "remote-page-copy", b.page);
  await bSettings.getByTestId("remote-dialog-close").click();
  await expect(bSettings).toHaveCount(0);
  const card = b.page.getByTestId("task-card").filter({ hasText: "远程请求的任务" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  await expect(b.page.getByTestId("msg-agent").last()).toContainText("MOCK: 请帮我跑一下这个", { timeout: 60_000 });
  await screenshot(b.app, "studio", "remote-request-running", b.page);
  await b.page.getByTestId("back").click();

  // A second request, refused with a reason: B reads it (and the dot on the top bar's 「远程」 says there is something to see).
  const again = await openRemote(b.page);
  await b.api("POST", "/api/remote/asks", { account: sentA.account, device: sentA.device, title: "第二个请求", text: "这个也跑一下" });
  await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.taskRequests.length === 1, "A has the second request");
  await aSettings.getByTestId("remote-dialog-close").click();
  const aAgain = await openRemote(a.page);
  await aAgain.getByTestId("remote-task-request").getByTestId("remote-task-refuse").click();
  await a.page.getByTestId("remote-refuse-reason").fill("今天不跑这个");
  await a.page.getByTestId("remote-refuse-confirm").click();
  await expect(aAgain.getByTestId("remote-task-request")).toHaveCount(0);
  const refused = again.getByTestId("remote-ask").filter({ hasText: "第二个请求" });
  await expect(refused).toHaveAttribute("data-state", "refused", { timeout: 30_000 });
  await expect(refused).toContainText("A 台式机 拒绝了「第二个请求」：今天不跑这个");
  await expect(b.page.getByTestId("topbar-remote-dot")).toBeVisible();
  await screenshot(b.app, "studio", "remote-ask-refused", b.page);
  await refused.getByTestId("remote-ask-withdraw").click();
  await expect(again.getByTestId("remote-ask").filter({ hasText: "第二个请求" })).toHaveCount(0);
  await expect(b.page.getByTestId("topbar-remote-dot")).toHaveCount(0);

  // A while its task is used from B (online): kept awake, and 完全退出 asks first, even with no session at work.
  await expect.poll(sleepBlocked, { timeout: 10_000 }).toBe(true);
  await until(() => a.api<{ running: number }>("GET", "/api/health"), (h) => h.running === 0, "A's session idle");
  await a.app.evaluate(() => (globalThis as { __studioTrayClick?: (l: string) => void }).__studioTrayClick!("完全退出"));
  const quitAsked = () => a.app.evaluate(() => (globalThis as { __amoQuitAsked?: Array<{ message: string; detail: string; yes: string }> }).__amoQuitAsked ?? []);
  await expect.poll(async () => (await quitAsked()).length).toBe(1);
  expect((await quitAsked())[0]).toMatchObject({ message: "有 1 个任务正被 B 笔记本 远程使用，退出后那边会暂停。", yes: "仍然退出" });
  // 取消 (the default in tests): A goes on.
  await new Promise((r) => setTimeout(r, 300));
  expect((await a.api<{ ok: boolean }>("GET", "/api/health")).ok).toBe(true);
  // B goes away: nothing is used from elsewhere any more, the computer may sleep.
  await b.close();
  studios.splice(studios.indexOf(b), 1);
  await expect.poll(sleepBlocked, { timeout: 90_000 }).toBe(false);
});
