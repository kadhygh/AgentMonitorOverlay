import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { AccountUsage, RemoteState, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程额度 (2026-11-06, the user: 远程任务的说明里，被控端追踪了这个模型的额度就直接显示被控端的信息). Two Studios on this
// machine, both logged in with the same account (the person's two computers), paired through a relay service started
// here. A runs the task on the Claude subscription (a stand-in for the local Claude Code login, whose quota the mock
// answers: 5 小时 37%, 每周 12%) and has read its quota once; B's task page shows A's numbers beside the model folded,
// and the windows with whose they are and how old open — B never asks for them.

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
  const dir = join(root, `home-${device}`);
  await account.saveAccount({ server: server!.url, name, key }, { env: { AMO_HOME: dir } });
  account.setDeviceName(device, { env: { AMO_HOME: dir } });
  return dir;
}

const theme = (page: Page, which: "light" | "dark") => page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), which);

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("B's task page shows the quota A has read for the task's model, folded and open", async () => {
  test.setTimeout(240_000);
  root = mkdtempSync(join(tmpdir(), "amo-remote-usage-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const key = store.register("我", "pw-aaaa").key;

  // A: signed in to Claude Code (the stand-in), so the subscription can read its quota as Claude Code's /usage does.
  const mine = join(root, "my-claude");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-e2e-local", refreshToken: "sk-ant-ort01-e2e-local", expiresAt: Date.now() + 365 * 24 * 3600_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
  const a = await launchStudio({ env: { AMO_HOME: await home("我", key, "A 台式机"), CLAUDE_CONFIG_DIR: mine } });
  studios.push(a);
  const b = await launchStudio({ env: { AMO_HOME: await home("我", key, "B 笔记本") } });
  studios.push(b);
  await Promise.all([a, b].map((x) => x.api("PUT", "/api/remote/enabled", { enabled: true })));
  const aState = await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "A online");
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "B online");

  // B asks A (the same account's other computer) to pair; A allows.
  await b.api("POST", "/api/remote/pair", { account: "我", device: aState.device!.id });
  const asked = await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.incoming.length === 1, "A sees the request");
  await a.api("POST", `/api/remote/requests/${asked.incoming[0]!.id}/answer`, { allow: true });
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.peers[0]?.online === true, "B sees A online");
  const bDevice = (await b.api<RemoteState>("GET", "/api/remote")).device!.id;

  // A: a task on the Claude subscription, and its quota read once on A (as its own 额度 panel does).
  const ws = await a.api<{ id: string }>("POST", "/api/workspaces", { path: a.workspace("alpha") });
  const { task } = await a.api<{ task: Task }>("POST", "/api/tasks", { title: "远程看额度", workspaceId: ws.id, firstSession: { profileId: "claude-subscription", text: "hello" } });
  const read = await a.api<AccountUsage[]>("GET", "/api/usage?refresh=1");
  expect(read.find((u) => u.profileId === "claude-subscription")).toMatchObject({ windows: [{ label: "5 小时", usedPercent: 37 }, { label: "每周", usedPercent: 12 }] });
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "我", device: bDevice });

  // B: the numbers came with no asking; the task page shows them.
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => (s.usage?.[0]?.usage.length ?? 0) > 0, "B has A's quota");
  await b.page.getByTestId("task-card").filter({ hasText: "远程看额度" }).click();
  const banner = b.page.getByTestId("remote-banner");
  await expect(banner).toHaveAttribute("data-state", "online");
  // Folded: one line, the model with its most used window.
  if ((await banner.getByTestId("remote-banner-toggle").getAttribute("aria-expanded")) === "true") await banner.getByTestId("remote-banner-toggle").click();
  // Folded (the user, 2026-11-06: 5 小时和周限额都要显示，用进度条): every window, a small bar and the share used.
  const wins = banner.getByTestId("remote-banner-quota").getByTestId("remote-banner-win");
  await expect(wins).toHaveCount(2);
  await expect(wins.nth(0)).toHaveText(/^5 小时\s*37%$/);
  await expect(wins.nth(1)).toHaveText(/^每周\s*12%$/);
  await expect(wins.nth(0).locator(".usage-bar")).toBeVisible();
  await expect(wins.nth(0).locator(".usage-bar > span")).toHaveAttribute("style", /width: 37%/);
  await expect(wins.nth(0)).toHaveAttribute("title", /A 台式机 上的数据：5 小时已用 37%，剩 63%，1h 3\dm 后重置/);
  await expect(banner.getByTestId("remote-banner-watch")).toContainText("Claude");
  await expect(banner.getByTestId("remote-banner-usage")).toHaveCount(0);
  await screenshot(b.app, "studio", "remote-usage-folded", b.page);
  await theme(b.page, "dark");
  await screenshot(b.app, "studio", "remote-usage-folded-dark", b.page);
  await theme(b.page, "light");

  // Open: every window, what is left and when it resets, whose numbers and how old.
  await banner.getByTestId("remote-banner-toggle").click();
  const open = banner.getByTestId("remote-banner-usage");
  const windows = open.getByTestId("usage-window");
  await expect(windows).toHaveCount(2);
  await expect(windows.nth(0)).toContainText("5 小时");
  await expect(windows.nth(0)).toContainText("剩 63%");
  await expect(windows.nth(1)).toContainText("剩 88%");
  await expect(open).toContainText(/A 台式机 上的数据 · (刚刚|\d+ 分钟前)更新/);
  await screenshot(b.app, "studio", "remote-usage-open", b.page);
  await theme(b.page, "dark");
  await screenshot(b.app, "studio", "remote-usage-open-dark", b.page);
  await theme(b.page, "light");
  // Folded again for the next copy (remembered).
  await banner.getByTestId("remote-banner-toggle").click();

  // A narrow window: the bars go, the percentages stay on one line, and nothing spills out of the banner.
  await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760));
  await expect(wins.nth(0).locator(".usage-bar")).toBeHidden();
  await expect(wins.nth(0)).toContainText("37%");
  const head = await banner.getByTestId("remote-banner-toggle").boundingBox();
  expect(head!.height).toBeLessThan(40);
  await screenshot(b.app, "studio", "remote-usage-narrow", b.page);
  await banner.getByTestId("remote-banner-toggle").click();
  await screenshot(b.app, "studio", "remote-usage-narrow-open", b.page);
  await banner.getByTestId("remote-banner-toggle").click();
});
