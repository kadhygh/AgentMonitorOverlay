import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { listenInStudioRange } from "@amo-studio/testkit";
import { programLaunch } from "../support/packed.js";

// 协作 step 3 (2026-11-23, plans/cowork.md; prototype studio/out/relay-redesign/a-im.html): two people in two desktop
// clients against a real service in this process — 程序老李 and 策划小王 — and their AIs played by RelayClient the way
// their Studios will (拉进协作, state reports, the inbox, ack, replies). 老李 starts a 协作 and @-s 小王's AI: the @ list
// shows its state and what an @ does, the line over the box says where it goes, the message's 回执 goes 排队 → 送到 →
// 处理了 and the reply quotes it. Typing keeps the list still with 「有 N 条新消息」. 老李's own AI's @ goes out at once (no
// drafts since 2026-11-24). A 事项 (2026-11-25, was 子会话) opens as a window (several at once, folded into tabs): 等你确认 in
// its parts, answered, closed with a conclusion into 已定的事. 回执 under my own messages only, 改 / 撤回 before anyone saw it,
// 发新的取代它 after. 要你看: a 闸门, a 事项 waiting on me, an @ (知会). The 板 computed from the 事项: a frame per side and
// 已定 / 已验, my cards outlined, the filter, dependencies, a dragged 事项 kept, the drawer, the arrow to one off screen; its
// own cards as before (who is looking, the soft lock 「在写」, selections, a move seen by the other, an AI's card marked
// 「AI 刚改」, a conflict picked, a delete brought back, undo only of one's own). Roles: my AI as 执行, 「在我的 Studio 里开这一方的
// 主控」 and 「让主控现在看一遍」 reaching the Studio. Then the AIs' run of 30 messages paused. Light, dark and 960 px. Needs
// `npm run relay:release` first (release/relay/client).

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
  root = mkdtempSync(join(tmpdir(), "relay-e2e-cowork-"));
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

async function launch(who: string, pc: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const home = join(root, pc);
  const launched = programLaunch("relay-app", join(studio, "packages", "relay-app", "dist", "main.js"));
  const app = await _electron.launch({ executablePath: launched.executablePath, args: [...launched.args, "--server", server.url], env: { ...process.env, AMO_RELAY_HOME: home, AMO_HOME: join(home, "amo-home"), AMO_STUDIO_HOME: join(home, "studio-home"), AMO_RELAY_TEST: "1", COMPUTERNAME: pc, ...extraEnv } });
  apps.push(app);
  const page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.stack ?? e.message}`));
  await expect(page.getByRole("button", { name: "没有账号？注册一个" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("名字").fill(who);
  await page.getByLabel("密码", { exact: true }).fill("pw-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".rail")).toBeVisible();
  return { app, page };
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  // A hidden test window paints late: what was just changed (the theme, a panel) has to be on screen first.
  await new Promise((r) => setTimeout(r, 300));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}

const size = (app: ElectronApplication, w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [w, h]);
const theme = (page: Page, t: "light" | "dark") => page.evaluate((t) => (document.documentElement.dataset.theme = t), t);
/** Nothing sticks out of its box sideways (a long name, a row of buttons). */
async function noSideOverflow(page: Page): Promise<void> {
  const over = await page.evaluate(() =>
    [...document.querySelectorAll(".rail, .list-pane, .list-row, .page-head, .side-panel, .cw-dock, .cw-sub-head, .cw-openline, .bd-bar, .bd-selbar, .bd-drawer-head, .cw-lookpanel")]
      .filter((e) => (e as HTMLElement).offsetParent && e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.className}: ${e.scrollWidth} > ${e.clientWidth}`),
  );
  expect(over).toEqual([]);
}
const win = (page: Page, title: string) => page.locator(`.float-win[aria-label^="${title}"]`);
/** A 事项's window: 「事项 N：标题」. */
const mwin = (page: Page, title: string) => page.locator(`.float-win[aria-label^="事项 "][aria-label$="：${title}"]`);
const card = (page: Page, text: string) => page.locator(".bd-card", { hasText: text });
const leftOf = (l: Locator) => l.evaluate((e) => parseFloat((e as HTMLElement).style.left));
async function drag(page: Page, l: Locator, dx: number, dy: number): Promise<void> {
  const b = (await l.boundingBox())!;
  await page.mouse.move(b.x + 20, b.y + 12);
  await page.mouse.down();
  await page.mouse.move(b.x + 20 + dx / 2, b.y + 12 + dy / 2, { steps: 4 });
  await page.mouse.move(b.x + 20 + dx, b.y + 12 + dy, { steps: 4 });
  await page.mouse.up();
}

