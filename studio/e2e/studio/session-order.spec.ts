import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { REMOTE_ORDER_SINCE, type RemoteState, type Session, type SessionItem, type StateSnapshot, type Task, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 拖拽排序 (2026-11-17, the user: task 里的 session list 和 session 下的子 session list，允许拖拽改排序。远端也做。): a
// task's main sessions change places among themselves, and the sessions under one session among themselves — by
// dragging (a line shows where it lands) or Alt ↑ / ↓; never across levels. The order is kept (after a reload too). A
// remote task's copy is put in order on the computer it runs on, and each side shows the other's order; an older Studio
// there cannot, and the list says what to update to.

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

const theme = (page: Page, which: "light" | "dark") => page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), which);
const replies = async (s: Studio, sessionId: string) => (await s.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`)).flatMap((i) => (i.type === "agent" && !i.streaming ? [i.markdown] : []));
/** The titles of one level of the list as it shows them: depth 0 the main sessions; with `under`, those under that row. */
const titles = (page: Page, depth: number) => page.locator(`[data-testid="session-row"][data-depth="${depth}"] .srow-title`).allTextContents();
const row = (page: Page, title: string) => page.getByTestId("session-row").filter({ has: page.locator(".srow-title", { hasText: new RegExp(`^${title}$`) }) });

/** Drags `from` to the top (or bottom) edge of `to` with the mouse, holding it there for `hold` before letting go. */
async function drag(page: Page, from: Locator, to: Locator, where: "top" | "bottom", hold?: () => Promise<void>) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + 30, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 34, a.y + a.height / 2 + 4, { steps: 2 });
  await page.mouse.move(b.x + 30, where === "top" ? b.y + 4 : b.y + b.height - 4, { steps: 6 });
  await page.mouse.move(b.x + 31, where === "top" ? b.y + 5 : b.y + b.height - 5);
  if (hold) await hold();
  await page.mouse.up();
}

test("the task's sessions are dragged into another order — the main ones, and those under one; Alt ↑ / ↓ too; never across levels; kept after a reload", async () => {
  test.setTimeout(180_000);
  const studio = await launchStudio();
  studios.push(studio);
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("掉落表") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "排一排会话", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "先看看" } });
  await until(() => replies(studio, session.id), (r) => r.some((t) => t.includes("MOCK")), "the first reply");
  await until(() => studio.api<StateSnapshot>("GET", "/api/state"), (s) => s.sessions.find((x) => x.id === session.id)?.status !== "running", "idle");
  await studio.api("PATCH", `/api/sessions/${session.id}`, { title: "一" });
  for (const title of ["二", "三"]) await studio.api("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", title });
  for (const title of ["甲", "乙"]) await studio.api("POST", `/api/sessions/${session.id}/fork`, { as: "sub", title });

  await page.getByTestId("task-card").filter({ hasText: "排一排会话" }).click();
  await expect(page.getByTestId("session-row")).toHaveCount(5, { timeout: 30_000 });
  expect(await titles(page, 0)).toEqual(["一", "二", "三"]);
  expect(await titles(page, 1)).toEqual(["甲", "乙"]);
  await expect(row(page, "三")).toHaveAttribute("title", /拖动可以调整顺序/);

  // 三 dragged above 一: the line shows where it lands while it is held.
  await drag(page, row(page, "三"), row(page, "一"), "top", async () => {
    await expect(page.locator('.tree-node[data-drop="before"]')).toHaveCount(1);
    await screenshot(studio.app, "studio", "session-order-drag", page);
    await theme(page, "dark");
    await screenshot(studio.app, "studio", "session-order-drag-dark", page);
    await theme(page, "light");
  });
  await expect.poll(() => titles(page, 0)).toEqual(["三", "一", "二"]);
  await expect.poll(async () => (await studio.api<StateSnapshot>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id && !s.parentId).sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99)).map((s) => s.title)).toEqual(["三", "一", "二"]);

  // Under 一: 乙 dragged above 甲.
  await drag(page, row(page, "乙"), row(page, "甲"), "top");
  await expect.poll(() => titles(page, 1)).toEqual(["乙", "甲"]);

  // Across levels: 甲 dropped on 二 changes nothing (no line, nothing saved).
  await drag(page, row(page, "甲"), row(page, "二"), "bottom", async () => {
    await expect(page.locator(".tree-node[data-drop]")).toHaveCount(0);
  });
  expect(await titles(page, 0)).toEqual(["三", "一", "二"]);
  expect(await titles(page, 1)).toEqual(["乙", "甲"]);

  // Alt ↑ on 二 (and the row keeps the focus for the next press); at the top it stays.
  await row(page, "二").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => titles(page, 0)).toEqual(["三", "二", "一"]);
  await expect(row(page, "二")).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => titles(page, 0)).toEqual(["二", "三", "一"]);
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => titles(page, 0)).toEqual(["三", "二", "一"]);

  // A new session goes to the end; the order stays after a reload.
  await studio.api("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", title: "四" });
  await expect.poll(() => titles(page, 0)).toEqual(["三", "二", "一", "四"]);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const card = page.getByTestId("task-card").filter({ hasText: "排一排会话" });
  if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) await card.click();
  await expect(page.getByTestId("session-row")).toHaveCount(6, { timeout: 30_000 });
  expect(await titles(page, 0)).toEqual(["三", "二", "一", "四"]);
  expect(await titles(page, 1)).toEqual(["乙", "甲"]);
  await screenshot(studio.app, "studio", "session-order-kept", page);
});

/** A and B, paired through a relay on this machine: B asked, A allowed. */
async function pairedStudios(prefix: string): Promise<{ a: Studio; b: Studio }> {
  root = mkdtempSync(join(tmpdir(), `amo-${prefix}-e2e-`));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const keyA = store.register("台式机的我", "pw-aaaa").key;
  const keyB = store.register("笔记本的我", "pw-bbbb").key;
  const home = async (name: string, key: string, device: string) => {
    const dir = join(root, `home-${name}`);
    await account.saveAccount({ server: server!.url, name, key }, { env: { AMO_HOME: dir } });
    account.setDeviceName(device, { env: { AMO_HOME: dir } });
    return dir;
  };
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
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.peers[0]?.online === true, "B sees A online");
  return { a, b };
}

test("远程: B drags a copy's sessions — put in order on A, which shows it; A's order shows on B; an older A says what to update to", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("session-order");
  const { task, session } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "远程排序", firstSession: { profileId: "codex-mock", text: "先看看" } });
  await until(() => replies(a, session.id), (r) => r.some((t) => t.includes("MOCK")), "A's first reply");
  await a.api("PATCH", `/api/sessions/${session.id}`, { title: "一" });
  for (const title of ["二", "三"]) await a.api("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", title });
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "笔记本的我", device: (await b.api<RemoteState>("GET", "/api/remote")).device!.id });

  const card = b.page.getByTestId("task-card").filter({ hasText: "远程排序" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  await expect(b.page.getByTestId("session-row")).toHaveCount(3, { timeout: 30_000 });
  expect(await titles(b.page, 0)).toEqual(["一", "二", "三"]);
  await a.page.getByTestId("task-card").filter({ hasText: "远程排序" }).click();
  await expect(a.page.getByTestId("session-row")).toHaveCount(3, { timeout: 30_000 });

  // Dragged on B: A's list has it too.
  await drag(b.page, row(b.page, "三"), row(b.page, "一"), "top");
  await expect.poll(() => titles(b.page, 0)).toEqual(["三", "一", "二"]);
  await expect.poll(() => titles(a.page, 0), { timeout: 30_000 }).toEqual(["三", "一", "二"]);
  await screenshot(b.app, "studio", "remote-session-order", b.page);

  // Changed on A (Alt ↓ on 三): B follows.
  await row(a.page, "三").focus();
  await a.page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => titles(a.page, 0)).toEqual(["一", "三", "二"]);
  await expect.poll(() => titles(b.page, 0), { timeout: 30_000 }).toEqual(["一", "三", "二"]);

  // An older Studio on A (its snapshot has no order): B's list stays as it is and says what to update to — on a drag
  // and on Alt ↑ / ↓. Made so by taking the mark off B's copy (A says it again only with its next snapshot or task push).
  const db = new DatabaseSync(join(b.dataDir, "studio.db"));
  try {
    const r = db.prepare("SELECT remote FROM tasks WHERE id = ?").get(task.id) as { remote: string };
    const { order: _order, ...older } = JSON.parse(r.remote) as Record<string, unknown>;
    db.prepare("UPDATE tasks SET remote = ? WHERE id = ?").run(JSON.stringify(older), task.id);
  } finally {
    db.close();
  }
  await b.page.reload();
  await b.page.waitForLoadState("domcontentloaded");
  if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) await card.click();
  await expect(b.page.getByTestId("session-row")).toHaveCount(3, { timeout: 30_000 });
  const note = b.page.getByTestId("session-order-note");
  const old = `A 台式机 上的 Studio 要更新到 ${REMOTE_ORDER_SINCE} 或更新的版本，才能在这台电脑上调整会话的顺序`;
  await row(b.page, "二").focus();
  await b.page.keyboard.press("Alt+ArrowUp");
  await expect(note).toHaveText(old);
  await drag(b.page, row(b.page, "二"), row(b.page, "一"), "top");
  await expect(note).toHaveText(old);
  expect(await titles(b.page, 0)).toEqual(["一", "三", "二"]);
  expect(await titles(a.page, 0)).toEqual(["一", "三", "二"]);
  await screenshot(b.app, "studio", "remote-session-order-old-peer", b.page);
});
