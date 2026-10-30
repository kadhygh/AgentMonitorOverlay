import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RemoteState, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程, step 3 (plans/remote-session.md, 2026-10-29): two Studios on this machine (each its own AMO_HOME and data, the
// mock model), paired through a relay service started here on a free port — never the team server. A grants B a task
// whose conversation names a Markdown file, an HTML page with a picture beside it, a big picture, a program and a file
// outside the task's folder. On B each link opens the viewer, which fetches the file from A (saying so, with how far it
// came) and shows it — the Markdown's and the page's pictures too; the program is not offered, the outside file is
// refused by A, saying why.

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

/** A PNG of one colour (`level` 0 keeps it big: a picture that takes a while to come over). */
function png(width: number, height: number, rgb: [number, number, number], level = 9): Buffer {
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
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
  // 远程 is off until turned on (2026-10-30).
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

test("B opens a remote task's Markdown, HTML and pictures: fetched from A with a progress bar, pictures beside them shown; other kinds and files outside the task's folder are refused, saying why", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("remote-files");
  const proj = a.workspace("掉落表");
  mkdirSync(join(proj, "docs", "img"), { recursive: true });
  writeFileSync(join(proj, "docs", "a.md"), "# 掉落说明\n\n远程打开的 Markdown，旁边的图：\n\n![色块](img/p.png)\n\n看 [页面](page.html)\n");
  writeFileSync(join(proj, "docs", "page.html"), '<!doctype html><html><head><meta charset="utf-8"><title>页面</title></head><body><h1>远程页面</h1><p>同目录的图：</p><img id="pic" src="img/p.png" width="160"><p><a id="script" href="../tools/gen.py">生成脚本</a> <a id="tool" href="../run.exe">程序</a></p></body></html>');
  mkdirSync(join(proj, "tools"), { recursive: true });
  writeFileSync(join(proj, "tools", "gen.py"), "# 生成这份页面的脚本\nprint('远程脚本')\n");
  writeFileSync(join(proj, "docs", "img", "p.png"), png(160, 80, [217, 119, 87]));
  // About 12 MB stored without compression: it comes over in some 24 pieces, long enough to watch.
  writeFileSync(join(proj, "docs", "img", "big.png"), png(2000, 2000, [80, 120, 200], 0));
  writeFileSync(join(proj, "run.exe"), "MZ");
  const outside = join(a.root, "别的地方");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.md"), "不该给出去的");
  const ws = await a.api<Workspace>("POST", "/api/workspaces", { path: proj });
  const { task } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "带文件的远程任务",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: `看 \`docs/a.md\`、\`docs/page.html\`、\`docs/img/big.png\`、\`run.exe\` 和 \`${join(outside, "secret.md")}\`` },
  });
  await a.page.getByTestId("task-card").filter({ hasText: "带文件的远程任务" }).click();
  await expect(a.page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 60_000 });
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "笔记本的我", device: (await b.api<RemoteState>("GET", "/api/remote")).device!.id });

  const card = b.page.getByTestId("task-card").filter({ hasText: "带文件的远程任务" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  const reply = b.page.getByTestId("msg-agent").last();
  await expect(reply).toContainText("MOCK", { timeout: 30_000 });
  const link = (path: string) => reply.locator(`[data-file-link][data-path="${path.replace(/\\/g, "\\\\")}"]`);

  // The Markdown: the viewer fetches it, then shows it rendered, its picture fetched too.
  const viewer = await nextWindow(b.app, () => link("docs/a.md").click());
  await expect(viewer.getByTestId("viewer-md")).toContainText("远程打开的 Markdown", { timeout: 30_000 });
  await expect(viewer.getByTestId("viewer-name")).toHaveText("a.md");
  await expect(viewer.getByTestId("viewer-remote-where")).toContainText("A 台式机 · 任务文件夹/docs");
  const img = viewer.getByTestId("md-image");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(160);
  // What would be this computer's copy is not offered: VS Code, Explorer, 书签; 改动 is off.
  await expect(viewer.getByTestId("viewer-reveal")).toHaveCount(0);
  await expect(viewer.getByTestId("viewer-mode-changes")).toBeDisabled();
  await expect(viewer.getByTestId("passage-notes")).toContainText("远程任务的文件只能看");
  await screenshot(b.app, "studio", "remote-viewer-markdown", viewer, "viewer");

  // The big picture: 「正在从 A 台式机 取文件…」 with how far it came, then the picture.
  await link("docs/img/big.png").click();
  await expect(viewer.getByTestId("viewer-remote-loading")).toHaveText("正在从 A 台式机 取文件…", { timeout: 10_000 });
  await expect(viewer.getByTestId("viewer-remote-progress")).toContainText(" / ", { timeout: 10_000 });
  await screenshot(b.app, "studio", "remote-viewer-loading", viewer, "viewer");
  await expect(viewer.getByTestId("file-preview-image")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => viewer.getByTestId("file-preview-image").evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 20_000 }).toBe(2000);

  // The HTML page, in the same viewer: its picture beside it loads from A through B's Host.
  await link("docs/page.html").click();
  const frame = viewer.frameLocator('[data-testid="viewer-html"]');
  await expect(frame.locator("h1")).toHaveText("远程页面", { timeout: 30_000 });
  await expect.poll(() => frame.locator("#pic").evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 20_000 }).toBe(160);
  await screenshot(b.app, "studio", "remote-viewer-html", viewer, "viewer");

  // A script the page links to (2026-10-29): fetched from A and shown as text, as A's own viewer would; back to the page.
  await frame.locator("#script").click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("gen.py", { timeout: 30_000 });
  await expect(viewer.getByRole("main")).toContainText("print('远程脚本')");
  await expect(viewer.getByTestId("viewer-remote-where")).toContainText("任务文件夹/tools");
  await screenshot(b.app, "studio", "remote-viewer-script", viewer, "viewer");
  await link("docs/page.html").click();
  await expect(frame.locator("h1")).toHaveText("远程页面", { timeout: 30_000 });
  // A program it links to: said, and the page stays.
  await frame.locator("#tool").click();
  await expect(viewer.getByTestId("toast")).toContainText("远程任务不能看程序和二进制文件");
  await expect(frame.locator("h1")).toHaveText("远程页面");

  // Opened again unchanged: no transfer, straight from B's copy (the Host says it was cached).
  const again = await b.api<{ cached: boolean; rel: string }>("POST", "/api/remote/files", { taskId: task.id, path: "docs/page.html" });
  expect(again).toMatchObject({ cached: true, rel: "docs/page.html" });

  // A program: not offered (said on B); a file outside the task's folder: A refuses, the viewer says why.
  await link("run.exe").click();
  await expect(b.page.getByTestId("toast")).toContainText("远程任务不能看程序和二进制文件");
  await link(join(outside, "secret.md")).click();
  await expect(viewer.getByTestId("viewer-remote-error")).toContainText("不在任务的文件夹里", { timeout: 30_000 });
  await screenshot(b.app, "studio", "remote-viewer-refused", viewer, "viewer");

  // Archived on B: the copy goes, and the files fetched for it with it.
  await b.page.getByTestId("task-archive").click();
  await expect(b.page.getByTestId("task-card").filter({ hasText: "带文件的远程任务" })).toHaveCount(0);
  // (The folder is moved aside at once, even while a file in it is held a moment by a virus scan; deleted after.)
  await expect.poll(() => existsSync(join(b.dataDir, "remote-files", task.id)), { timeout: 5_000 }).toBe(false);
});
