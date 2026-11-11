import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RemoteState, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";
import { exerciseImageView, png } from "../support/images.js";

// 远程网页、md 里的链接 (2026-11-11, the user: 控制端在 Reviewer 里看的是网页或 md 时，里面的跳转链接也应该有效，点了像看第一层
// 内容一样打开 — 只要多覆盖一层). Two Studios paired through a relay started here (never the team server); B opens a
// remote task's Markdown and HTML, from the conversation and from a 查看包, and follows their links one level down.
// 图片缩放、拖拽 + 右键另存为 (the same day): a remote task's picture on B, fitted, zoomed, dragged and saved on B.

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

test("B follows the links of a remote task's Markdown and HTML one level down, from the conversation and from a 查看包; its pictures zoom, drag and save on B", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("remote-links");
  const proj = a.workspace("说明");
  mkdirSync(join(proj, "docs", "sub"), { recursive: true });
  writeFileSync(join(proj, "docs", "a.md"), "# 第一层\n\n看 [第二层](sub/b.md)，或者 [页面](page.html)。\n");
  writeFileSync(join(proj, "docs", "sub", "b.md"), "# 第二层\n\n回到 [第一层](../a.md)。\n");
  writeFileSync(join(proj, "docs", "page.html"), '<!doctype html><html><head><meta charset="utf-8"><title>页面</title></head><body><h1>远程页面</h1><p><a id="deep" href="sub/b.md">第二层</a> <a id="deep-html" href="sub/c.html">另一页</a></p></body></html>');
  const shot = png(1400, 900, [80, 140, 210]);
  writeFileSync(join(proj, "docs", "shot.png"), shot);
  writeFileSync(join(proj, "docs", "sub", "c.html"), '<!doctype html><html><head><meta charset="utf-8"><title>另一页</title></head><body><h1>第二层页面</h1></body></html>');
  const ws = await a.api<Workspace>("POST", "/api/workspaces", { path: proj });
  const { task, session } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "远程链接", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "看 `docs/a.md`、`docs/page.html` 和 `docs/shot.png`" } });
  await a.page.getByTestId("task-card").filter({ hasText: "远程链接" }).click();
  await expect(a.page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 60_000 });
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "笔记本的我", device: (await b.api<RemoteState>("GET", "/api/remote")).device!.id });

  const card = b.page.getByTestId("task-card").filter({ hasText: "远程链接" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  const reply = b.page.getByTestId("msg-agent").last();
  await expect(reply).toContainText("MOCK", { timeout: 30_000 });
  const link = (path: string) => reply.locator(`[data-file-link][data-path="${path}"]`);

  // From the conversation: the Markdown, then its link to a Markdown one folder down, fetched from A as the first was.
  const viewer = await nextWindow(b.app, () => link("docs/a.md").click());
  const md = viewer.getByTestId("viewer-md");
  await expect(md).toContainText("第一层", { timeout: 30_000 });
  await md.getByRole("link", { name: "第二层" }).click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("b.md", { timeout: 30_000 });
  await expect(md).toContainText("回到", { timeout: 30_000 });
  await expect(viewer.getByTestId("viewer-remote-where")).toContainText("任务文件夹/docs/sub");
  await screenshot(b.app, "studio", "remote-viewer-md-link", viewer, "viewer");

  // The HTML page: its links to a Markdown and to another page.
  await link("docs/page.html").click();
  const frame = viewer.frameLocator('[data-testid="viewer-html"]');
  await expect(frame.locator("h1")).toHaveText("远程页面", { timeout: 30_000 });
  await frame.locator("#deep-html").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("c.html", { timeout: 30_000 });
  await expect(frame.locator("h1")).toHaveText("第二层页面", { timeout: 30_000 });

  // A picture of the task, fetched from A: fitted whole, zoomed, dragged, saved on B through 另存为….
  await link("docs/shot.png").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("shot.png", { timeout: 30_000 });
  mkdirSync(join(root, "saved-on-b"), { recursive: true });
  await exerciseImageView(b.app, viewer, { imgTestId: "file-preview-image", saveTo: join(root, "saved-on-b", "shot.png"), bytes: shot, width: 1400, height: 900 });
  await screenshot(b.app, "studio", "remote-viewer-image", viewer, "viewer");

  // From a 查看包 B's turn opened: the Markdown item's link, and the page item's.
  // (It shows in the viewer window already open: the preview window is reused.)
  await b.api("POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: view_open ${JSON.stringify({ title: "远程链接的包", items: [{ kind: "file", path: "docs/a.md" }, { kind: "file", path: "docs/page.html" }] })}]]` });
  const pack = viewer;
  await expect(pack.getByTestId("viewpack-title")).toHaveText("远程链接的包", { timeout: 30_000 });
  const packMd = pack.getByTestId("viewer-md");
  await expect(packMd).toContainText("第一层", { timeout: 30_000 });
  await packMd.getByRole("link", { name: "第二层" }).click();
  await expect(pack.getByTestId("viewer-name")).toHaveText("b.md", { timeout: 30_000 });
  await expect(pack.getByTestId("viewer-md")).toContainText("回到", { timeout: 30_000 });
  await screenshot(b.app, "studio", "remote-pack-md-link", pack, "viewer");
});
