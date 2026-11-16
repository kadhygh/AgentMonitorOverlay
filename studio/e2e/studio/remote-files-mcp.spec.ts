import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { REMOTE_MCP_SINCE, withFileRefs, type RemoteState, type Session, type SessionItem, type StateSnapshot, type Task, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程补取和远程选 MCP (2026-11-17): two Studios on this machine (each its own AMO_HOME and data, the mock models), paired
// through a relay service started here — never the team server.
// 补取: a picture of a remote task that does not load on B is asked of A again by itself (and with 再请求一次); the files B
// sent along with a message (kept in A's attachments folder, named in its 引用文件 block) open on B; one gone on A says so.
// 远程选 MCP: B picks A's MCP servers for a task it creates on A, changes them for the running session, sees them in 新会话
// and 分支; only names come over, never a key; an older A greys the choice, saying what to update to.

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

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from(rgb))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A picture kept as one of `s`'s attachments (the composer's paste does the same). */
async function upload(s: Studio, data: Buffer, name: string): Promise<{ id: string; path: string }> {
  const info = JSON.parse(readFileSync(join(s.dataDir, "host.json"), "utf8")) as { url: string };
  const token = readFileSync(join(s.dataDir, "host-token"), "utf8").trim();
  const res = await fetch(`${info.url}/api/attachments?type=image/png&name=${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/png" }, body: new Uint8Array(data) });
  return (await res.json()) as { id: string; path: string };
}

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

async function nextWindow(app: ElectronApplication, act: () => Promise<unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await act();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

const items = (s: Studio, sessionId: string) => s.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`);
const idle = (s: Studio, sessionId: string) => until(() => s.api<StateSnapshot>("GET", "/api/state"), (st) => st.sessions.find((x) => x.id === sessionId)?.status !== "running", "the session idle", 60_000);

test("补取: a picture that does not load on B is asked of A again — by itself, and with 再请求一次; the files B sent along open on B; one gone on A says so", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("remote-late-files");
  // A: a task whose first message carries a picture, before B was given it.
  const ws = await a.api<Workspace>("POST", "/api/workspaces", { path: a.workspace("早先的对话") });
  const pic = await upload(a, png(120, 60, [217, 119, 87]), "截图.png");
  const { task, session } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "早先发过图的任务", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "看这张图", attachments: [pic.id] } });
  await until(() => items(a, session.id), (list) => list.some((i) => i.type === "agent" && !i.streaming), "A's reply");
  await idle(a, session.id);
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "笔记本的我", device: (await b.api<RemoteState>("GET", "/api/remote")).device!.id });

  // B's copy names its own copy of the picture once it came.
  const copy = await until(() => b.api<StateSnapshot>("GET", "/api/state"), (st) => st.sessions.some((s) => s.taskId === task.id), "B's copy").then((st) => st.sessions.find((s) => s.taskId === task.id)!);
  const mine = await until(
    () => items(b, copy.id).then((list) => list.find((i) => i.type === "user")?.images?.[0]?.id ?? null),
    (id) => !!id && id !== pic.id,
    "B's own copy of the picture",
  );

  // The picture does not load once (as when fetching it failed): asked of A by itself, then shown.
  await b.page.route((u) => u.pathname === `/api/attachments/${mine}`, (r) => r.abort(), { times: 1 });
  const asked = b.page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/remote/tasks/${task.id}/images`));
  const card = b.page.getByTestId("task-card").filter({ hasText: "早先发过图的任务" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  await asked;
  const shown = b.page.getByTestId("msg-image").locator("img");
  await expect.poll(() => shown.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(120);

  // When A cannot give it, the place says why, with 再请求一次 (A's answer stood in here: unit tests cover A's side,
  // remote-tasks.test.ts 补取).
  await b.page.route((u) => u.pathname === `/api/attachments/${mine}`, (r) => r.abort(), { times: 1 });
  await b.page.route(
    (u) => u.pathname === `/api/remote/tasks/${task.id}/images`,
    (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: `A 台式机 上也没有这个文件了（可能已经删掉或挪走）：${pic.path}` } }) }),
    { times: 1 },
  );
  await b.page.reload();
  await b.page.waitForLoadState("domcontentloaded");
  if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) await card.click();
  const miss = b.page.getByTestId("msg-image-miss");
  await expect(miss).toContainText("A 台式机 上也没有这个文件了", { timeout: 30_000 });
  await expect(miss.getByTestId("msg-image-again")).toBeVisible();
  await screenshot(b.app, "studio", "remote-image-missing", b.page);
  // 再请求一次: asked of A for real this time.
  await miss.getByTestId("msg-image-again").click();
  await expect.poll(() => shown.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(120);
  await expect(miss).toHaveCount(0);

  // B sends two files along; A keeps them in its attachments folder and names them in the message's 引用文件 block.
  const mineDir = b.workspace("B 的文件");
  writeFileSync(join(mineDir, "掉落说明.txt"), "Boss 掉率 5%");
  writeFileSync(join(mineDir, "会删掉的.txt"), "过一会儿就没了");
  await b.api("POST", `/api/sessions/${copy.id}/messages`, { text: withFileRefs("按这两份改", [join(mineDir, "掉落说明.txt"), join(mineDir, "会删掉的.txt")]) });
  const sent = await until(() => items(a, session.id).then((list) => list.filter((i) => i.type === "user").at(-1)), (u) => !!u && u.type === "user" && u.text.includes("会删掉的.txt"), "A's copy of the message");
  const gone = /- (.+会删掉的\.txt)/.exec((sent as { text: string }).text)![1]!;
  await idle(a, session.id);
  rmSync(gone);
  const files = b.page.getByTestId("msg-file");
  await expect(files.filter({ hasText: "掉落说明.txt" })).toBeVisible({ timeout: 30_000 });
  // Before, A refused these on every device: 「不在任务的文件夹里」.
  const viewer = await nextWindow(b.app, () => files.filter({ hasText: "掉落说明.txt" }).click());
  await expect(viewer.getByRole("main")).toContainText("Boss 掉率 5%", { timeout: 30_000 });
  await expect(viewer.getByTestId("viewer-remote-where")).toContainText("A 台式机 · 附件");
  await screenshot(b.app, "studio", "remote-viewer-attached-file", viewer, "viewer");
  await files.filter({ hasText: "会删掉的.txt" }).click();
  await expect(viewer.getByTestId("viewer-remote-error")).toContainText("A 台式机 上也没有这个文件了", { timeout: 30_000 });
  await screenshot(b.app, "studio", "remote-viewer-gone-on-peer", viewer, "viewer");
});

test("远程选 MCP: B picks A's MCP servers for a task it creates there and changes them for the running session; 新会话 and 分支 list them; no key comes over; an older A greys it", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("remote-mcp");
  const ws = await a.api<Workspace>("POST", "/api/workspaces", { path: a.workspace("带 MCP 的项目") });
  await a.api("PUT", "/api/remote/allowed-projects", { workspaceIds: [ws.id], common: false });
  await a.api("PUT", "/api/remote/allowed", { profiles: ["claude-mock", "codex-mock"], defaultProfile: null, permission: null });
  await a.api("PUT", "/api/remote/security", { sameAccount: "run", otherAccount: "run" });
  // Two of A's own MCP servers, with keys that must stay on A (they exit at once: nothing here needs them running).
  await a.api("POST", "/api/mcp/servers", { name: "figma", spec: { type: "stdio", command: "node", args: ["-e", "process.exit(0)"], env: { FIGMA_KEY: "sk-e2e-secret" } }, note: "设计稿" });
  await a.api("POST", "/api/mcp/servers", { name: "webtool", spec: { type: "stdio", command: "node", args: ["-e", "process.exit(0)", "--webtool-arg"], env: { WEB_TOKEN: "tok-e2e-secret" } }, on: false });
  const leaked = async (p: Page) => (await p.content()).match(/sk-e2e-secret|tok-e2e-secret|FIGMA_KEY|WEB_TOKEN|process\.exit|--webtool-arg/g);

  // B: 新任务 → 在别的设备上 → the project and Claude: A's MCP, as A would start them (figma on, webtool off).
  await b.page.getByRole("button", { name: "+ 新任务" }).click();
  await b.page.getByTestId("draft-side").getByRole("button", { name: "在别的设备上" }).click();
  const draft = b.page.getByTestId("remote-draft");
  await draft.getByRole("group", { name: "项目" }).getByRole("button", { name: /带 MCP 的项目/ }).click();
  await b.page.getByTestId("remote-draft-model").filter({ hasText: "Mock Claude" }).click();
  const pick = b.page.getByTestId("remote-draft-mcp");
  await expect(pick.getByTestId("mcp-pick-figma")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(pick.getByTestId("mcp-pick-webtool")).toHaveAttribute("aria-pressed", "false");
  await pick.getByTestId("mcp-pick-figma").click();
  await pick.getByTestId("mcp-pick-webtool").click();
  await expect(pick.getByTestId("mcp-pick-figma")).toContainText("改过");
  expect(await leaked(b.page)).toBeNull();
  await b.page.getByTestId("remote-draft-text").fill("带着 webtool 开始");
  await screenshot(b.app, "studio", "remote-mcp-new-task", b.page);
  // Codex there cannot take a choice per session: listed, not to be ticked.
  await b.page.getByTestId("remote-draft-model").filter({ hasText: "Codex" }).click();
  await expect(pick.getByTestId("mcp-pick-figma")).toBeDisabled({ timeout: 30_000 });
  await expect(pick).toContainText("Codex 的 MCP 在它启动时就定了");
  await b.page.getByTestId("remote-draft-model").filter({ hasText: "Mock Claude" }).click();
  await pick.getByTestId("mcp-pick-figma").click();
  await pick.getByTestId("mcp-pick-webtool").click();
  await b.page.getByTestId("remote-draft-text").press("Enter");

  // Made on A with that choice.
  await expect(b.page.locator(".page-head")).toContainText("带着 webtool 开始", { timeout: 60_000 });
  const made = await until(() => a.api<StateSnapshot>("GET", "/api/state"), (s) => s.tasks.some((t) => t.title === "带着 webtool 开始"), "made on A");
  const task = made.tasks.find((t) => t.title === "带着 webtool 开始")!;
  const onA = () => a.api<StateSnapshot>("GET", "/api/state").then((s) => s.sessions.find((x) => x.taskId === task.id)!);
  expect((await onA()).options.mcp).toEqual({ figma: false, webtool: true });
  await expect(b.page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 60_000 });
  await idle(a, (await onA()).id);

  // The running session's MCP from B: A's list, changed on A.
  await b.page.getByTestId("switch-mcp").click();
  const tray = b.page.getByTestId("mcp-tray");
  await expect(b.page.getByText("MCP（A 台式机 上的）")).toBeVisible();
  await expect(b.page.getByText("要添加或删掉 MCP，在 A 台式机 上的 设置 → MCP 里改")).toBeVisible();
  await expect(b.page.getByTestId("mcp-manage")).toHaveCount(0);
  await tray.getByTestId("mcp-tray-webtool").locator("input").uncheck();
  await expect.poll(async () => (await onA()).options.mcp?.webtool ?? false, { timeout: 30_000 }).toBe(false);
  expect(await leaked(b.page)).toBeNull();
  await screenshot(b.app, "studio", "remote-mcp-session-tray", b.page);
  await b.page.keyboard.press("Escape");

  // 新会话: the model there, and A's MCP for it.
  await b.page.getByTestId("new-session-toggle").click();
  const form = b.page.getByTestId("new-session-dialog");
  await form.getByTestId("new-session-remote-model").filter({ hasText: "Mock Claude" }).click();
  await expect(form.getByTestId("mcp-pick-figma")).toBeVisible({ timeout: 30_000 });
  await screenshot(b.app, "studio", "remote-mcp-new-session", b.page);
  await form.getByRole("button", { name: "取消" }).click();

  // 分支 of the Claude session: A's MCP to pick too.
  const foot = b.page.getByTestId("turn-foot").first();
  await foot.hover();
  await foot.getByTestId("turn-fork").click();
  const fork = b.page.getByTestId("fork-dialog");
  await expect(fork.getByTestId("fork-remote-mcp").getByTestId("mcp-pick-webtool")).toBeVisible({ timeout: 30_000 });
  await screenshot(b.app, "studio", "remote-mcp-fork", b.page);
  await b.page.keyboard.press("Escape");

  // 允许控制端选 MCP off on A (远程 → 远程设置 → 远端允许的模型): B's dialog lists A's MCP greyed, saying why.
  await a.page.getByTestId("topbar-remote").click();
  const aRemote = a.page.getByRole("dialog", { name: "远程", exact: true });
  await aRemote.getByTestId("remote-settings-open").click();
  const aSettings = a.page.getByRole("dialog", { name: "远程设置", exact: true });
  const allowedModels = aSettings.getByTestId("remote-allowed");
  await allowedModels.getByTestId("remote-allowed-mcp").locator("input").uncheck();
  await expect(allowedModels.getByTestId("remote-allowed-mcp")).toContainText("会话按这台电脑默认的 MCP 开");
  await allowedModels.getByTestId("remote-allowed-save").click();
  await expect(aSettings.getByTestId("remote-settings-message")).toHaveText("已保存远端允许的模型");
  await allowedModels.scrollIntoViewIfNeeded();
  await screenshot(a.app, "studio", "remote-allowed-mcp-off", a.page);
  expect((await a.api<RemoteState>("GET", "/api/remote")).allowed.mcp).toBe(false);
  await b.page.getByTestId("new-session-toggle").click();
  const lockedForm = b.page.getByTestId("new-session-dialog");
  await lockedForm.getByTestId("new-session-remote-model").filter({ hasText: "Mock Claude" }).click();
  await expect(lockedForm.getByTestId("mcp-pick-locked")).toContainText("A 台式机 的远程设置没有允许控制端选 MCP", { timeout: 30_000 });
  await expect(lockedForm.getByTestId("mcp-pick-figma")).toBeDisabled();
  await lockedForm.getByTestId("new-session-title").fill("按默认 MCP 开");
  await screenshot(b.app, "studio", "remote-mcp-locked", b.page);
  await lockedForm.getByTestId("remote-start").click();
  await expect(lockedForm).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(async () => (await a.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.taskId === task.id && s.title === "按默认 MCP 开")?.profileId, { timeout: 30_000 }).toBe("claude-mock");

  // An older Studio on A (its snapshot has no mcp mark): B greys the MCP, saying what A has to update to; sessions still
  // start. Made so by taking the mark off B's copy (A says it again only with its next snapshot or task push).
  const db = new DatabaseSync(join(b.dataDir, "studio.db"));
  try {
    const row = db.prepare("SELECT remote FROM tasks WHERE id = ?").get(task.id) as { remote: string };
    const { mcp: _mcp, ...older } = JSON.parse(row.remote) as Record<string, unknown>;
    db.prepare("UPDATE tasks SET remote = ? WHERE id = ?").run(JSON.stringify(older), task.id);
  } finally {
    db.close();
  }
  await b.page.reload();
  await b.page.waitForLoadState("domcontentloaded");
  const card = b.page.getByTestId("task-card").filter({ hasText: "带着 webtool 开始" });
  if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) await card.click();
  await expect(b.page.getByTestId("switch-mcp")).toBeDisabled({ timeout: 30_000 });
  await expect(b.page.getByTestId("switch-mcp")).toHaveAttribute("title", `A 台式机 上的 Studio 要更新到 ${REMOTE_MCP_SINCE} 或更新的版本，才能在这台电脑上改这个会话的 MCP`);
  await b.page.getByTestId("new-session-toggle").click();
  await expect(b.page.getByTestId("new-session-dialog").getByTestId("mcp-pick")).toContainText(`A 台式机 上的 Studio 要更新到 ${REMOTE_MCP_SINCE} 或更新的版本`);
  await screenshot(b.app, "studio", "remote-mcp-old-peer", b.page);
});
