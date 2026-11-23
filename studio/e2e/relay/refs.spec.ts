import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { listenInStudioRange } from "@amo-studio/testkit";
import { programLaunch } from "../support/packed.js";

// 复制引用 and the jumps (2026-11-23, the user: 可以，按你的建议做 / 反向跳转也一起做). 程序老李's computer has a Studio
// (a stand-in here: host.json, host-token, /api/health and /api/ui/open answered in this process); 策划小王's has none.
// 老李 copies the refs of a 协作 (by its title), a message (right click), a 子会话 (its card, its window) and a 中转会话
// (its row, its page); 小王 sends him a chat with refs in it, shown as chips: the ones he can see open what they name,
// one he cannot says so, a Studio session of his own computer opens in Studio, one of another computer says that.
// 在 Studio 里打开 is offered for his own AIs only: in the 协作's member list, on his AI's name in the 群聊, on the line
// over the box; not for 小王's AI, and his AI on another computer says 在另一台电脑上. Then the other way: a second start
// with --open=cowork:<id> brings the 协作 up, one he is not in says so, --open=thread:<id> opens a 子会话; and 美术小周's
// client started with --open=cowork: before signing in says it waits, and opens it once signed in (running.json has
// what Studio needs to start it). Needs `npm run relay:release` first (release/relay/client).

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const built = join(process.env.AMO_RELAY_E2E_RELEASE ?? join(studio, "release", "relay"), "client");
const shots = join(studio, "screenshots", "relay");
const relay = (await import(pathToFileURL(join(studio, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");

let root: string;
let store: InstanceType<typeof relay.RelayStore>;
let server: Awaited<ReturnType<typeof relay.startRelayServer>>;
const apps: ElectronApplication[] = [];
const pageErrors: string[] = [];
let fakeHost: Server | null = null;

test.beforeAll(async () => {
  test.skip(!existsSync(join(built, "manifest.json")), "run npm run relay:release first");
  root = mkdtempSync(join(tmpdir(), "relay-e2e-refs-"));
  cpSync(built, join(root, "public", "client"), { recursive: true });
  store = new relay.RelayStore(join(root, "server", "relay.db"));
  server = await relay.startRelayServer({ store, publicDir: join(root, "public"), filesDir: join(root, "files"), transfersDir: join(root, "transfers"), host: "127.0.0.1", port: 0, name: "战斗组", clientWatchMs: 300, transferFreeBytes: async () => 100 * 1024 ** 3 });
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  fakeHost?.close();
  await server?.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function start(who: string, pc: string, opts: { env?: Record<string, string>; args?: string[]; signIn?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = join(root, pc);
  const launched = programLaunch("relay-app", join(studio, "packages", "relay-app", "dist", "main.js"));
  const app = await _electron.launch({ executablePath: launched.executablePath, args: [...launched.args, "--server", server.url, ...(opts.args ?? [])], env: { ...process.env, AMO_RELAY_HOME: home, AMO_HOME: join(home, "amo-home"), AMO_STUDIO_HOME: join(home, "studio-home"), AMO_RELAY_TEST: "1", COMPUTERNAME: pc, ...opts.env } });
  apps.push(app);
  const page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.stack ?? e.message}`));
  await expect(page.getByRole("button", { name: "没有账号？注册一个" })).toBeVisible({ timeout: 30_000 });
  if (opts.signIn !== false) await signIn(page, who);
  return { app, page, home };
}
async function signIn(page: Page, who: string): Promise<void> {
  await page.getByLabel("名字").fill(who);
  await page.getByLabel("密码", { exact: true }).fill("pw-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".rail")).toBeVisible();
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}
const size = (app: ElectronApplication, w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [w, h]);
const theme = (page: Page, t: "light" | "dark") => page.evaluate((t) => (document.documentElement.dataset.theme = t), t);
/** What 复制… copied: kept in the test client, never on this machine's clipboard. */
const copiedText = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __relayCopied: () => string }).__relayCopied());
const menuItem = (page: Page, name: string) => page.locator(".ctx-menu").getByRole("menuitem", { name });
const secondStart = (app: ElectronApplication, ...args: string[]) => app.evaluate(({ app }, args) => app.emit("second-instance", {}, ["AMO Relay.exe", ...args], "", {}), args);

test("复制引用 of a 协作, a message, a 子会话 and a 中转会话; refs in a chat as chips; 在 Studio 里打开 only for my AIs; --open=cowork: and thread:", async () => {
  test.setTimeout(240_000);
  store.register("程序老李", "pw-1234", "程序 · 战斗");
  store.register("策划小王", "pw-1234", "策划");
  store.register("美术小周", "pw-1234", "美术");
  const DEVICE = "d_abcdef0123456789abcdef01";
  const studioData = join(root, "li-studio-data");
  mkdirSync(studioData, { recursive: true });
  const opened: string[] = [];
  fakeHost = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, pid: 1, running: 0, version: "dev" }));
      if (req.url === "/api/ui/open" && req.method === "POST") return (opened.push((JSON.parse(body) as { sessionId: string }).sessionId), res.end(JSON.stringify({ ok: true })));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const hostPort = await listenInStudioRange(fakeHost);
  writeFileSync(join(studioData, "host.json"), JSON.stringify({ url: `http://127.0.0.1:${hostPort}`, port: hostPort, pid: 1 }));
  writeFileSync(join(studioData, "host-token"), "tok-e2e");
  mkdirSync(join(root, "LAOLI-PC", "amo-home"), { recursive: true });
  writeFileSync(join(root, "LAOLI-PC", "amo-home", "device.json"), JSON.stringify({ id: DEVICE, name: "LAOLI-PC" }));

  // What they have, made the way their Studios and clients make it.
  const li = new relay.RelayClient(server.url, store.login("程序老李", "pw-1234").key);
  const wang = new relay.RelayClient(server.url, store.login("策划小王", "pw-1234").key);
  const zhou = new relay.RelayClient(server.url, store.login("美术小周", "pw-1234").key);
  const cw = await li.createCowork({ title: "加特林射速调整", goal: "射速四段", members: ["策划小王"] });
  const liAi = `studio:${DEVICE}:s-9`;
  const liOld = "studio:d_oldpc0123:s-2";
  const wangAi = "studio:d_wangpc012:s-1";
  await li.joinCoworkAgent(cw.id, liAi, "FireTimer");
  await li.joinCoworkAgent(cw.id, liOld, "旧电脑上的会话");
  await wang.joinCoworkAgent(cw.id, wangAi, "射速曲线");
  await li.reportCoworkAgents([{ mark: liAi, state: "idle" }, { mark: liOld, state: "idle" }]);
  await wang.reportCoworkAgents([{ mark: wangAi, state: "idle" }]);
  const sub = (await wang.askCowork(cw.id, { to: "程序老李", title: "过热从第几秒开始", body: "满速几秒后过热？" })).thread!;
  const mineSaid = await li.postCowork(cw.id, { kind: "text", body: "FireTimer 起转段加好了", via: { kind: "ai", client: "AMO Studio", conv: liAi } });
  const wangSaid = await wang.postCowork(cw.id, { kind: "text", body: "曲线按 0.8 秒配", via: { kind: "ai", client: "AMO Studio", conv: wangAi } });
  const req = (await wang.ask({ to: "程序老李", title: "登录页改版", body: "看一下新的登录页" })).thread;
  const hidden = await zhou.createCowork({ title: "美术资源整理", members: ["策划小王"] });

  const A = await start("程序老李", "LAOLI-PC", { env: { AMO_STUDIO_DATA_DIR: studioData } });
  const B = await start("策划小王", "WANG-PC");
  await size(A.app, 1280, 800);
  await theme(A.page, "light");
  const a = A.page;

  // ---- 协作: 复制引用 by the title
  await a.locator(".rail-item", { hasText: "协作" }).click();
  await a.locator(".cowork-row", { hasText: "加特林射速调整" }).click();
  await expect(a.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");
  await a.locator(".cowork-view .head-copy").click();
  expect(await copiedText(A.app)).toBe(`协作「加特林射速调整」 cowork:${cw.id}`);
  await expect(a.locator(".toast")).toContainText("已复制协作「加特林射速调整」的引用");

  // ---- 在 Studio 里打开 in the member list: my AI here has it, my AI elsewhere says so, 小王's has neither.
  const mineRow = a.locator(`.cw-person.agent[data-agent="${liAi}"]`);
  await expect(mineRow.getByRole("button", { name: "在 Studio 里打开" })).toBeVisible();
  await expect(a.locator(`.cw-person.agent[data-agent="${liOld}"]`)).toContainText("在另一台电脑上");
  await expect(a.locator(`.cw-person.agent[data-agent="${liOld}"]`).getByRole("button", { name: "在 Studio 里打开" })).toHaveCount(0);
  await expect(a.locator(`.cw-person.agent[data-agent="${wangAi}"]`).getByRole("button")).toHaveCount(0);
  await expect(a.locator(`.cw-person.agent[data-agent="${wangAi}"]`)).not.toContainText("另一台电脑");
  await shot(A.app, "R01-cowork-copy-ref");
  await mineRow.getByRole("button", { name: "在 Studio 里打开" }).click();
  await expect.poll(() => opened).toEqual(["s-9"]);
  await expect(a.locator(".toast")).toHaveText("已在 Studio 里打开这个会话");

  // ---- a message: my AI's name opens the menu (在 Studio 里打开 + 复制引用); 小王's AI: only 复制引用 on a right click.
  const myMsg = a.locator(`.msg[data-seq="${mineSaid.message!.seq}"]`);
  await myMsg.locator(".msg-name").click();
  await expect(menuItem(a, "在 Studio 里打开")).toBeVisible();
  await expect(menuItem(a, "复制引用")).toBeVisible();
  await shot(A.app, "R02-ai-name-menu");
  await theme(a, "dark");
  await shot(A.app, "R02-ai-name-menu-dark");
  await theme(a, "light");
  await menuItem(a, "在 Studio 里打开").click();
  await expect.poll(() => opened).toEqual(["s-9", "s-9"]);
  const theirMsg = a.locator(`.msg[data-seq="${wangSaid.message!.seq}"]`);
  await expect(theirMsg.locator(".msg-name")).toHaveCount(0);
  await theirMsg.click({ button: "right" });
  await expect(menuItem(a, "在 Studio 里打开")).toHaveCount(0);
  await menuItem(a, "复制引用").click();
  expect(await copiedText(A.app)).toBe(`#${wangSaid.message!.seq}（协作「加特林射速调整」 cowork:${cw.id}）`);
  await expect(a.locator(".toast")).toContainText(`已复制这条消息（#${wangSaid.message!.seq}）的引用`);

  // ---- the line over the box: my AI @-ed is a button to its session.
  const box = a.locator(".cowork-view .cw-composer textarea");
  await box.fill("@程序老李 的 AI · FireTimer 看一下回落");
  await expect(a.locator(`.cw-route-ai[data-agent="${liAi}"]`)).toBeVisible();
  await box.fill("@程序老李 的 AI · FireTimer @策划小王 的 AI · 射速曲线 看一下回落");
  await expect(a.locator(`.cw-route span[data-agent="${wangAi}"]`)).toBeVisible();
  await expect(a.locator(`.cw-route-ai[data-agent="${wangAi}"]`)).toHaveCount(0);
  await shot(A.app, "R03-route-to-studio");
  await a.locator(`.cw-route-ai[data-agent="${liAi}"]`).click();
  await expect.poll(() => opened).toEqual(["s-9", "s-9", "s-9"]);
  await box.fill("");

  // ---- a 子会话: its card's right click, and its window's button.
  const subWant = `子会话「过热从第几秒开始」 thread:${sub.id}（协作 cowork:${cw.id}）`;
  await a.locator(`.cw-subcard[data-session="${sub.id}"]`).click({ button: "right" });
  await menuItem(a, "复制引用").click();
  expect(await copiedText(A.app)).toBe(subWant);
  await a.locator(`.cw-subcard[data-session="${sub.id}"]`).click();
  const subWin = a.locator('.float-win[aria-label^="子会话：过热从第几秒开始"]');
  await expect(subWin).toBeVisible();
  await subWin.getByRole("button", { name: "复制引用" }).click();
  expect(await copiedText(A.app)).toBe(subWant);
  await expect(a.locator(".toast")).toContainText("已复制子会话「过热从第几秒开始」的引用");

  // ---- a 中转会话: its row's right click, its page's button.
  const reqWant = `中转会话「登录页改版」 thread:${req.id}`;
  await a.locator(".rail-item", { hasText: "待处理" }).click();
  await a.locator(".srow", { hasText: "登录页改版" }).click({ button: "right" });
  await menuItem(a, "复制引用").click();
  expect(await copiedText(A.app)).toBe(reqWant);
  await a.locator(".srow", { hasText: "登录页改版" }).click();
  await expect(a.locator(".page-head .head-title")).toHaveText("登录页改版");
  await a.locator(".page-head").getByRole("button", { name: "复制引用" }).click();
  expect(await copiedText(A.app)).toBe(reqWant);
  await expect(a.locator(".toast")).toContainText("已复制中转会话「登录页改版」的引用");

  // ---- refs in a chat: 小王 pastes them to 老李.
  const dm = await wang.direct("程序老李");
  const body = [
    `看 协作「加特林射速调整」 cowork:${cw.id} 里的结论`,
    `还有 子会话「过热从第几秒开始」 thread:${sub.id}（协作 cowork:${cw.id}）`,
    `和 ${reqWant}`,
    `老李那边的 Studio 会话「FireTimer」 studio:${DEVICE}:s-9（任务 k_12），我这边的 Studio 会话「射速曲线」 ${wangAi}`,
    `另一个 协作「美术资源整理」 cowork:${hidden.id}，代码里的 \`cowork:${cw.id}\` 不算`,
  ].join("\n\n");
  await wang.send(dm.id, { kind: "text", body });
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  await a.locator(".chat-row", { hasText: "策划小王" }).click();
  const said = a.locator(".msg", { hasText: "里的结论" });
  await expect(said.locator(`button.ref-chip[data-ref="cowork:${cw.id}"]`)).toHaveCount(2);
  await expect(said.locator(`button.ref-chip[data-ref="cowork:${cw.id}"]`).first()).toHaveText("协作「加特林射速调整」");
  await expect(said.locator(`button.ref-chip[data-ref="thread:${sub.id}"]`)).toHaveText("子会话「过热从第几秒开始」");
  await expect(said.locator(`button.ref-chip[data-ref="thread:${req.id}"]`)).toHaveText("中转会话「登录页改版」");
  await expect(said.locator(`.ref-chip.off[data-ref="cowork:${hidden.id}"]`)).toHaveText("看不到的协作");
  await expect(said.locator(`.ref-chip.off[data-ref="cowork:${hidden.id}"]`)).toHaveAttribute("title", "你不在这个协作里，或者它已经不在了");
  await expect(said.locator(`button.ref-chip[data-ref="studio:${DEVICE}:s-9"]`)).toHaveText("Studio 会话「FireTimer」");
  await expect(said.locator(`.ref-chip.off[data-ref="${wangAi}"]`)).toHaveAttribute("title", "在另一台电脑上");
  // (the one in code stays code)
  await expect(said.locator("code", { hasText: `cowork:${cw.id}` })).toBeVisible();
  // the copied words are not shown twice
  await expect(said).not.toContainText("协作「加特林射速调整」 协作「");
  await shot(A.app, "R04-chat-chips");
  await theme(a, "dark");
  await shot(A.app, "R05-chat-chips-dark");
  await theme(a, "light");
  // On 小王's computer the same Studio chip is another computer's.
  await B.page.locator(".rail-item", { hasText: "聊天" }).click();
  await B.page.locator(".chat-row", { hasText: "程序老李" }).click();
  await expect(B.page.locator(`.ref-chip.off[data-ref="studio:${DEVICE}:s-9"]`)).toHaveAttribute("title", "在另一台电脑上");

  await said.locator(`button.ref-chip[data-ref="studio:${DEVICE}:s-9"]`).click();
  await expect.poll(() => opened).toEqual(["s-9", "s-9", "s-9", "s-9"]);
  await said.locator(`button.ref-chip[data-ref="thread:${req.id}"]`).click();
  await expect(a.locator(".page-head .head-title")).toHaveText("登录页改版");
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  await a.locator(".chat-row", { hasText: "策划小王" }).click();
  await said.locator(`button.ref-chip[data-ref="thread:${sub.id}"]`).click();
  await expect(a.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");
  await expect(subWin).toBeVisible();
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  await a.locator(".chat-row", { hasText: "策划小王" }).click();
  await said.locator(`button.ref-chip[data-ref="cowork:${cw.id}"]`).first().click();
  await expect(a.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");

  // ---- from Studio: a second start with --open=cowork:<id> / thread:<id>.
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  await secondStart(A.app, `--open=cowork:${cw.id}`);
  await expect(a.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");
  await secondStart(A.app, `--open=cowork:${hidden.id}`);
  await expect(a.locator(".toast")).toContainText("打不开这个协作：你不在里面，或者它已经不在了");
  await shot(A.app, "R06-open-not-in");
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  await secondStart(A.app, `--open=thread:${sub.id}`);
  await expect(a.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");
  await expect(subWin).toBeVisible();
  await secondStart(A.app, "--open-thread", req.id);
  await expect(a.locator(".page-head .head-title")).toHaveText("登录页改版");

  // running.json: where Studio finds the client and that it takes --open.
  const running = JSON.parse(readFileSync(join(A.home, "running.json"), "utf8")) as Record<string, unknown>;
  expect(running).toMatchObject({ pid: expect.any(Number), exe: expect.any(String), version: expect.any(String), open: ["cowork", "thread"] });

  // Another copy (Studio found it in programs.json; the one open was unpacked by hand) started to open something: the
  // one open opens it and stays — without --open, another copy still takes over (the platform's update).
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  await A.app.evaluate(({ app }, args) => app.emit("second-instance", {}, ["D:/elsewhere/AMO 中转.exe", ...args], "", { exe: "D:/elsewhere/AMO 中转.exe" }), [`--open=cowork:${cw.id}`]);
  await expect(a.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");
  expect(await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  // A real second start, as Studio makes it (only --open=…): it hands it to the one open and is gone at once, not after
  // waiting for the lock.
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  const launched = programLaunch("relay-app", join(studio, "packages", "relay-app", "dist", "main.js"));
  const started = Date.now();
  const second = spawn(launched.executablePath, [...launched.args, `--open=thread:${req.id}`], { env: { ...process.env, AMO_RELAY_HOME: A.home, AMO_HOME: join(A.home, "amo-home"), AMO_STUDIO_HOME: join(A.home, "studio-home"), AMO_RELAY_TEST: "1" }, stdio: "ignore" });
  await new Promise<void>((done) => second.on("exit", () => done()));
  expect(Date.now() - started).toBeLessThan(6000);
  await expect(a.locator(".page-head .head-title")).toHaveText("登录页改版");
  // The same with the older --open-thread <id> (an older Studio's 在中转里打开): Chromium's argv puts the id after its
  // own switches, so the running one reads the start's own arguments (lock data) — before, it never found the thread.
  const knock = async (...args: string[]) => {
    const t = Date.now();
    const p = spawn(launched.executablePath, [...launched.args, ...args], { env: { ...process.env, AMO_RELAY_HOME: A.home, AMO_HOME: join(A.home, "amo-home"), AMO_STUDIO_HOME: join(A.home, "studio-home"), AMO_RELAY_TEST: "1" }, stdio: "ignore" });
    await new Promise<void>((done) => p.on("exit", () => done()));
    return Date.now() - t;
  };
  await a.locator(".rail-item", { hasText: "聊天" }).click();
  expect(await knock("--open-thread", sub.id)).toBeLessThan(6000);
  await expect(subWin).toBeVisible();
  await expect(a.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");
  // 「× 关不上又弹出来」 (2026-11-23): another start of the same program with nothing to open (the platform's 打开中转, a
  // shortcut) knocks once and goes — it used to try the lock every 500 ms for 8 s, each try bringing the window up again.
  await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  expect(await knock("--server", server.url)).toBeLessThan(6000);
  await new Promise((r) => setTimeout(r, 1500));
  const log = readFileSync(join(A.home, "window.log"), "utf8");
  expect(log).toContain("hidden (×)");
  expect(log.match(/handed on, quits — the running one \(pid \d+\) is this program/g)?.length).toBeGreaterThanOrEqual(3);
  expect(log).not.toContain("waits for the lock");
  expect(log).toMatch(/show: second start \[[^\n]*"--server","http:/);

  // ---- started with --open=cowork: before signing in: it says so, and opens it once signed in.
  const Z = await start("美术小周", "ZHOU-PC", { args: [`--open=cowork:${hidden.id}`], signIn: false });
  await expect(Z.page.locator(".open-waiting")).toHaveText("AMO Studio 让中转打开一个协作：登录后就打开它");
  await theme(Z.page, "light");
  await shot(Z.app, "R07-open-waiting-login");
  await signIn(Z.page, "美术小周");
  await expect(Z.page.locator(".cowork-view .head-title")).toHaveText("美术资源整理");
  await expect(Z.page.locator(".open-waiting")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
