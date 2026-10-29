import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { ModelProfile, RemoteState, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程创建 (plans/remote-page-and-new-task.md 4.1, 2026-10-29): two Studios on this machine (each its own AMO_HOME and
// data, the mock model), paired through a relay service started here — never the team server. A ticks 远端允许的模型 and
// 远端允许的项目 in 远程 → 远程设置 (before that, B's new-task page says where to tick); B opens 新任务, switches to
// 「在别的设备上」 (the device card's 「在它上面新建任务」 does it with A picked), picks a topic — its one allowed project
// comes with it — types the first sentence, Enter: the task is made on A in that topic and project, granted to B, its
// session runs on A, and B's page opens the copy.

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

/** The top bar's 「远程」 → the remote page. */
async function openRemote(page: Page) {
  await page.getByTestId("topbar-remote").click();
  const remote = page.getByRole("region", { name: "远程", exact: true });
  await expect(remote).toBeVisible();
  return remote;
}

test("A ticks a project and a model; B creates a task on A from its new-task page: made in the topic and project, running on A, the copy opened on B", async () => {
  test.setTimeout(300_000);
  root = mkdtempSync(join(tmpdir(), "amo-remote-create-e2e-"));
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

  // A: two projects and a topic whose projects are both (only one will be allowed).
  const allowed = await a.api<Workspace>("POST", "/api/workspaces", { path: a.workspace("可以远程的项目") });
  const other = await a.api<Workspace>("POST", "/api/workspaces", { path: a.workspace("不给远程的项目") });
  const topic = await a.api<Topic>("POST", "/api/topics", { title: "掉落表整理", workspaceIds: [allowed.id, other.id] });

  // B before A ticked anything: the switch is there, and the page says where to tick on A.
  await b.page.getByRole("button", { name: "+ 新任务" }).click();
  const side = b.page.getByTestId("draft-side");
  await expect(side).toBeVisible();
  await side.getByRole("button", { name: "在别的设备上" }).click();
  const draft = b.page.getByTestId("remote-draft");
  await expect(draft.getByTestId("remote-draft-device")).toHaveText("A 台式机");
  await expect(draft.getByTestId("remote-draft-device")).toHaveAttribute("aria-pressed", "true");
  await expect(draft.getByTestId("remote-draft-state")).toContainText("A 台式机 还没勾远端允许的项目：在那台电脑的 远程 → 远程设置 里勾");
  await expect(b.page.getByTestId("remote-draft-start")).toBeDisabled();
  await screenshot(b.app, "studio", "remote-create-not-allowed", b.page);
  // Back to this computer: the local rows again.
  await side.getByRole("button", { name: "在这台电脑上" }).click();
  await expect(b.page.getByRole("group", { name: "设备" })).toHaveCount(0);
  await expect(b.page.getByRole("group", { name: "项目" })).toBeVisible();
  await b.page.getByTestId("back").click();

  // A: 远程 → 远程设置: a model, then a project (not the common folder).
  const aRemote = await openRemote(a.page);
  await aRemote.getByTestId("remote-settings-open").click();
  const mock = (await a.api<{ profiles: ModelProfile[] }>("GET", "/api/state")).profiles.find((p) => p.id === "codex-mock")!;
  const models = aRemote.getByTestId("remote-allowed");
  await models.getByTestId("remote-allowed-item").filter({ hasText: mock.label }).locator("input").check();
  await models.getByTestId("remote-allowed-save").click();
  await expect(aRemote.getByTestId("remote-message")).toHaveText("已保存远端允许的模型");
  const projects = aRemote.getByTestId("remote-allowed-projects");
  await expect(projects.getByTestId("remote-allowed-projects-state")).toHaveText("! 一个都不勾：别的设备不能在这台电脑上建任务。");
  await projects.getByTestId("remote-allowed-project").filter({ hasText: "可以远程的项目" }).locator("input").check();
  await expect(projects.getByTestId("remote-allowed-projects-state")).toHaveText("别的设备可以在 1 个项目里建任务。");
  await projects.getByTestId("remote-allowed-projects-save").click();
  await expect(aRemote.getByTestId("remote-message")).toHaveText("已保存远端允许的项目");
  await projects.scrollIntoViewIfNeeded();
  await screenshot(a.app, "studio", "remote-allowed-projects", a.page);
  expect((await a.api<RemoteState>("GET", "/api/remote")).allowedProjects).toEqual({ workspaceIds: [allowed.id], common: false });

  // B: 远程 → A's card → 在它上面新建任务: the new-task page in 「在别的设备上」, A picked, A's catalog.
  const bRemote = await openRemote(b.page);
  await bRemote.getByTestId("remote-peer").filter({ hasText: "A 台式机" }).getByTestId("remote-new-task").click();
  await expect(b.page.getByTestId("draft-side-remote")).toHaveAttribute("aria-pressed", "true");
  const topics = draft.getByRole("group", { name: "专题" });
  const projectRow = draft.getByRole("group", { name: "项目" });
  await expect(topics.getByRole("button", { name: "掉落表整理" })).toBeVisible();
  // Only the allowed project; 「不选」 (the common folder) is not allowed there.
  await expect(projectRow.getByRole("button")).toHaveText(["不选", "可以远程的项目"]);
  await expect(projectRow.getByRole("button", { name: "不选" })).toBeDisabled();
  await expect(b.page.getByTestId("remote-draft-model")).toHaveText([`Codex · ${mock.label}`]);
  await expect(b.page.getByTestId("remote-draft-model")).toHaveAttribute("aria-pressed", "true");
  await expect(b.page.getByTestId("remote-draft-attach-note")).toContainText("远程任务暂时不能发图片和文件");
  // The topic picks its one allowed project.
  await topics.getByRole("button", { name: "掉落表整理" }).click();
  await expect(projectRow.getByRole("button", { name: /可以远程的项目/ })).toHaveAttribute("aria-pressed", "true");
  await expect(b.page.getByTestId("scope-hint")).toHaveText("在 A 台式机 上的 可以远程的项目 里运行 · 放进那边的「掉落表整理」");
  const text = b.page.getByTestId("remote-draft-text");
  await text.fill("在台式机上整理掉落表");
  await screenshot(b.app, "studio", "remote-create-page", b.page);
  await text.press("Enter");

  // B: the copy's task page, the session running on A.
  await expect(b.page.locator(".page-head")).toContainText("在台式机上整理掉落表", { timeout: 60_000 });
  await expect(b.page.getByTestId("msg-agent").last()).toContainText("MOCK: 在台式机上整理掉落表", { timeout: 60_000 });
  await screenshot(b.app, "studio", "remote-create-running", b.page);
  // A: the task in the topic and the allowed project, granted to B, its session on the allowed model.
  const aState = await a.api<{ tasks: Task[]; sessions: Session[] }>("GET", "/api/state");
  const made = aState.tasks.find((t) => t.title === "在台式机上整理掉落表")!;
  expect(made).toMatchObject({ workspaceId: allowed.id, topicId: topic.id, column: "doing" });
  expect(aState.sessions.filter((s) => s.taskId === made.id).map((s) => s.profileId)).toEqual(["codex-mock"]);
  expect((await a.api<RemoteState>("GET", "/api/remote")).grants).toMatchObject([{ taskId: made.id, account: "笔记本的我" }]);
  // B's board: the remote card.
  await b.page.getByTestId("back").click();
  await b.page.getByTestId("back").click();
  const card = b.page.getByTestId("task-card").filter({ hasText: "在台式机上整理掉落表" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
});