test("协作: @ another's AI from queue to reply, an AI's @ at once, 事项 windows, 回执, 要你看, the 板 from the 事项, roles", async () => {
  test.setTimeout(420_000);
  store.register("程序老李", "pw-1234", "程序 · 战斗");
  store.register("策划小王", "pw-1234", "策划");
  store.register("美术小周", "pw-1234", "美术");
  // 老李's computer has a Studio (as far as his client can tell: host.json and host-token in a data dir, /api/health and
  // /api/ui/open answered here — never the person's own Studio); 小王's has none.
  const DEVICE = "d_abcdef0123456789abcdef01";
  const studioData = join(root, "li-studio-data");
  mkdirSync(studioData, { recursive: true });
  const opened: string[] = [];
  fakeHost = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, pid: 1, running: 0, version: "dev" }));
      if (req.url === "/api/ui/open" && req.method === "POST") return (opened.push(body), res.end(JSON.stringify({ ok: true })));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const hostPort = await listenInStudioRange(fakeHost);
  writeFileSync(join(studioData, "host.json"), JSON.stringify({ url: `http://127.0.0.1:${hostPort}`, port: hostPort, pid: 1 }));
  writeFileSync(join(studioData, "host-token"), "tok-e2e");
  mkdirSync(join(root, "LAOLI-PC", "amo-home"), { recursive: true });
  writeFileSync(join(root, "LAOLI-PC", "amo-home", "device.json"), JSON.stringify({ id: DEVICE, name: "LAOLI-PC" }));
  const li = await launch("程序老李", "LAOLI-PC", { AMO_STUDIO_DATA_DIR: studioData });
  const wang = await launch("策划小王", "WANG-PC");
  const A = li.page;
  const B = wang.page;
  await size(li.app, 1280, 800);
  await size(wang.app, 1280, 800);
  await theme(A, "light");
  await theme(B, "light");
  // Their Studios, as RelayClient: each person's account, its agents marked studio:<设备号>:<会话>.
  const liStudio = new relay.RelayClient(server.url, store.login("程序老李", "pw-1234").key);
  const wangStudio = new relay.RelayClient(server.url, store.login("策划小王", "pw-1234").key);
  const wangAi = "studio:d_wang:s-1";
  const liAi = "studio:d_li:s-9";
  const viaWang = { kind: "ai", client: "AMO Studio", conv: wangAi } as const;
  const viaLi = { kind: "ai", client: "AMO Studio", conv: liAi } as const;

  // ---- 发起协作
  await A.locator(".rail-item", { hasText: "协作" }).click();
  await expect(A.locator(".main-col")).toContainText("几个人带着各自的 AI 一起推进一件事");
  await A.getByRole("button", { name: "＋ 发起协作" }).click();
  await A.getByPlaceholder("比如：加特林射速调整").fill("加特林射速调整");
  await A.getByPlaceholder("要做成什么样，定了的写进哪份文档").fill("射速做成「起转—满速—过热—回落」四段，**满速 6 秒后过热**。定了的写进 `设计/加特林.md`。");
  await A.getByPlaceholder("game-client").fill("game-client");
  await A.getByPlaceholder("feature/gatling-rate").fill("feature/gatling-rate");
  await A.locator(".cw-pick", { hasText: "策划小王" }).click();
  await shot(li.app, "C01-cowork-new");
  await A.getByRole("button", { name: "发起", exact: true }).click();
  await expect(A.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");
  const cw = (await liStudio.coworks())[0]!;
  // 小王 sees it come in, with the unread mark on the rail.
  await expect(B.locator(".rail-item", { hasText: "协作" }).locator(".badge")).toHaveText("1");
  await B.locator(".rail-item", { hasText: "协作" }).click();
  await expect(B.locator(".cowork-row", { hasText: "加特林射速调整" })).toBeVisible();
  await expect(B.locator(".cowork-view .head-title")).toHaveText("加特林射速调整");

  // Each brings in an AI (Studio's 拉进协作) and says how it is.
  await wangStudio.joinCoworkAgent(cw.id, wangAi, "射速曲线");
  await liStudio.joinCoworkAgent(cw.id, liAi, "FireTimer");
  await wangStudio.reportCoworkAgents([{ mark: wangAi, state: "busy" }]);
  await liStudio.reportCoworkAgents([{ mark: liAi, state: "idle" }]);
  await expect(A.locator(`.cw-person.agent[data-agent="${wangAi}"] .cw-chip`)).toHaveText("◐ 处理中");
  await expect(A.locator(`.cw-person.agent[data-agent="${liAi}"] .cw-chip`)).toHaveText("✓ 待命");
  await expect(A.locator(".cw-legend")).toContainText("主人的 Studio 没开，连上后送");

  // ---- @ 小王's AI: the list, the line over the box, the trail, the reply.
  const box = A.locator(".cowork-view .cw-composer textarea");
  await box.click();
  await box.pressSequentially("@");
  await expect(A.locator(".cw-atlist")).toBeVisible();
  await expect(A.locator(".cw-atlist .cw-at")).toHaveCount(3);
  await expect(A.locator(`.cw-at[data-agent="${wangAi}"]`)).toContainText("这一轮跑完再送");
  await expect(A.locator(`.cw-at[data-agent="${wangAi}"] .cw-chip`)).toHaveText("◐ 处理中");
  await expect(A.locator(`.cw-at[data-agent="${liAi}"]`)).toContainText("马上送进它的会话，开一轮");
  await noSideOverflow(A);
  await shot(li.app, "C02-at-list");
  await A.locator(`.cw-at[data-agent="${wangAi}"]`).hover();
  await A.locator(`.cw-at[data-agent="${wangAi}"]`).dispatchEvent("mousedown");
  await expect(box).toHaveValue("@策划小王 的 AI · 射速曲线 ");
  await box.pressSequentially("FireTimer 的起转段我加好了，曲线按 0.8 秒配可以吗？");
  await expect(A.locator(".cw-route")).toContainText("策划小王 的 AI · 射速曲线 正在处理，你这句会在它这一轮之后送到");
  await shot(li.app, "C03-route");
  await box.press("Control+Enter");
  await expect(box).toHaveValue("");
  const mine = A.locator(".msg.mine", { hasText: "FireTimer 的起转段我加好了" });
  // Its 回执 (2026-11-25, in place of the trail): one line, each recipient on hover — 小王's AI 排队 → 送到 → 处理了 (its reply).
  const toWangAi = mine.locator(".cw-rc-row", { hasText: "策划小王的主控" });
  await expect(mine.locator(".cw-rc-sum")).toContainText("排队");
  await expect(toWangAi).toHaveClass(/st-queued/);
  // 小王's Studio takes it (its session's turn is over), then the AI answers it.
  const inbox = await wangStudio.coworkInbox("studio:d_wang:");
  expect(inbox.items.map((i) => i.message.body)).toEqual([expect.stringContaining("FireTimer 的起转段我加好了")]);
  await wangStudio.ackCowork(inbox.items.map((i) => i.delivery.id));
  await expect(toWangAi).toHaveClass(/st-delivered/);
  await wangStudio.reportCoworkAgents([{ mark: wangAi, state: "busy" }]);
  await wangStudio.postCowork(cw.id, { kind: "text", body: "可以，起转 0.8 秒；满速段我按每秒 20 发配，过热从第 6 秒开始。", replyTo: inbox.items[0]!.message.seq, via: viaWang });
  await expect(toWangAi).toHaveClass(/st-handled/);
  await expect(mine.locator(".cw-rc-sum")).toContainText("处理了");
  const reply = A.locator(".msg.by-ai", { hasText: "起转 0.8 秒" });
  await expect(reply.locator(".cw-reply-to")).toHaveText("↳ 回 程序老李");
  await expect(reply.locator(".msg-quote")).toContainText("FireTimer 的起转段我加好了");
  await expect(reply.locator(".tag.agent-label")).toBeVisible();
  // 小王 sees both, and the @ of his AI in it.
  await expect(B.locator(".msg:not(.by-ai)", { hasText: "FireTimer 的起转段我加好了" })).toBeVisible();
  await noSideOverflow(A);
  await shot(li.app, "C04-replied");
  await theme(A, "dark");
  await shot(li.app, "C05-replied-dark");
  await theme(A, "light");

  // ---- typing: new messages do not move the list; the bar says how many (once the list is longer than its box).
  for (let i = 1; i <= 8; i++) await wangStudio.postCowork(cw.id, { kind: "text", body: `射速表第 ${i} 行：${i * 2} 发/秒` });
  await expect(A.locator(".msg", { hasText: "射速表第 8 行" })).toBeInViewport();
  await box.click();
  await box.pressSequentially("我在写一条长的……");
  await wangStudio.postCowork(cw.id, { kind: "text", body: "满速段的数值我写进设计文档了" });
  await wangStudio.postCowork(cw.id, { kind: "text", body: "美术那边在等过热的颜色" });
  await expect(A.locator(".cw-fresh")).toHaveText("有 2 条新消息 ↓");
  await shot(li.app, "C06-fresh");
  await A.locator(".cw-fresh").click();
  await expect(A.locator(".cw-fresh")).toHaveCount(0);
  await box.fill("");
  // An @ of me while I am elsewhere waits in 待处理 (read once I am in the 协作).
  await A.locator(".rail-item", { hasText: "待处理" }).click();
  await wangStudio.postCowork(cw.id, { kind: "text", body: "@程序老李 过热的颜色读哪个字段？", mentions: ["程序老李"] });
  await expect(A.locator(".list-body .cw-wait.at")).toContainText("过热的颜色读哪个字段");
  await expect(A.locator(".rail-item", { hasText: "协作" }).locator(".badge")).toHaveText("1");
  // ---- 老李's AI @-s 小王: out at once (no drafts since 2026-11-24 — the 事项's gates replace 「AI 发起 @ 和提问」).
  const d = await liStudio.postCowork(cw.id, { kind: "text", body: "@策划小王 FireTimer 起转段推上去了（3f2a91c），曲线那边按 0.8 秒接就行。", mentions: ["策划小王"], via: viaLi });
  expect(d.draft).toBeUndefined();
  await expect(B.locator(".msg.by-ai", { hasText: "曲线那边按 0.8 秒接就行" })).toBeVisible();

  // ---- 事项 (2026-11-25, was 子会话): one asked of 老李 (from 小王), one 老李 opens to ask 小王; windows over the 群聊.
  const ask = await wangStudio.askCowork(cw.id, { to: "程序老李", title: "过热后射速怎么回落？", body: "列了两种：线性回落，或者直接掉到起转速度。", questions: [{ text: "回落多久", options: ["0.8 秒", "1.2 秒"] }, { text: "回落期间能开火吗" }] });
  await A.locator(".rail-item", { hasText: "待处理" }).click();
  await A.locator(".list-body .cw-wait.confirm", { hasText: "过热后射速怎么回落？" }).click();
  const first = mwin(A, "过热后射速怎么回落？");
  await expect(first).toBeVisible();
  await expect(first.locator(".cw-confirm")).toContainText("等你确认");
  await A.locator(".cowork-view .page-head").getByRole("button", { name: "＋ 事项" }).click();
  await A.getByRole("radio", { name: "请人确认" }).click();
  await A.getByLabel("请谁确认").selectOption("策划小王");
  await A.getByPlaceholder("比如：过热后射速怎么回落？").fill("枪管从第几秒开始变红？");
  await A.getByPlaceholder("变化：从什么改成什么").fill("变化：枪管变红从第 3 秒改到第 6 秒，和过热判定对齐\n例子：满速开火 4 秒停下，枪管不红\n不确认会怎样：美术先按第 3 秒做");
  await A.getByRole("dialog", { name: "开一件事项" }).getByRole("button", { name: "开", exact: true }).click();
  const second = mwin(A, "枪管从第几秒开始变红？");
  await expect(second).toBeVisible();
  const b1 = (await first.boundingBox())!;
  const b2 = (await second.boundingBox())!;
  expect([Math.round(b2.x - b1.x), Math.round(b2.y - b1.y)]).toEqual([28, 28]);
  // The card in the 群聊 for each; 小王 opens his from it: 等你确认 in its parts (变化 / 例子 / 不确认会怎样 / 来源).
  const wangCard = B.locator(".cw-mattercard", { hasText: "枪管从第几秒开始变红？" });
  await expect(wangCard.locator(".cw-look")).toHaveText("等你确认");
  await wangCard.click();
  const wangWin = mwin(B, "枪管从第几秒开始变红？");
  await expect(wangWin.locator(".cw-confirm-row", { hasText: "变化" })).toContainText("第 6 秒");
  await expect(wangWin.locator(".cw-confirm-row", { hasText: "不确认会怎样" })).toContainText("美术先按第 3 秒做");
  await expect(wangWin.locator(".cw-confirm-row", { hasText: "来源" })).toContainText("程序老李 问的");
  await shot(wang.app, "C07-matter-confirm");
  await theme(B, "dark");
  await shot(wang.app, "C07-matter-confirm-dark");
  await theme(B, "light");
  // Folded into a tab above the box, then out again.
  await second.getByRole("button", { name: "收起" }).click();
  // 开着 when the window opened before the 事项 came in; 等人确认 once it is here.
  await expect(A.locator(".cw-dock .float-tab")).toHaveText([/^事项 2：枪管从第几秒开始变红？(开着|等人确认)$/]);
  // Over the 群聊: what is open and whom it waits on.
  await expect(A.locator(".cw-openline")).toContainText("开着的事 2");
  await expect(A.locator(".cw-openline")).toContainText("等你确认");
  await noSideOverflow(A);
  await shot(li.app, "C08-matter-window");
  // Moved by its title bar, sized by its corner, maximized over the page and back.
  const fb = (await first.boundingBox())!;
  const head = (await first.locator(".float-title").boundingBox())!;
  await A.mouse.move(head.x + 10, head.y + 5);
  await A.mouse.down();
  await A.mouse.move(head.x + 60, head.y + 25, { steps: 5 });
  await A.mouse.move(head.x + 110, head.y + 45, { steps: 5 });
  await A.mouse.up();
  const moved = (await first.boundingBox())!;
  expect([Math.round(moved.x - fb.x), Math.round(moved.y - fb.y)]).toEqual([100, 40]);
  const grip = (await first.locator(".float-grip").boundingBox())!;
  await A.mouse.move(grip.x + 7, grip.y + 7);
  await A.mouse.down();
  await A.mouse.move(grip.x + 67, grip.y + 37, { steps: 5 });
  await A.mouse.up();
  expect(Math.round((await first.boundingBox())!.width - fb.width)).toBe(60);
  await first.getByRole("button", { name: "最大化" }).click();
  expect(await first.boundingBox()).toEqual(await A.locator(".float-layer").boundingBox());
  await first.getByRole("button", { name: "还原" }).click();
  expect(Math.round((await first.boundingBox())!.x)).toBe(Math.round(moved.x));
  // Answer the questions one by one: back to 小王's side (在做); its messages are folded until opened; then closed with a conclusion.
  await first.locator(".cw-answer button.opt", { hasText: "1.2 秒" }).click();
  await first.getByLabel("回答：回落期间能开火吗").fill("不能，回落完才能开火");
  await first.getByRole("button", { name: "回答", exact: true }).click();
  await expect(first.locator(".cw-sub-meta .cw-state")).toHaveText("◐ 在做");
  await expect(first.locator(".cw-confirm")).toHaveCount(0);
  await expect(first.locator(".msg")).toHaveCount(0);
  await first.getByRole("button", { name: /^事项里的消息/ }).click();
  await expect(first.locator(".msg", { hasText: "不能，回落完才能开火" })).toBeVisible();
  await expect(B.locator(".cw-mattercard", { hasText: "过热后射速怎么回落？" }).locator(".cw-state")).toHaveText("◐ 在做");
  await first.getByRole("button", { name: "关闭…" }).click();
  const closing = A.getByRole("dialog", { name: /^关闭事项 1/ });
  await closing.getByRole("textbox", { name: "结论" }).fill("回落 1.2 秒线性，回落期间不能开火");
  await closing.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(A.locator(".cw-decisions")).toContainText("回落 1.2 秒线性");
  await expect(first.locator(".cw-sub-meta .cw-state")).toHaveText("✓ 关闭");
  await expect(first.locator(".cw-conclusion")).toContainText("回落 1.2 秒线性");
  await expect(B.locator(".cw-decisions")).toContainText("回落 1.2 秒线性");
  expect(ask.thread?.id).toBeTruthy();
  await shot(li.app, "C09-matter-closed");
  await theme(A, "dark");
  await shot(li.app, "C09-matter-closed-dark");
  await theme(A, "light");
  // 转到我的会话: 老李's Studio is asked to take it (step 4's 「cowork-to-」 mark); 小王 has no Studio, the text is copied.
  await first.getByRole("button", { name: "转到我的会话" }).click();
  await expect.poll(() => opened).toEqual([JSON.stringify({ sessionId: `cowork-to-${ask.thread!.id}` })]);
  await expect(A.locator(".toast")).toContainText("在 Studio 里选一个会话");
  await wangWin.getByRole("button", { name: "转到我的会话" }).click();
  await expect(B.locator(".toast")).toContainText("已复制这件事项的全文");
  // 小王 confirms his: 「确认」 is a reply, the 事项 goes on (在做).
  await wangWin.locator(".cw-confirm").getByRole("button", { name: "确认", exact: true }).click();
  await expect(wangWin.locator(".cw-sub-meta .cw-state")).toHaveText("◐ 在做");
  await first.getByRole("button", { name: "关闭", exact: true }).click();
  await A.locator(".cw-dock .float-tab").click();
  await second.getByRole("button", { name: "关闭", exact: true }).click();
  await wangWin.getByRole("button", { name: "关闭", exact: true }).click();

  // ---- 回执 on my own messages only; 改 / 撤回 while nobody saw it; 发新的取代它 after (小王 is away from the 协作 meanwhile).
  await B.locator(".rail-item", { hasText: "聊天" }).click();
  await box.click();
  await box.fill("回落曲线我先按线性做");
  await box.press("Control+Enter");
  const said = A.locator(".msg.mine", { hasText: "回落曲线我先按线性做" });
  await expect(said.locator(".cw-receipts")).toBeVisible();
  const seqSaid = Number(await said.getAttribute("data-seq"));
  const saidAt = A.locator(`.msg[data-seq="${seqSaid}"]`);
  await expect(reply.locator(".cw-receipts")).toHaveCount(0);
  await saidAt.locator(".cw-msg-acts").getByRole("button", { name: "改", exact: true }).click();
  await saidAt.getByRole("textbox", { name: "改这条" }).fill("回落曲线按线性做，1.2 秒");
  await saidAt.getByRole("button", { name: "改好了" }).click();
  await expect(saidAt.locator(".msg-body")).toHaveText("回落曲线按线性做，1.2 秒");
  await expect(saidAt.locator(".msg-head")).toContainText("改过");
  await box.fill("这句发错了");
  await box.press("Control+Enter");
  const wrong = A.locator(".msg.mine", { hasText: "这句发错了" });
  await wrong.locator(".cw-msg-acts").getByRole("button", { name: "撤回" }).click();
  await expect(A.locator(".cw-withdrawn")).toContainText("撤回了一条消息");
  // 小王 marks it 处理了 (as his Studio would): one line under it, each on hover; 改 / 撤回 are gone.
  await wangStudio.markCowork(cw.id, { mark: "handled", seqs: [seqSaid] });
  await expect(saidAt.locator(".cw-rc-sum")).toContainText("1 处理了");
  await expect(saidAt.locator(".cw-msg-acts")).toHaveCount(0);
  await saidAt.locator(".cw-receipts").hover();
  await expect(saidAt.locator(".cw-rc-pop")).toBeVisible();
  await expect(saidAt.locator(".cw-rc-row.st-handled")).toHaveText(/^策划小王处理了/);
  await expect(saidAt.locator(".cw-rc-row", { hasText: "策划小王的主控" })).toContainText("排队");
  await shot(li.app, "C10-receipts");
  await theme(A, "dark");
  await shot(li.app, "C10-receipts-dark");
  await theme(A, "light");
  await saidAt.click({ button: "right" });
  await A.getByRole("menuitem", { name: /发新的取代它/ }).click();
  await expect(A.locator(".cw-replacing")).toContainText(`#${seqSaid}`);
  await box.fill("回落曲线按线性做，1.0 秒（改短了）");
  await box.press("Control+Enter");
  await expect(saidAt.locator(".cw-superseded")).toContainText("1.0 秒");
  await saidAt.locator(".cw-superseded").click();
  await expect(A.locator(".msg.mine:not(.superseded)", { hasText: "1.0 秒（改短了）" })).toBeInViewport();

  // ---- 要你看: a 闸门 from 小王's AI (等你确认), a 事项 waiting on 老李 (叫你来看), the @ from before (群聊知会).
  const gate = await wangStudio.askCowork(cw.id, { to: "程序老李", title: "满速段改成每秒 18 发", body: "变化：满速段从每秒 20 发改成 18 发\n例子：满速 6 秒从 120 发变成 108 发\n不确认会怎样：数值表先不导", via: viaWang });
  const look = await wangStudio.openMatter(cw.id, { title: "过热颜色读哪个字段", body: "我这边写好了 `overheat_tint`，你看一眼对不对。", side: "策划小王", status: "doing", waitingOn: ["person:程序老李"] });
  const lookBtn = A.locator(".cowork-view .page-head .cw-look-btn");
  const lookN = async () => Number((await lookBtn.textContent())!.replace(/\D/g, ""));
  await expect(lookBtn).toContainText("要你看");
  await lookBtn.click();
  const panel = A.locator(".cw-look-drop");
  await expect(panel.locator(".cw-lookrow", { hasText: "过热颜色读哪个字段" })).toBeVisible();
  const n0 = await lookN();
  expect(await panel.locator(".cw-lookrow").count()).toBe(n0);
  await expect(panel.locator(".cw-lookrow").nth(0)).toContainText("满速段改成每秒 18 发");
  await expect(panel.locator(".cw-lookrow").nth(0).locator(".cw-look")).toHaveText("等你确认");
  await expect(panel.locator(".cw-lookrow.look")).toContainText("过热颜色读哪个字段");
  await expect(panel.locator(".cw-lookrow.notice")).toContainText("过热的颜色读哪个字段？");
  await noSideOverflow(A);
  await shot(li.app, "C11-look");
  await theme(A, "dark");
  await shot(li.app, "C11-look-dark");
  await theme(A, "light");
  await panel.locator(".cw-lookrow.notice").getByRole("button", { name: "看过了" }).click();
  await expect.poll(lookN).toBe(n0 - 1);
  await panel.locator(".cw-lookrow", { hasText: "满速段改成每秒 18 发" }).click();
  const gateWin = mwin(A, "满速段改成每秒 18 发");
  await expect(gateWin.locator(".cw-confirm-row", { hasText: "例子" })).toContainText("108 发");
  await gateWin.locator(".cw-confirm").getByRole("button", { name: "有问题，回一句" }).click();
  await gateWin.getByRole("textbox", { name: "有问题，回一句" }).fill("先别改：美术的弹壳动画按 20 发做的");
  await gateWin.getByRole("button", { name: "回过去" }).click();
  await expect(gateWin.locator(".cw-sub-meta .cw-state")).toHaveText("◐ 在做");
  await expect.poll(lookN).toBe(n0 - 2);
  await gateWin.getByRole("button", { name: "关闭", exact: true }).click();
  await panel.getByRole("button", { name: "收起" }).click();
  await expect(panel).toHaveCount(0);

  // ---- the 板 (2026-11-25): computed from the 事项 — a frame per side and 已定 / 已验, my cards outlined, a filter, the
  // drawer; only a position a person dragged is kept. Both look at it at once.
  await B.locator(".rail-item", { hasText: "协作" }).click();
  await A.locator(".cowork-view .page-head").getByRole("tab", { name: "板" }).click();
  await B.locator(".cowork-view .page-head").getByRole("tab", { name: "板" }).click();
  const boardA = A.locator(".bd-page");
  const boardB = B.locator(".bd-page");
  await expect(boardA.locator(".bd-viewers")).toContainText("2 人在看");
  await expect(boardB.locator(".bd-viewers")).toContainText("2 人在看");
  await expect(boardA.locator(".bd-frame")).toHaveCount(3);
  await expect(boardA.locator('.bd-frame[data-frame="settled"] .bd-frame-head')).toContainText("已定 / 已验");
  const mcard = (p: Page, id: string) => p.locator(`.bd-card.k-matter[data-matter="${id}"]`);
  await expect(boardA.locator(".bd-card.k-matter")).toHaveCount(4);
  await expect(mcard(A, look.matter.id)).toHaveClass(/look-look/);
  await expect(mcard(A, look.matter.id).locator(".bd-look-tag")).toHaveText("叫你来看 · 程序老李");
  await expect(mcard(A, ask.thread!.id)).toContainText("回落 1.2 秒线性");
  await expect(mcard(A, gate.thread!.id)).toContainText("策划小王");
  // 依赖: 小王's 事项 waits for the 闸门 one, drawn as a dashed line.
  await wangStudio.patchMatter(cw.id, look.matter.id, { dependsOn: [gate.thread!.id] });
  await expect(boardA.locator(".bd-link.dep")).toHaveCount(1);
  // 要我看的: the rest dimmed; 在等别人的: what waits on 小王.
  await boardA.getByRole("tab", { name: "要我看的" }).click();
  await expect(mcard(A, look.matter.id)).not.toHaveClass(/(^| )dim( |$)/);
  await expect(mcard(A, ask.thread!.id)).toHaveClass(/(^| )dim( |$)/);
  await boardA.getByRole("tab", { name: "在等别人的" }).click();
  await expect(mcard(A, look.matter.id)).toHaveClass(/(^| )dim( |$)/);
  await boardA.getByRole("tab", { name: "全部" }).click();
  // A note of the board's own, next to them.
  await boardA.getByRole("button", { name: "＋ 便签" }).click();
  const editA = boardA.getByRole("textbox", { name: "便签的字" });
  await expect(editA).toBeVisible();
  await editA.pressSequentially("起转 0.8 秒，满速每秒 20 发");
  await expect(boardB.locator(".bd-tag.lock")).toHaveText("程序老李 在写…");
  await expect(boardB.locator(".bd-readonly")).toContainText("文字只读");
  await shot(wang.app, "C10-board-lock");
  await editA.press("Control+Enter");
  const noteB = card(B, "起转 0.8 秒，满速每秒 20 发");
  await expect(noteB).toBeVisible();
  await expect(boardB.locator(".bd-tag.lock")).toHaveCount(0);
  // 小王 picks it and moves it: 老李 sees who picked it, then where it went.
  const noteA = card(A, "起转 0.8 秒，满速每秒 20 发");
  const x0 = await leftOf(noteA);
  await noteB.click({ position: { x: 30, y: 14 } });
  await expect(noteA.locator(".bd-tag.who")).toHaveText("策划小王 选中");
  await drag(B, noteB, 120, 40);
  await expect.poll(() => leftOf(noteA)).toBeGreaterThan(x0 + 60);
  // Undo is one's own only: 小王's Ctrl+Z takes back his move (老李's text stays); a second has nothing of his left.
  await boardB.focus();
  await B.keyboard.press("Control+z");
  await expect.poll(() => leftOf(noteA)).toBeLessThan(x0 + 10);
  await expect(noteA).toContainText("起转 0.8 秒，满速每秒 20 发");
  await B.keyboard.press("Control+z");
  await expect(B.locator(".toast")).toContainText("没有可以撤销的了");
  // A 事项's card dragged by 老李 stays where he put it, for 小王 too (the only thing kept of a 事项's card).
  const mA = mcard(A, look.matter.id);
  const mx0 = await leftOf(mcard(B, look.matter.id));
  await drag(A, mA, 160, 60);
  await expect.poll(() => leftOf(mcard(B, look.matter.id))).toBeGreaterThan(mx0 + 100);
  // 小王's AI puts a card up: 「AI 刚改」.
  await wangStudio.coworkBoardOps(cw.id, [{ op: "add", opId: "ai-1", item: { kind: "note", text: "过热从第 6 秒开始（AI 记的）", x: 40, y: 760, w: 220, h: 110 } }], viaWang);
  await expect(card(A, "过热从第 6 秒开始").locator(".bd-tag.ai")).toHaveText("AI 刚改");
  await expect(boardA.locator(".bd-bar")).toContainText("策划小王 的 AI · 射速曲线 刚改过一张");
  // A text written on an old version (小王, offline a while): 另一版, 老李 picks one.
  const snap = await wangStudio.coworkBoard(cw.id, 0);
  const note = snap.items!.find((i) => i.text.startsWith("起转 0.8 秒"))!;
  await wangStudio.coworkBoardOps(cw.id, [{ op: "set", opId: "w-off-1", id: note.id, base: note.textVersion - 1, fields: { text: "起转 1 秒，满速每秒 18 发" } }]);
  await expect(noteA.locator(".bd-conflict")).toHaveText("! 有冲突，看另一版");
  await noteA.locator(".bd-conflict").click();
  await expect(A.locator(".bd-version")).toHaveCount(2);
  await shot(li.app, "C11-board-conflict");
  await A.locator(".bd-version", { hasText: "起转 1 秒" }).getByRole("button", { name: "用这一版" }).click();
  await expect(card(B, "起转 1 秒，满速每秒 18 发")).toBeVisible();
  await expect(card(A, "起转 1 秒，满速每秒 18 发").locator(".bd-conflict")).toHaveCount(0);
  // A file read at a commit, and a line from the note to a 事项's old card (drawn to the 事项's card now).
  await wangStudio.coworkBoardOps(cw.id, [
    { op: "add", opId: "w-r", item: { id: "r1", kind: "ref", ref: { kind: "file", path: "设计/加特林.md", commit: "3f2a91c", title: "加特林射速设计" }, x: 620, y: 600, w: 260, h: 90 } },
    { op: "add", opId: "w-s", item: { id: "s1", kind: "session", session: ask.thread!.id, x: 1200, y: 200, w: 260, h: 110 } },
    { op: "add", opId: "w-l", item: { id: "l1", kind: "link", from: note.id, to: "s1" } },
  ]);
  await expect(boardA.locator(".bd-link:not(.dep)")).toHaveCount(1);
  await expect(boardA.locator('.bd-card.k-session')).toHaveCount(0);
  // 标已过时 from the bar of the card picked.
  await card(A, "加特林射速设计").click({ position: { x: 30, y: 14 } });
  await boardA.locator(".bd-selbar").getByRole("button", { name: "标已过时" }).click();
  await expect(card(B, "加特林射速设计")).toContainText("! 已过时");
  await boardA.getByRole("button", { name: "看全部" }).click();
  await noSideOverflow(A);
  await shot(li.app, "C12-board");
  await theme(A, "dark");
  await shot(li.app, "C13-board-dark");
  await theme(A, "light");
  // A 事项's card opens its drawer; the 群聊 opens on the left.
  await mcard(A, gate.thread!.id).click({ position: { x: 40, y: 50 } });
  await expect(boardA.locator(".bd-drawer .cw-matter-title")).toHaveText("满速段改成每秒 18 发");
  await boardA.locator(".bd-drawer").getByRole("button", { name: /^事项信息/ }).click();
  await expect(boardA.locator(".bd-drawer .cw-minfo")).toContainText("在等");
  await shot(li.app, "C12-board-drawer");
  await boardA.locator(".bd-drawer").getByRole("button", { name: "关闭 ×" }).click();
  await boardA.locator(".bd-bar").getByRole("button", { name: /^群聊/ }).click();
  await expect(boardA.locator(".bd-chat .msg:not(.superseded)", { hasText: "1.0 秒（改短了）" })).toBeVisible();
  await noSideOverflow(A);
  await theme(A, "dark");
  await shot(li.app, "C12-board-chat-dark");
  await theme(A, "light");
  await boardA.locator(".bd-chat").getByRole("button", { name: "收起 ×" }).click();
  // Off screen: a card of mine away from the view has an arrow on the edge; clicked, it is brought over with its drawer.
  const plane = (await boardA.locator(".bd-plane").boundingBox())!;
  await A.mouse.move(plane.x + plane.width - 20, plane.y + plane.height - 20);
  await A.mouse.down();
  await A.mouse.move(plane.x + plane.width - 1020, plane.y + plane.height - 20, { steps: 6 });
  await A.mouse.move(plane.x + plane.width - 2020, plane.y + plane.height - 20, { steps: 6 });
  await A.mouse.up();
  const arrow = boardA.locator('.bd-offscreen[title*="过热颜色读哪个字段"]');
  await expect(arrow).toContainText("叫你来看");
  await shot(li.app, "C13-board-offscreen");
  await arrow.click();
  await expect(boardA.locator(".bd-drawer .cw-matter-title")).toHaveText("过热颜色读哪个字段");
  await expect(arrow).toHaveCount(0);
  await boardA.locator(".bd-drawer").getByRole("button", { name: "关闭 ×" }).click();
  // Deleted, found in 最近删除, brought back; 老李's undo takes back only his own (the bringing back).
  await boardA.getByRole("button", { name: "看全部" }).click();
  const aiCard = card(A, "过热从第 6 秒开始");
  await aiCard.click({ position: { x: 30, y: 14 } });
  await boardA.locator(".bd-selbar").getByRole("button", { name: "删除" }).click();
  await expect(card(B, "过热从第 6 秒开始")).toHaveCount(0);
  await boardA.getByRole("button", { name: /^最近删除 · / }).click();
  await boardA.locator(".bd-pop .bd-pop-row", { hasText: "过热从第 6 秒开始" }).getByRole("button", { name: "找回" }).click();
  await expect(card(B, "过热从第 6 秒开始")).toBeVisible();
  await boardA.focus();
  await A.keyboard.press("Control+z");
  await expect(card(B, "过热从第 6 秒开始")).toHaveCount(0);
  // Its history.
  await card(A, "起转 1 秒").click({ position: { x: 30, y: 14 } });
  await boardA.locator(".bd-selbar").getByRole("button", { name: "改动记录" }).click();
  await expect(boardA.locator(".bd-pop")).toContainText("改了文字");
  await shot(li.app, "C13-board-history");
  await boardA.locator(".bd-pop").getByRole("button", { name: "关闭" }).click();
  await A.locator(".cowork-view .page-head").getByRole("tab", { name: "群聊" }).click();
  await B.locator(".cowork-view .page-head").getByRole("tab", { name: "群聊" }).click();

  // ---- 成员和角色: my AI as 执行 of a 事项; then no 主控 on my side, 「在我的 Studio 里开这一方的主控」 asks my Studio
  // (studio:<设备>:cowork-lead-<协作>); the 主控 it brings in can be asked to look now (cowork-patrol-<协作>).
  const info = A.locator(".cw-info");
  const liRow = info.locator(`.cw-person.agent[data-agent="${liAi}"]`);
  await expect(liRow.locator(".cw-role")).toHaveText("主控");
  await expect(info.locator(`.cw-person.agent[data-agent="${wangAi}"] .cw-person-acts button`)).toHaveCount(0);
  await expect(info.getByRole("button", { name: "在我的 Studio 里开这一方的主控" })).toHaveCount(0);
  await liRow.getByRole("button", { name: "改角色" }).click();
  await A.getByRole("menuitem", { name: /设成执行：事项 2/ }).click();
  await expect(liRow.locator(".cw-role")).toHaveText("执行 · 事项 2");
  await info.getByRole("button", { name: "在我的 Studio 里开这一方的主控" }).click();
  await expect.poll(() => opened.at(-1)).toBe(JSON.stringify({ sessionId: `cowork-lead-${cw.id}` }));
  await expect(A.locator(".toast")).toContainText("已交给 Studio");
  const leadMark = `studio:${DEVICE}:s-lead`;
  await liStudio.joinCoworkAgent(cw.id, leadMark, "加特林 · 主控");
  const leadRow = info.locator(`.cw-person.agent[data-agent="${leadMark}"]`);
  await expect(leadRow.locator(".cw-role")).toHaveText("主控");
  await expect(info.getByRole("button", { name: "在我的 Studio 里开这一方的主控" })).toHaveCount(0);
  await leadRow.getByRole("button", { name: "让主控现在看一遍" }).click();
  await expect.poll(() => opened.at(-1)).toBe(JSON.stringify({ sessionId: `cowork-patrol-${cw.id}` }));
  await noSideOverflow(A);
  await shot(li.app, "C14-roles");

  // ---- 信息栏: the goal changed, its history; then the page at 960 (信息栏 folded).
  await info.locator(".side-blk", { hasText: "目标说明" }).getByRole("button", { name: "改", exact: true }).click();
  await info.getByRole("textbox", { name: "目标说明" }).fill("射速做成四段，满速 6 秒后过热，回落 1.2 秒线性。");
  await info.getByRole("button", { name: "保存" }).click();
  await expect(info.locator(".cw-goal-hist")).toContainText("改过 1 次");
  await expect(B.locator(".cw-info .cw-goal")).toContainText("回落 1.2 秒线性");
  await noSideOverflow(A);
  await shot(li.app, "C14-info");
  await size(li.app, 960, 720);
  await A.locator(".rail-item", { hasText: "聊天" }).click();
  await A.locator(".rail-item", { hasText: "协作" }).click();
  await expect(A.locator(".cw-info")).toHaveCount(0);
  // The 板's changes came as one folded line in the 群聊; opened, each is there.
  await expect(A.locator(".cw-fold")).toContainText(/板上 \d+ 处改动/);
  await noSideOverflow(A);
  await shot(li.app, "C15-cowork-960");
  await A.locator(".cw-fold").click();
  await expect(A.locator(".cw-event.kind-board").first()).toContainText("收起");
  await A.locator(".cw-event.kind-board").first().getByRole("button", { name: "收起" }).click();
  await expect(A.locator(".cw-fold")).toHaveCount(1);
  await A.locator(".cowork-view .page-head").getByRole("button", { name: "信息栏" }).click();
  await expect(A.locator(".cw-info")).toBeVisible();
  await shot(li.app, "C16-cowork-960-info");
  await A.locator(".cw-info").getByRole("button", { name: "收起信息栏" }).first().click();
  await A.locator(".cowork-view .page-head").getByRole("tab", { name: "板" }).click();
  await theme(A, "dark");
  await expect(A.locator(".bd-page .bd-card.k-matter").first()).toBeVisible();
  await noSideOverflow(A);
  await shot(li.app, "C17-board-960-dark");
  await theme(A, "light");
  await A.locator(".cowork-view .page-head").getByRole("tab", { name: "群聊" }).click();
  await size(li.app, 1280, 800);

  // ---- the AIs' run (老李's side by its new 主控: an 执行 cannot talk in the 群聊): 30 in a row in the 群聊 and they wake
  // nobody more, a line says so.
  for (let i = 0; i < 30; i++) await (i % 2 ? liStudio : wangStudio).postCowork(cw.id, { kind: "text", body: `第 ${i + 1} 条（AI 之间）`, via: i % 2 ? { kind: "ai", client: "AMO Studio", conv: leadMark } : viaWang });
  await expect(A.locator(".cw-event.kind-paused")).toContainText("AI 之间已经连续往来 30 条");
  await shot(li.app, "C18-paused");

  // ---- 结束 and 重新打开 (both see it).
  if (!(await A.locator(".cw-info").count())) await A.locator(".cowork-view .page-head").getByRole("button", { name: "信息栏" }).click();
  A.once("dialog", (dlg) => void dlg.accept());
  await A.locator(".cw-info").getByRole("button", { name: "结束协作" }).click();
  await expect(B.locator(".cowork-view .page-crumb")).toHaveText("已结束的协作");
  await expect(B.locator(".cowork-view .cw-composer.off")).toContainText("协作已结束");
  await expect(B.locator(".list-sec", { hasText: "已结束" })).toBeVisible();
  await A.locator(".cw-info").getByRole("button", { name: "重新打开协作" }).click();
  await expect(B.locator(".cowork-view .page-crumb")).toHaveText("协作");
  expect(pageErrors).toEqual([]);
});
