import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { programLaunch } from "../support/packed.js";
import { screenshot, studioRoot } from "../support/studio.js";

// 待办 (2026-11-01, plans/todo.md): the 便签 program's second window, its lists on a team server — here a relay service
// started in this process, never the real one. This computer (台式机) and another device of the account (手机, through the
// API) change the lists; the server goes away and comes back; the login goes; 使用待办 is turned off.

const MAIN = join(studioRoot, "packages", "notes", "dist", "main.js");
const relay = (await import(pathToFileURL(join(studioRoot, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");
const account = (await import(pathToFileURL(join(studioRoot, "packages", "account", "dist", "index.js")).href)) as typeof import("../../packages/account/src/index.js");

const DESK = "d_desk000000000000000000";
const PHONE = { device: "d_phone00000000000000000", deviceName: "手机" };

let app: ElectronApplication | undefined;
let root = "";
let store: InstanceType<typeof relay.RelayStore> | undefined;
let server: Awaited<ReturnType<typeof relay.startRelayServer>> | undefined;

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await server?.close();
  server = undefined;
  store?.close();
  store = undefined;
  if (root) removeTempDir(root);
});

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC_|AMO_)/.test(k)) env[k] = v;
  return { ...env, AMO_NOTES_TEST: "1", AMO_NOTES_HOME: join(root, "notes"), AMO_HOME: join(root, "amo-home") };
}

async function windowAt(a: ElectronApplication, hash: string): Promise<Page> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const w = a.windows().find((p) => p.url().endsWith(hash));
    if (w) return w;
    if (Date.now() > deadline) throw new Error(`no window at ${hash}`);
    await a.waitForEvent("window", { timeout: 2000 }).catch(() => undefined);
  }
}

const todoVisible = (a: ElectronApplication) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("#todo"))?.isVisible() ?? false);

/** The relay with an account (老戴), and this computer logged in as 台式机 (account.json as the platform writes it). */
async function setUp(): Promise<{ key: string; port: number }> {
  root = mkdtempSync(join(tmpdir(), "amo-notes-todo-e2e-"));
  store = new relay.RelayStore(join(root, "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const key = (await new relay.RelayClient(server.url).register("老戴", "pw-dai")).key;
  const env = { AMO_HOME: join(root, "amo-home") };
  await account.saveAccount({ server: server.url, name: "老戴", key }, { env });
  mkdirSync(env.AMO_HOME, { recursive: true });
  writeFileSync(join(env.AMO_HOME, "device.json"), JSON.stringify({ id: DESK, name: "台式机" }));
  // An installed AMO 平台, for 在 AMO 平台里登录 (test mode records the start instead of starting it).
  mkdirSync(join(root, "platform"), { recursive: true });
  writeFileSync(join(root, "platform", "AMO Platform.exe"), "");
  writeFileSync(join(env.AMO_HOME, "programs.json"), JSON.stringify({ tools: { platform: { version: "0.9.12", dir: join(root, "platform"), exe: "AMO Platform.exe" } } }));
  return { key, port: Number(new URL(server.url).port) };
}

/** The other device of the account, through the server's API. */
async function phone(key: string, ops: unknown[]): Promise<void> {
  const res = await fetch(`${server!.url}/api/todo/ops`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ...PHONE, ops }) });
  expect(res.ok).toBe(true);
}
async function onServer(key: string): Promise<Array<{ id: string; list: string; text: string; done: boolean }>> {
  const res = await fetch(`${server!.url}/api/todo?device=${PHONE.device}&deviceName=${encodeURIComponent(PHONE.deviceName)}&since=0`, { headers: { authorization: `Bearer ${key}` } });
  return ((await res.json()) as { items: Array<{ id: string; list: string; text: string; done: boolean }> }).items;
}

