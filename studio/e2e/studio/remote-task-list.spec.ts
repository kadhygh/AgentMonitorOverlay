import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { RemoteState, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 问题 #5 (2026-11-01): in 远程, a list of tasks shows at most 10 rows and scrolls past them, and a filter on 任务's
// heading narrows the lists by task title or device. Two Studios paired through a relay service started here (never the
// team server); A grants 12 tasks to B, so A's 「授权给别的设备的」 and B's 「在别的设备上跑的」 both run long.

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

async function home(name: string, key: string, device: string): Promise<string> {
  const dir = join(root, `home-${name}`);
  await account.saveAccount({ server: server!.url, name, key }, { env: { AMO_HOME: dir } });
  account.setDeviceName(device, { env: { AMO_HOME: dir } });
  return dir;
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openRemote(page: Page) {
  await page.getByTestId("topbar-remote").click();
  const remote = page.getByRole("dialog", { name: "远程", exact: true });
  await expect(remote).toBeVisible();
  return remote;
}

/** The list scrolls, and what shows of it is 10 rows tall (give or take a pixel). */
async function expectTenRowsAndScroll(list: Locator, row: Locator) {
  const box = await list.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  // A row past the first (those have the line on top).
  const rowHeight = (await row.nth(1).boundingBox())!.height;
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(Math.abs(box.client - 10 * rowHeight)).toBeLessThanOrEqual(3);
}

test("远程's task lists stop at 10 rows and scroll; the filter narrows them by title or device", async () => {
  test.setTimeout(240_000);
  root = mkdtempSync(join(tmpdir(), "amo-remote-list-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const keyA = store.register("台式机的我", "pw-aaaa").key;
  const keyB = store.register("笔记本的我", "pw-bbbb").key;

  const a = await launchStudio({ env: { AMO_HOME: await home("台式机的我", keyA, "A 台式机") } });
  studios.push(a);
  const b = await launchStudio({ env: { AMO_HOME: await home("笔记本的我", keyB, "B 笔记本") } });
  studios.push(b);
  await Promise.all([a, b].map((x) => x.api("PUT", "/api/remote/enabled", { enabled: true })));
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "B online");
  await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "A online");
  await b.api("POST", "/api/remote/pair", { account: "台式机的我" });
  const asked = await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.incoming.length === 1, "A sees the request");
  await a.api("POST", `/api/remote/requests/${asked.incoming[0]!.id}/answer`, { allow: true });
  const paired = await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.peers.some((p) => p.role === "owner" && p.online), "A sees B online");
  const peer = paired.peers.find((p) => p.role === "owner")!;

  // A: 11 tasks of one kind and one of another, all granted to B.
  const titles = [...Array.from({ length: 11 }, (_, i) => `清单任务 ${String(i + 1).padStart(2, "0")}`), "看日志的任务"];
  for (const title of titles) {
    const { task } = await a.api<{ task: Task }>("POST", "/api/tasks", { title });
    await a.api("POST", "/api/remote/grants", { taskId: task.id, account: peer.account, device: peer.device });
  }

  // A: 「授权给别的设备的」 shows 10 rows of the 12 and scrolls.
  const remote = await openRemote(a.page);
  const grants = remote.getByTestId("remote-grant-list");
  await expect(grants.getByTestId("remote-grant")).toHaveCount(12);
  await expectTenRowsAndScroll(grants, grants.getByTestId("remote-grant"));
  await screenshot(a.app, "studio", "remote-list-grants", a.page);

  // The filter: by title, by device, and nothing found.
  const filter = remote.getByTestId("remote-task-filter");
  await filter.fill("日志");
  await expect(grants.getByTestId("remote-grant")).toHaveCount(1);
  await expect(grants.getByTestId("remote-grant")).toContainText("看日志的任务");
  await screenshot(a.app, "studio", "remote-list-filtered", a.page);
  await filter.fill("笔记本");
  await expect(grants.getByTestId("remote-grant")).toHaveCount(12);
  await filter.fill("没有这个");
  await expect(remote.getByTestId("remote-grant")).toHaveCount(0);
  await expect(remote.getByTestId("remote-grants").getByTestId("remote-filter-empty")).toHaveText("没有含「没有这个」的任务。");
  await screenshot(a.app, "studio", "remote-list-filter-empty", a.page);

  // B: the 12 copies under 「在别的设备上跑的」, the same way.
  await until(() => b.api<{ tasks: Task[] }>("GET", "/api/state").then((s) => s.tasks.filter((t) => t.remote).length), (n) => n === 12, "B has the 12 copies", 60_000);
  const bRemote = await openRemote(b.page);
  const copies = bRemote.getByTestId("remote-copy-list");
  await expect(copies.getByTestId("remote-copy")).toHaveCount(12);
  await expectTenRowsAndScroll(copies, copies.getByTestId("remote-copy"));
  await screenshot(b.app, "studio", "remote-list-copies", b.page);
  await bRemote.getByTestId("remote-task-filter").fill("清单任务 1");
  await expect(copies.getByTestId("remote-copy")).toHaveCount(2); // 10 and 11
});
