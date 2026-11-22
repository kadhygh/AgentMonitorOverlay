import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { programLaunch } from "../support/packed.js";

// Layout A「IM 三栏」(2026-11-23, plans/cowork.md 第 8 条; prototype studio/out/relay-redesign/a-im.html): one client with
// a workspace seeded through the service — an AI's session waiting on me with a file, one I sent, a plain chat, a topic,
// a group — looked at page by page at 1280, 1080 (the default window) and 960 px, light and dark, against the prototype:
// the rail, the list, the main area, the 信息栏 (folded up to 1100 px, over the main area under 1024 px), the 协作 place
// kept for step 3. Needs `npm run relay:release` first (release/relay/client).

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const built = join(process.env.AMO_RELAY_E2E_RELEASE ?? join(studio, "release", "relay"), "client");
const shots = join(studio, "screenshots", "relay");
const relay = (await import(pathToFileURL(join(studio, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");

let root: string;
let store: InstanceType<typeof relay.RelayStore>;
let server: Awaited<ReturnType<typeof relay.startRelayServer>>;
const apps: ElectronApplication[] = [];
const pageErrors: string[] = [];

test.beforeAll(async () => {
  test.skip(!existsSync(join(built, "manifest.json")), "run npm run relay:release first");
  root = mkdtempSync(join(tmpdir(), "relay-e2e-layout-"));
  cpSync(built, join(root, "public", "client"), { recursive: true });
  store = new relay.RelayStore(join(root, "server", "relay.db"));
  server = await relay.startRelayServer({ store, publicDir: join(root, "public"), filesDir: join(root, "files"), transfersDir: join(root, "transfers"), host: "127.0.0.1", port: 0, name: "战斗组", clientWatchMs: 300, transferFreeBytes: async () => 100 * 1024 ** 3 });
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await server?.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function shot(app: ElectronApplication, name: string): Promise<void> {
  // A hidden test window paints late: what was just changed (the theme, a panel) has to be on screen first.
  await new Promise((r) => setTimeout(r, 300));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}

const size = (app: ElectronApplication, w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [w, h]);
const theme = (page: Page, t: "light" | "dark") => page.evaluate((t) => (document.documentElement.dataset.theme = t), t);
/** Nothing sticks out of its box sideways in the frame's columns (a long name, a row of buttons). */
async function noSideOverflow(page: Page): Promise<void> {
  const over = await page.evaluate(() =>
    [...document.querySelectorAll(".rail, .list-pane, .list-row, .page-head, .side-panel, .dock")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.className}: ${e.scrollWidth} > ${e.clientWidth}`),
  );
  expect(over).toEqual([]);
}

test("layout A: rail, list, main, 信息栏 — every page at 1280, 1080 and 960 px, light and dark", async () => {
  test.setTimeout(120_000);
  const planner = new relay.RelayClient(server.url, store.register("策划小王", "pw-1234", "策划").key);
  const zhou = new relay.RelayClient(server.url, store.register("美术小周", "pw-1234", "美术").key);
  store.register("测试小赵", "pw-1234", "测试");

  const home = join(root, "coder");
  const launched = programLaunch("relay-app", join(studio, "packages", "relay-app", "dist", "main.js"));
  const app = await _electron.launch({ executablePath: launched.executablePath, args: [...launched.args, "--server", server.url], env: { ...process.env, AMO_RELAY_HOME: home, AMO_HOME: join(home, "amo-home"), AMO_STUDIO_HOME: join(home, "studio-home"), AMO_RELAY_TEST: "1", COMPUTERNAME: "LAOLI-PC" } });
  apps.push(app);
  const page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
  await expect(page.getByRole("button", { name: "没有账号？注册一个" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "没有账号？注册一个" }).click();
  await page.getByLabel("名字").fill("程序老李");
  await page.getByLabel("密码", { exact: true }).fill("pw-1234");
  await page.getByLabel("再输一次密码").fill("pw-1234");
  await page.getByLabel(/负责什么/).fill("程序 · 战斗");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.locator(".rail")).toBeVisible();
  const coder = new relay.RelayClient(server.url, store.login("程序老李", "pw-1234").key);

  // What there is: the planner's AI asks with a file; the planner asks too; I asked the planner; chats of each kind.
  const via = { kind: "ai", client: "AMO Studio", conv: "studio:d_1:s-1" } as const;
  const gat = (await planner.ask({ to: "程序老李", title: "加特林射速曲线怎么配", body: "打算把射速做成「起转—满速—过热—回落」四段，**满速 6 秒后过热**。\n\n| 段 | 时长 | 射速 |\n|---|---|---|\n| 起转 | 0.8s | 6→20 |\n| 满速 | 6s | 20 |", questions: [{ text: "FireTimer 能加起转段吗", options: ["能", "要改结构"] }, { text: "过热回落多久合适" }], via })).thread;
  await planner.upload({ threadId: gat.id }, "加特林射速.md", new TextEncoder().encode("# 加特林\n\n起转 0.8 秒，满速每秒 20 发。"), "text/markdown", { ai: true });
  await planner.ask({ to: "程序老李", title: "背包格子上限放哪", body: "运营会调，放配置表还是常量？", questions: [{ text: "放哪", options: ["配置表", "常量"] }] });
  await coder.ask({ to: "策划小王", title: "掉落表要不要分服", body: "想分服配，可以吗？" });
  const direct = await planner.direct("程序老李");
  await planner.send(direct.id, { kind: "text", body: "下午三点对一下数值？" });
  await coder.send(direct.id, { kind: "text", body: "可以，我把加特林那份带上" });
  const topic = await planner.topic("程序老李", "数值平衡");
  await planner.send(topic.id, { kind: "text", body: "暴击率上限定多少？" });
  const g = await zhou.direct("程序老李");
  await zhou.send(g.id, { kind: "text", body: "枪管变红从第 3 秒开始，你看节奏对不对？" });
  await zhou.addMembers(g.id, ["策划小王"]);
  await planner.send(g.id, { kind: "text", body: "@程序老李 过热时枪管颜色读的是哪个字段？", mentions: ["程序老李"] });
  // A 协作 (the service's step 1) with a 子会话 to me: neither its 群聊 nor the 子会话 belongs in 待处理 or 聊天 (step 3's page).
  const cw = await planner.createCowork({ title: "射速改版", goal: "射速 10 → 12", members: ["程序老李"] });
  await planner.send(cw.id, { kind: "text", body: "协作群里的话" });
  await planner.askCowork(cw.id, { to: "程序老李", title: "协作里的子会话", body: "子会话问题" });

  await theme(page, "light");
  await size(app, 1280, 800);
  // 待处理: the AI's session, its 信息栏 open on a wide window.
  await page.locator(".list-body .srow", { hasText: "加特林射速曲线怎么配" }).click();
  await expect(page.locator(".info-panel .fs-open")).toContainText("加特林射速.md");
  await expect(page.locator(".rail-item", { hasText: "待处理" }).locator(".badge")).toHaveText("2");
  await expect(page.locator(".list-body")).not.toContainText("协作里的子会话");
  await noSideOverflow(page);
  await shot(app, "A01-queue-1280");
  await theme(page, "dark");
  await shot(app, "A02-queue-1280-dark");
  await theme(page, "light");

  // 聊天: the group first, then each person with their topics.
  await page.locator(".rail-item", { hasText: "聊天" }).click();
  await expect(page.locator(".list-sec").first()).toHaveText("群聊 · 1");
  await expect(page.locator(".list-body")).not.toContainText("射速改版");
  await page.locator(".list-body .chat-row.group").click();
  await expect(page.locator(".page-crumb")).toHaveText("群聊");
  await noSideOverflow(page);
  await shot(app, "A03-chat-group-1280");
  await page.locator('.person-node[data-person="策划小王"] .chat-row.kid', { hasText: "数值平衡" }).click();
  await expect(page.locator(".head-title")).toHaveText("数值平衡");
  await theme(page, "dark");
  await shot(app, "A04-chat-topic-1280-dark");
  await theme(page, "light");
  // The search narrows the list.
  await page.getByPlaceholder("搜索人、群、话题").fill("美术");
  await expect(page.locator(".list-body .list-row")).toHaveCount(2);
  await page.getByPlaceholder("搜索人、群、话题").fill("");

  // 传文件, 成员, 协作.
  await page.locator(".rail-item", { hasText: "传文件" }).click();
  await expect(page.locator(".list-pane")).toContainText("这台电脑：LAOLI-PC");
  await shot(app, "A05-transfers-1280");
  await page.locator(".rail-item", { hasText: "成员" }).click();
  await page.locator(".person-row", { hasText: "美术小周" }).click();
  await expect(page.locator(".group-box")).toContainText("3 人");
  await expect(page.getByRole("button", { name: "发文件" })).toBeVisible();
  await noSideOverflow(page);
  await shot(app, "A06-members-1280");
  await page.locator(".rail-item", { hasText: "协作" }).click();
  await expect(page.locator(".list-pane")).toContainText("协作还在做");
  await shot(app, "A07-cowork-1280");

  // The default window (1080): the 信息栏 folded, its button counts the files; opened, it sits beside the session.
  await size(app, 1080, 720);
  await page.locator(".rail-item", { hasText: "待处理" }).click();
  await page.locator(".list-body .srow", { hasText: "加特林射速曲线怎么配" }).click();
  await expect(page.locator(".info-panel")).toHaveCount(0);
  await noSideOverflow(page);
  await shot(app, "A08-queue-1080");
  await page.getByRole("button", { name: "信息栏 · 文件 1" }).click();
  await expect(page.locator(".info-panel")).toBeVisible();
  await shot(app, "A09-queue-1080-info");

  // 960: the slim list; the 信息栏 opened lies over the main area.
  await size(app, 960, 720);
  await page.locator(".list-body .srow", { hasText: "背包格子上限放哪" }).click();
  await expect(page.locator(".info-panel")).toHaveCount(0);
  await noSideOverflow(page);
  await shot(app, "A10-queue-960");
  await page.getByRole("button", { name: /^信息栏/ }).click();
  await shot(app, "A11-queue-960-info");
  await page.locator(".info-panel").getByRole("button", { name: "收起信息栏" }).click();
  await expect(page.locator(".info-panel")).toHaveCount(0);
  await page.locator(".rail-item", { hasText: "聊天" }).click();
  await page.locator('.person-node[data-person="策划小王"] > .chat-row:not(.kid)').click();
  await theme(page, "dark");
  await noSideOverflow(page);
  await shot(app, "A12-chat-960-dark");
  await page.locator(".rail-item", { hasText: "成员" }).click();
  await shot(app, "A13-members-960-dark");
  expect(pageErrors).toEqual([]);
});
