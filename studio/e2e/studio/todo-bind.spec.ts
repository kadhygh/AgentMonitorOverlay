import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import type { Session, Task, TodoView, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 绑定到待办 (2026-11-02, 问题 #10): the task's and the session's ⋯ bind an item of the 便签 program's 待办 (its lists on
// a relay service started in this process, never the real one); the item's tag in 便签 then opens that task or session
// here. The program is started by Studio (its home in the test's data dir); its 待办 window is tested in
// e2e/notes/notes-todo.spec.ts, here its tag is clicked through its API (POST /api/todo/open, what the tag does).

const relay = (await import(pathToFileURL(join(studioRoot, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");
const account = (await import(pathToFileURL(join(studioRoot, "packages", "account", "dist", "index.js")).href)) as typeof import("../../packages/account/src/index.js");

const DESK = "d_desk000000000000000000";

let studio: Studio | undefined;
let store: InstanceType<typeof relay.RelayStore> | undefined;
let server: Awaited<ReturnType<typeof relay.startRelayServer>> | undefined;
/** The relay's own folder: not in Studio's (its database stays open until the relay is closed, after Studio). */
let relayDir = "";

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
  await server?.close();
  server = undefined;
  store?.close();
  store = undefined;
  if (relayDir) removeTempDir(relayDir);
  relayDir = "";
});

async function notesApi<T>(s: Studio, method: string, path: string, body?: unknown): Promise<T> {
  const { url, token } = JSON.parse(readFileSync(join(s.dataDir, "notes-home", "running.json"), "utf8")) as { url: string; token: string };
  const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await res.json()) as T;
}

test("绑定到待办: the task's and the session's ⋯ bind a 待办; its tag opens them here, a rename follows, a missing task greys it", async () => {
  // The account (老戴) on the test relay, this computer (台式机) logged in; another device put three items there.
  const root = mkdtempSync(join(tmpdir(), "amo-studio-e2e-"));
  relayDir = mkdtempSync(join(tmpdir(), "amo-todo-bind-relay-"));
  store = new relay.RelayStore(join(relayDir, "relay.db"));
  server = await relay.startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const key = (await new relay.RelayClient(server.url).register("老戴", "pw-dai")).key;
  const amoHome = join(root, "amo-home");
  await account.saveAccount({ server: server.url, name: "老戴", key }, { env: { AMO_HOME: amoHome } });
  mkdirSync(amoHome, { recursive: true });
  writeFileSync(join(amoHome, "device.json"), JSON.stringify({ id: DESK, name: "台式机" }));
  const ops = [
    { op: "put", id: "t_s00000000000001", list: `device:${DESK}`, text: "问题 #10：待办绑定任务", order: 0 },
    { op: "put", id: "t_s00000000000002", list: "shared", text: "周五发版前过一遍 CHANGELOG", order: 0 },
    { op: "put", id: "t_s00000000000003", list: "shared", text: "看一眼值守的测试包", order: 1 },
  ];
  const put = await fetch(`${server.url}/api/todo/ops`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ device: "d_phone00000000000000000", deviceName: "手机", ops }) });
  expect(put.ok).toBe(true);

  studio = await launchStudio({ root });
  const { app, page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("game") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "日常维护", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello" } });
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("task-title")).toHaveText("日常维护");

  // The task's ⋯ → 绑定到待办…: Studio starts the 便签 program, the dialog lists its open items by list.
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-bind-todo").click();
  const dialog = page.getByTestId("todo-bind-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("todo-bind-item")).toHaveCount(3);
  await expect(dialog.getByRole("group", { name: "本机（台式机）" })).toContainText("问题 #10：待办绑定任务");
  await expect(dialog.getByRole("group", { name: "共通" }).getByTestId("todo-bind-item")).toHaveCount(2);
  await screenshot(app, "notes", "T13-studio-bind-dialog", page);
  await dialog.getByText("问题 #10：待办绑定任务").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("toast")).toContainText("已把待办「问题 #10：待办绑定任务」绑定到这个任务");
  const links = async () => (await notesApi<TodoView>(studio!, "GET", "/api/todo")).links;
  expect((await links()).t_s00000000000001).toMatchObject({ taskId: task.id, taskTitle: "日常维护" });
  // Studio is linked to the program (the tag can be opened).
  await expect.poll(async () => (await notesApi<TodoView>(studio!, "GET", "/api/todo")).studio).toBe(true);

  // The session's ⋯: the item bound to the task says so; another one is bound to the session.
  await page.getByTestId("session-more").click();
  await page.getByTestId("session-bind-todo").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("todo-bind-item").filter({ hasText: "问题 #10" })).toContainText("已绑定：日常维护");
  await dialog.getByText("看一眼值守的测试包").click();
  await expect(dialog).toBeHidden();
  expect((await links()).t_s00000000000003).toMatchObject({ taskId: task.id, sessionId: session.id });
  // Opened again: bound here, with 解除绑定 (not used).
  await page.getByTestId("session-more").click();
  await page.getByTestId("session-bind-todo").click();
  await expect(dialog.getByTestId("todo-bind-item").filter({ hasText: "看一眼值守的测试包" })).toHaveAttribute("data-bound", "");
  await expect(dialog.getByTestId("todo-bind-unbind")).toHaveCount(1);
  await screenshot(app, "notes", "T14-studio-bind-bound", page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The tag clicked in 便签: the workbench opens the session; the task's new name goes onto the tag.
  await studio.api("PATCH", `/api/tasks/${task.id}`, { title: "日常维护（11-02）" });
  await notesApi(studio, "POST", "/api/todo/open", { id: "t_s00000000000003" });
  await expect.poll(() => app.evaluate(() => (globalThis as { __amoTodoOpened?: unknown[] }).__amoTodoOpened)).toEqual([{ taskId: task.id, sessionId: session.id }]);
  await expect.poll(async () => (await links()).t_s00000000000003?.taskTitle).toBe("日常维护（11-02）");

  // A task not here (bound elsewhere, or gone): nothing opens, the tag greys.
  await notesApi(studio, "POST", "/api/todo/link", { id: "t_s00000000000002", link: { taskId: "task-not-here", taskTitle: "没有了的任务", boundAt: 1 } });
  await notesApi(studio, "POST", "/api/todo/open", { id: "t_s00000000000002" });
  await expect.poll(async () => (await links()).t_s00000000000002?.gone).toBe(true);
  expect(await app.evaluate(() => (globalThis as { __amoTodoOpened?: unknown[] }).__amoTodoOpened?.length)).toBe(1);
});
