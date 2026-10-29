import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RemoteState, Session, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程, step 2 (plans/remote-session.md, 2026-10-29): two Studios on this machine (each its own AMO_HOME and data, the
// mock model), paired through a relay service started here on a free port — never the team server. A grants a task to
// B from the task page; B's board shows it as a remote task; B's message runs on A's mock session and the reply comes
// back; an approval waits on B (not on A's Focus) and B allows it, A's card follows; B starts a session on the one model
// A allows; the relay goes away (B greys out, the draft stays, nothing is sent) and comes back (B catches up); A takes
// the grant back and B says so.

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

async function turnOnFocus(page: Page, app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  return opened;
}

const composer = (page: Page) => page.getByLabel("输入消息");

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("A grants a task; B works in it, sees approvals A's Focus leaves to it, rides out a drop, and hears the grant taken back", async () => {
  test.setTimeout(300_000);
  root = mkdtempSync(join(tmpdir(), "amo-remote-tasks-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const port = server.port;
  const keyA = store.register("台式机的我", "pw-aaaa").key;
  const keyB = store.register("笔记本的我", "pw-bbbb").key;

  const a = await launchStudio({ env: { AMO_HOME: await home("台式机的我", keyA, "A 台式机") } });
  studios.push(a);
  const b = await launchStudio({ env: { AMO_HOME: await home("笔记本的我", keyB, "B 笔记本") } });
  studios.push(b);

  // Paired as step 1 does it (its own spec walks through the screens): B asks, A allows.
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "B online");
  await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.connection.state === "online", "A online");
  await b.api("POST", "/api/remote/pair", { account: "台式机的我" });
  const asked = await until(() => a.api<RemoteState>("GET", "/api/remote"), (s) => s.incoming.length === 1, "A sees the request");
  await a.api("POST", `/api/remote/requests/${asked.incoming[0]!.id}/answer`, { allow: true });
  await until(() => b.api<RemoteState>("GET", "/api/remote"), (s) => s.peers[0]?.online === true, "B sees A online");

  // A: a task with a session that has answered.
  const { task, session } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "远程一起做的任务", firstSession: { profileId: "codex-mock", text: "先说一句" } });
  await a.page.getByTestId("task-card").filter({ hasText: "远程一起做的任务" }).click();
  await expect(a.page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 60_000 });

  // A grants it from the task page: ⋯ → 授权给… → B 笔记本.
  await a.page.getByTestId("task-more").click();
  await a.page.getByTestId("task-grant").click();
  const dialog = a.page.getByTestId("grant-dialog");
  await expect(dialog.getByTestId("grant-peer")).toHaveCount(1);
  await expect(dialog.getByTestId("grant-peer")).toContainText("B 笔记本");
  await expect(dialog).toContainText("命令以这台电脑上你的用户身份运行");
  await screenshot(a.app, "studio", "remote-grant-dialog", a.page);
  await dialog.getByTestId("grant-confirm").click();
  await expect(dialog).toHaveCount(0);
  await expect(a.page.getByTestId("granted-banner")).toContainText("B 笔记本 可以远程使用这个任务");
  // The remote page (the top bar's 「远程」) lists it under 「授权给别的设备的」, opens it again, offers 远端允许的模型 under
  // 远程设置, and 解除配对 says which grants go with it.
  await a.page.getByTestId("topbar-remote").click();
  const settings = a.page.getByRole("region", { name: "远程", exact: true });
  const grant = settings.getByTestId("remote-grants").getByTestId("remote-grant");
  await expect(grant).toContainText("远程一起做的任务");
  await expect(grant).toContainText("B 笔记本");
  await expect(grant).toContainText("在线");
  // 打开: the task page, whose ← returns to 远程.
  await grant.getByTestId("remote-grant-open").click();
  await expect(a.page.getByTestId("task-title")).toHaveText("远程一起做的任务");
  await expect(a.page.getByTestId("back")).toHaveText("远程");
  await a.page.getByTestId("back").click();
  await settings.getByTestId("remote-settings-open").click();
  await expect(settings.getByTestId("remote-allowed-item").filter({ hasText: "Mock" }).first()).toBeVisible();
  await settings.getByTestId("remote-peer").getByTestId("remote-unpair").click();
  await expect(a.page.getByTestId("remote-unpair-grants")).toContainText("同时收回授权给它的 1 个任务：「远程一起做的任务」");
  await screenshot(a.app, "studio", "remote-unpair-grants", a.page);
  await a.page.getByTestId("remote-unpair-confirm").getByRole("button", { name: "取消" }).click();
  await settings.getByTestId("remote-allowed").scrollIntoViewIfNeeded();
  await screenshot(a.app, "studio", "remote-a-settings", a.page);
  // The board card on A says it is granted (← from 远程 goes back to the board it came from).
  await a.page.getByTestId("back").click();
  await expect(settings).toHaveCount(0);
  await expect(a.page.getByTestId("task-card").filter({ hasText: "远程一起做的任务" }).getByTestId("card-granted")).toHaveText("已授权给 B 笔记本");
  await a.page.getByTestId("task-card").filter({ hasText: "远程一起做的任务" }).click();

  // B: the task is on its board, marked remote, where it runs.
  const card = b.page.getByTestId("task-card").filter({ hasText: "远程一起做的任务" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await expect(card.getByTestId("card-remote")).toHaveText("远程在 A 台式机 上");
  await screenshot(b.app, "studio", "remote-b-board", b.page);
  await card.click();
  await expect(b.page.getByTestId("task-title")).toHaveText("远程一起做的任务");
  await expect(b.page.getByTestId("remote-banner")).toHaveAttribute("data-state", "online");
  await expect(b.page.getByTestId("task-remote-where")).toContainText("在 A 台式机 上（台式机的我）");
  await expect(b.page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 30_000 });
  // What only A does is not offered: Git Review, 分支, 在终端打开, 书签 of the task.
  await expect(b.page.getByTestId("task-review")).toHaveCount(0);
  await expect(b.page.getByTestId("session-fork")).toHaveCount(0);
  await expect(b.page.getByTestId("task-marks")).toHaveCount(0);

  // B's message runs on A; the reply comes back to B.
  await composer(b.page).fill("从 B 发来的消息");
  await composer(b.page).press("Enter");
  await expect(b.page.getByTestId("msg-agent").filter({ hasText: "从 B 发来的消息" })).toBeVisible({ timeout: 60_000 });
  await expect(a.page.getByTestId("msg-user").filter({ hasText: "从 B 发来的消息" })).toBeVisible({ timeout: 30_000 });
  await screenshot(b.app, "studio", "remote-b-conversation", b.page);

  // An approval: it waits on B, and A's Focus leaves it to B (B is online).
  const aFocus = await turnOnFocus(a.page, a.app);
  await composer(b.page).fill("[[shell: cmd /c echo remote-ok]]");
  await composer(b.page).press("Enter");
  const bCard = b.page.getByTestId("approval").first();
  await expect(bCard).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
  const aCard = a.page.getByTestId("approval").first();
  await expect(aCard).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await expect(aFocus.getByTestId("focus-needs")).toHaveText("没有待处理");
  await screenshot(b.app, "studio", "remote-b-approval", b.page);
  await bCard.getByRole("button", { name: "批准" }).click();
  await expect(bCard).toHaveAttribute("data-state", "accepted", { timeout: 30_000 });
  await expect(aCard).toHaveAttribute("data-state", "accepted", { timeout: 30_000 });
  await expect(b.page.getByTestId("msg-agent").last()).toContainText("MOCK-DONE", { timeout: 60_000 });

  // A new session from B: only the model A allows (the one the task uses), started on A.
  await b.page.getByTestId("new-session-toggle").click();
  const form = b.page.getByTestId("remote-new-session");
  await expect(form.getByTestId("remote-model").locator("option")).toHaveCount(1);
  await screenshot(b.app, "studio", "remote-b-new-session", b.page);
  await form.getByTestId("remote-start").click();
  await until(() => a.api<{ sessions: Session[] }>("GET", "/api/state").then((s) => s.sessions.filter((x) => x.taskId === task.id)), (l) => l.length === 2, "A has B's new session");
  await expect(b.page.getByTestId("session-row")).toHaveCount(2, { timeout: 30_000 });

  // The relay goes away: B greys out, a draft stays, nothing can be sent.
  await b.page.getByTestId("session-row").first().click();
  await server.close();
  await expect(b.page.getByTestId("remote-banner")).toHaveAttribute("data-state", "offline", { timeout: 30_000 });
  await composer(b.page).fill("断线时写好的话");
  await expect(b.page.getByRole("button", { name: "发送" })).toBeDisabled();
  await expect(b.page.getByTestId("remote-blocked")).toContainText("回来后再发");
  await screenshot(b.app, "studio", "remote-b-offline", b.page);
  // Meanwhile A goes on by itself.
  await a.api("POST", `/api/sessions/${session.id}/messages`, { text: "B 断线时 A 说的" });
  await expect(a.page.getByTestId("msg-agent").filter({ hasText: "B 断线时 A 说的" })).toBeVisible({ timeout: 60_000 });

  // Back on the same port: B reconnects by itself and catches up; the draft is still there, unsent.
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port, name: "测试组" });
  await expect(b.page.getByTestId("remote-banner")).toHaveAttribute("data-state", "online", { timeout: 60_000 });
  await expect(composer(b.page)).toHaveValue("断线时写好的话");
  await expect(b.page.getByRole("button", { name: "发送" })).toBeEnabled();
  await expect(b.page.getByTestId("msg-agent").filter({ hasText: "B 断线时 A 说的" })).toBeVisible({ timeout: 60_000 });
  await screenshot(b.app, "studio", "remote-b-caught-up", b.page);

  // A takes the grant back: B keeps the record and says the grant is gone.
  await a.page.getByTestId("granted-revoke").click();
  await expect(a.page.getByTestId("granted-banner")).toHaveCount(0);
  await expect(b.page.getByTestId("remote-banner")).toHaveAttribute("data-state", "revoked", { timeout: 30_000 });
  await expect(b.page.getByTestId("remote-banner")).toContainText("授权已收回");
  await expect(b.page.getByTestId("msg-agent").filter({ hasText: "B 断线时 A 说的" })).toBeVisible();
  await screenshot(b.app, "studio", "remote-b-revoked", b.page);
  await b.page.getByTestId("back").click();
  await expect(b.page.getByTestId("task-card").filter({ hasText: "远程一起做的任务" })).toHaveAttribute("data-remote", "revoked");
  await screenshot(b.app, "studio", "remote-b-board-revoked", b.page);
  // Archived on B: the copy goes from B (back on the board), the task stays on A.
  await b.page.getByTestId("task-card").filter({ hasText: "远程一起做的任务" }).click();
  await b.page.getByTestId("task-archive").click();
  await expect(b.page.getByTestId("task-card").filter({ hasText: "远程一起做的任务" })).toHaveCount(0);
  await expect(b.page.getByTestId("column-doing")).toBeVisible();
  expect((await a.api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === task.id)?.archivedAt).toBeNull();
});