async function launch(): Promise<{ app: ElectronApplication; todo: Page; notesApi: (method: string, path: string, body?: unknown) => Promise<unknown> }> {
  const launched = programLaunch("notes", MAIN);
  app = await _electron.launch({ executablePath: launched.executablePath, args: [...launched.args, "--hidden"], env: cleanEnv() });
  await app.evaluate(async () => {
    for (let i = 0; i < 100 && !(globalThis as { __notesShowTodo?: () => void }).__notesShowTodo; i++) await new Promise((r) => setTimeout(r, 100));
    (globalThis as { __notesShowTodo?: () => void }).__notesShowTodo!();
  });
  const todo = await windowAt(app, "#todo");
  await expect(todo.locator(".todo-root")).toBeVisible();
  const running = () => JSON.parse(readFileSync(join(root, "notes", "running.json"), "utf8")) as { url: string; token: string };
  const notesApi = async (method: string, path: string, body?: unknown) => {
    const { url, token } = running();
    return (await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
  };
  return { app, todo, notesApi };
}

test("待办: this computer's list and the shared one, another device's changes, move, delete with 撤销", async () => {
  const { key } = await setUp();
  const { app, todo, notesApi } = await launch();
  await expect(todo.getByTestId("todo-status")).toContainText("0 项未完成 · ✓ 已同步");
  await expect(todo.locator(".todo-none")).toContainText("这张表还是空的");
  await screenshot(app, "notes", "T1-todo-empty", todo, "scratchpad");

  // Two typed in: the newest on top, on the server in this computer's list.
  const add = todo.getByLabel("添加待办");
  await add.fill("看问题页 #41 的截图");
  await add.press("Enter");
  await add.fill("Studio 0.9.23 发测试包");
  await add.press("Enter");
  await expect(todo.getByTestId("todo-item")).toHaveText(["Studio 0.9.23 发测试包", "看问题页 #41 的截图"].map((t) => new RegExp(t.replace(/[.#]/g, "\\$&"))));
  await expect.poll(async () => (await onServer(key)).map((i) => [i.list, i.text]).sort()).toEqual([
    [`device:${DESK}`, "Studio 0.9.23 发测试包"],
    [`device:${DESK}`, "看问题页 #41 的截图"],
  ]);

  // The phone adds one to this computer's list and two to the shared one; the window shows them after a sync.
  await phone(key, [
    { op: "put", id: "t_p00000000000001", list: `device:${DESK}`, text: "回复策划：掉落表按权重", order: 5 },
    { op: "put", id: "t_p00000000000002", list: "shared", text: "周五发版前过一遍 CHANGELOG", order: 0 },
    { op: "put", id: "t_p00000000000003", list: "shared", text: "买显示器支架", order: 1 },
  ]);
  await notesApi("POST", "/api/todo/sync");
  await expect(todo.getByTestId("todo-item")).toHaveCount(3);
  await expect(todo.getByRole("button", { name: /共通/ })).toContainText("2");

  // Ticked: on the server at once, in 已完成 after a moment.
  await todo.getByRole("checkbox", { name: "标成做完了" }).last().click();
  await expect(todo.getByTestId("todo-done-toggle")).toHaveText(/已完成 1/);
  await expect.poll(async () => (await onServer(key)).find((i) => i.text === "回复策划：掉落表按权重")?.done).toBe(true);
  await todo.getByTestId("todo-done-toggle").click();
  await expect(todo.locator(".todo-item[data-done]")).toHaveCount(1);
  await screenshot(app, "notes", "T2-todo-list", todo, "scratchpad");

  // 共通 (Alt+2): who added each shows on hover.
  await todo.locator(".todo-root").press("Alt+2");
  await expect(todo.getByRole("button", { name: /共通/ })).toHaveAttribute("aria-pressed", "true");
  await expect(todo.getByTestId("todo-item")).toHaveCount(2);
  await todo.getByTestId("todo-item").first().hover();
  await expect(todo.locator(".todo-from").first()).toHaveText("手机");
  await screenshot(app, "notes", "T3-todo-shared", todo, "scratchpad");

  // ⋯ → 移到 本机; 撤销 puts it back.
  await todo.getByTestId("todo-item").first().locator(".todo-more").click();
  await expect(todo.getByTestId("todo-menu")).toContainText("复制这条");
  await screenshot(app, "notes", "T4-todo-menu", todo, "scratchpad");
  await todo.getByTestId("todo-menu").getByRole("menuitem", { name: "本机" }).click();
  await expect(todo.getByTestId("todo-toast")).toContainText("已移到「本机」");
  await expect(todo.getByTestId("todo-item")).toHaveCount(1);
  await todo.getByTestId("todo-toast").getByRole("button", { name: "撤销" }).click();
  await expect(todo.getByTestId("todo-item")).toHaveCount(2);

  // 复制这条.
  await todo.getByTestId("todo-item").first().locator(".todo-more").click();
  await todo.getByTestId("todo-menu").getByRole("menuitem", { name: "复制这条" }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as { __notesCopied?: string[] }).__notesCopied?.at(-1))).toBe("周五发版前过一遍 CHANGELOG");

  // Delete: gone here at once, 撤销 brings it back (nothing sent yet); deleted again it reaches the server after a while.
  await todo.getByTestId("todo-item").last().focus();
  await todo.getByTestId("todo-item").last().press("Delete");
  await expect(todo.getByTestId("todo-item")).toHaveCount(1);
  await todo.getByTestId("todo-toast").getByRole("button", { name: "撤销" }).click();
  await expect(todo.getByTestId("todo-item")).toHaveCount(2);
  expect((await onServer(key)).some((i) => i.text === "买显示器支架")).toBe(true);
  await todo.getByTestId("todo-item").last().focus();
  await todo.getByTestId("todo-item").last().press("Delete");
  await expect.poll(async () => (await onServer(key)).some((i) => i.text === "买显示器支架"), { timeout: 15_000 }).toBe(false);

  // 其他 ▾: the phone, with its open count; its list says whose it is.
  await todo.getByRole("button", { name: /其他/ }).click();
  await expect(todo.getByTestId("todo-devices")).toContainText("手机");
  await screenshot(app, "notes", "T5-todo-devices", todo, "scratchpad");
  await todo.getByTestId("todo-devices").getByRole("menuitem", { name: /手机/ }).click();
  await expect(todo.locator(".todo-notice")).toContainText("这是「手机」的待办");
  await add.fill("到家看一下远程会话");
  await add.press("Enter");
  await expect.poll(async () => (await onServer(key)).find((i) => i.text === "到家看一下远程会话")?.list).toBe(`device:${PHONE.device}`);
  await screenshot(app, "notes", "T6-todo-other-device", todo, "scratchpad");

  // Edit (double-click), Esc hides the window.
  await todo.getByRole("button", { name: "回到本机" }).click();
  await todo.getByTestId("todo-item").first().dblclick();
  await todo.getByLabel("改这条待办").fill("Studio 0.9.23 发测试包（含待办）");
  await todo.getByLabel("改这条待办").press("Enter");
  await expect.poll(async () => (await onServer(key)).some((i) => i.text === "Studio 0.9.23 发测试包（含待办）")).toBe(true);
  await todo.locator(".todo-root").press("Escape");
  await expect.poll(() => todoVisible(app)).toBe(false);
});

test("待办: the server away and back, the login gone, 使用待办 off — and the settings and tray menu", async () => {
  const { key, port } = await setUp();
  const { app, todo, notesApi } = await launch();
  await expect(todo.getByTestId("todo-status")).toContainText("✓ 已同步");

  // The server goes: changes wait, the foot says how many.
  await server!.close();
  server = undefined;
  const add = todo.getByLabel("添加待办");
  await add.fill("离线时记的一条");
  await add.press("Enter");
  await notesApi("POST", "/api/todo/sync");
  await expect(todo.getByTestId("todo-status")).toContainText("! 连不上服务器 · 1 条改动待提交");
  await screenshot(app, "notes", "T7-todo-offline", todo, "scratchpad");

  // Back on the same address: sent on the next sync.
  server = await relay.startRelayServer({ store: store!, host: "127.0.0.1", port, name: "测试组" });
  await notesApi("POST", "/api/todo/sync");
  await expect(todo.getByTestId("todo-status")).toContainText("1 项未完成 · ✓ 已同步");
  expect((await onServer(key)).map((i) => i.text)).toEqual(["离线时记的一条"]);

  // Logged out in the platform: 在 AMO 平台里登录 starts it.
  rmSync(join(root, "amo-home", "account.json"));
  await notesApi("POST", "/api/todo/sync");
  await expect(todo.getByTestId("todo-signed-out")).toContainText("待办用团队账号");
  await screenshot(app, "notes", "T8-todo-signed-out", todo, "scratchpad");
  await todo.getByRole("button", { name: "在 AMO 平台里登录" }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as { __notesOpenedPlatform?: string }).__notesOpenedPlatform)).toBe(join(root, "platform", "AMO Platform.exe"));
  await account.saveAccount({ server: server.url, name: "老戴", key }, { env: { AMO_HOME: join(root, "amo-home") } });
  await notesApi("POST", "/api/todo/sync");
  await expect(todo.getByTestId("todo-item")).toHaveText([/离线时记的一条/]);

  // The tray menu has 显示待办 while it is on.
  await app.evaluate(() => (globalThis as { __notesTrayMenu?: () => void }).__notesTrayMenu?.());
  const menu = await windowAt(app, "#notes-tray-menu");
  await expect(menu.getByTestId("tm-todo")).toBeVisible();
  await screenshot(app, "notes", "T9-tray-menu", menu, "scratchpad");

  // The settings: the version in the title row, 待办 with the account and 已完成保留.
  await app.evaluate(() => (globalThis as { __notesOpenSettings?: () => void }).__notesOpenSettings?.());
  const settings = await windowAt(app, "#notes-settings");
  await expect(settings.getByTestId("ns-version")).toContainText(/版本 \d+\.\d+\.\d+ · 开发版/);
  await expect(settings.getByTestId("ns-todo-account")).toContainText("老戴 · 127.0.0.1:");
  await expect(settings.getByTestId("ns-keep-30")).toHaveAttribute("aria-checked", "true");
  await screenshot(app, "notes", "T10-settings-todo", settings, "scratchpad");
  await settings.getByTestId("ns-keep-90").click();
  await expect(settings.getByTestId("ns-keep-90")).toHaveAttribute("aria-checked", "true");

  // 使用待办 off: the window goes, the tray item goes, 显示待办 opens the settings instead.
  await settings.getByTestId("ns-use-todo").uncheck();
  await expect.poll(() => todoVisible(app)).toBe(false);
  await expect(settings.getByLabel("待办").locator(".ns-hint").first()).toContainText("关着");
  await screenshot(app, "notes", "T11-settings-todo-off", settings, "scratchpad");
  await app.evaluate(() => (globalThis as { __notesTrayMenu?: () => void }).__notesTrayMenu?.());
  await menu.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(menu.getByTestId("tm-todo")).toHaveCount(0);
  expect(await notesApi("GET", "/api/todo")).toMatchObject({ status: "off" });
  await settings.getByTestId("ns-use-todo").check();
  await expect.poll(async () => ((await notesApi("GET", "/api/todo")) as { status: string }).status).toBe("synced");
});

test("待办 bound to a Studio task (问题 #10): its tag, Studio away and there (its socket gets studio.open), 解除绑定", async () => {
  const { key } = await setUp();
  const { app, todo, notesApi } = await launch();
  await phone(key, [
    { op: "put", id: "t_l00000000000001", list: `device:${DESK}`, text: "按问题 #10 改待办绑定", order: 0 },
    { op: "put", id: "t_l00000000000002", list: `device:${DESK}`, text: "看一眼测试包", order: 1 },
  ]);
  await notesApi("POST", "/api/todo/sync");
  await expect(todo.getByTestId("todo-item")).toHaveCount(2);
  // Bound as Studio binds it (its task's ⋯ → 绑定到待办…, e2e/studio/todo-bind.spec.ts).
  await notesApi("POST", "/api/todo/link", { id: "t_l00000000000001", link: { taskId: "task-x", taskTitle: "日常维护", sessionId: "s-x", sessionTitle: "值守", boundAt: 1 } });
  const tag = todo.getByTestId("todo-item").first().getByTestId("todo-link");
  await expect(tag).toHaveText("日常维护 · 值守");
  await expect(todo.getByTestId("todo-item").last().getByTestId("todo-link")).toHaveCount(0);

  // No Studio linked: the tag says how to get there.
  await expect(tag).toHaveAttribute("data-off", "");
  await tag.click();
  await expect(todo.getByTestId("todo-toast")).toHaveText("打开 Studio 才能跳过去");

  // Studio linked (its socket): the tag asks it to open the task and session.
  const { url, token } = JSON.parse(readFileSync(join(root, "notes", "running.json"), "utf8")) as { url: string; token: string };
  const got: unknown[] = [];
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/api/events?client=studio&token=${token}`);
  ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
  await expect(tag).not.toHaveAttribute("data-off", "");
  await screenshot(app, "notes", "T12-todo-bound", todo, "scratchpad");
  await tag.click();
  await expect.poll(() => got).toEqual([{ type: "studio.open", id: "t_l00000000000001", taskId: "task-x", sessionId: "s-x" }]);
  // Studio said the task is gone: the tag greys, a click says so.
  await notesApi("POST", "/api/todo/link", { id: "t_l00000000000001", link: { taskId: "task-x", taskTitle: "日常维护", sessionId: "s-x", sessionTitle: "值守", boundAt: 1, gone: true } });
  await expect(tag).toHaveAttribute("data-gone", "");
  await tag.click();
  await expect(todo.getByTestId("todo-toast")).toContainText("已经不在了");
  expect(got).toHaveLength(1);
  ws.close();

  // ⋯ → 解除绑定.
  await todo.getByTestId("todo-item").first().locator(".todo-more").click();
  await todo.getByTestId("todo-unbind").click();
  await expect(tag).toHaveCount(0);
  expect(((await notesApi("GET", "/api/todo")) as { links: object }).links).toEqual({});
});
