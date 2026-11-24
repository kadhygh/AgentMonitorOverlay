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
// shows its state and what an @ does, the line over the box says where it goes, the message's trail goes 排队中 → 已送达 →
// 已回复 and the reply quotes it. Typing keeps the list still with 「有 N 条新消息」. 老李's own AI's @ goes out at once (no
// drafts since 2026-11-24). A 子会话 opens as a window (several at once, folded into tabs), is answered and
// concluded into 已定的事. Both open the 白板: who is looking, the soft lock 「在写」, selections, a move seen by the other,
// an AI's card marked 「AI 刚改」, a conflict picked, a delete brought back, undo only of one's own. Then the AIs' run of 30
// messages paused. Light, dark and 960 px. Needs `npm run relay:release` first (release/relay/client).

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
    [...document.querySelectorAll(".rail, .list-pane, .list-row, .page-head, .side-panel, .cw-dock, .cw-sub-head, .bd-bar, .bd-selbar")]
      .filter((e) => (e as HTMLElement).offsetParent && e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.className}: ${e.scrollWidth} > ${e.clientWidth}`),
  );
  expect(over).toEqual([]);
}
const win = (page: Page, title: string) => page.locator(`.float-win[aria-label^="${title}"]`);
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

test("协作: @ another's AI from queue to reply, an AI's @ at once, 子会话 windows, the 白板 changed by two at once", async () => {
  test.setTimeout(300_000);
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
  await expect(mine.locator(".cw-trail .step.now")).toContainText("排队中");
  // 小王's Studio takes it (its session's turn is over), then the AI answers it.
  const inbox = await wangStudio.coworkInbox("studio:d_wang:");
  expect(inbox.items.map((i) => i.message.body)).toEqual([expect.stringContaining("FireTimer 的起转段我加好了")]);
  await wangStudio.ackCowork(inbox.items.map((i) => i.delivery.id));
  await expect(mine.locator(".cw-trail .step.now")).toContainText("已送达");
  await wangStudio.reportCoworkAgents([{ mark: wangAi, state: "busy" }]);
  await wangStudio.postCowork(cw.id, { kind: "text", body: "可以，起转 0.8 秒；满速段我按每秒 20 发配，过热从第 6 秒开始。", replyTo: inbox.items[0]!.message.seq, via: viaWang });
  await expect(mine.locator(".cw-trail .step.done")).toHaveText([/排队中/, /已送达/, /已回复/]);
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

  // ---- 子会话: one asked of 老李 (from 小王), one 老李 asks; windows over the page.
  const ask = await wangStudio.askCowork(cw.id, { to: "程序老李", title: "过热后射速怎么回落？", body: "列了两种：线性回落，或者直接掉到起转速度。", questions: [{ text: "回落多久", options: ["0.8 秒", "1.2 秒"] }, { text: "回落期间能开火吗" }] });
  await A.locator(".rail-item", { hasText: "待处理" }).click();
  await A.locator(".list-body .cw-wait.sub", { hasText: "过热后射速怎么回落？" }).click();
  await expect(win(A, "子会话：过热后射速怎么回落？")).toBeVisible();
  await A.locator(".cowork-view .page-head").getByRole("button", { name: "＋ 子会话" }).click();
  await A.getByLabel("问谁").selectOption("策划小王");
  await A.getByPlaceholder("比如：过热后射速怎么回落？").fill("枪管从第几秒开始变红？");
  await A.getByPlaceholder("背景、列出的几种做法（支持 Markdown）").fill("美术说第 3 秒，我这边过热判定在第 6 秒。");
  await A.getByRole("button", { name: "发起", exact: true }).click();
  const second = win(A, "子会话：枪管从第几秒开始变红？");
  await expect(second).toBeVisible();
  const b1 = (await win(A, "子会话：过热后射速怎么回落？").boundingBox())!;
  const b2 = (await second.boundingBox())!;
  expect([Math.round(b2.x - b1.x), Math.round(b2.y - b1.y)]).toEqual([28, 28]);
  // The card in the 群聊 for each; 小王 opens his from it.
  await expect(B.locator(".cw-subcard", { hasText: "枪管从第几秒开始变红？" })).toBeVisible();
  await B.locator(".cw-subcard", { hasText: "枪管从第几秒开始变红？" }).click();
  await expect(win(B, "子会话：枪管从第几秒开始变红？")).toBeVisible();
  // Folded into a tab above the box, then out again.
  await second.getByRole("button", { name: "收起" }).click();
  // 开着 when the window opened before the 子会话 came in; 等策划小王 when it came first (the service pushes the 协作 once a
  // 事项 is opened, 2026-11-24).
  await expect(A.locator(".cw-dock .float-tab")).toHaveText([/^子会话：枪管从第几秒开始变红？(开着|等策划小王)$/]);
  await noSideOverflow(A);
  await shot(li.app, "C08-sub-window");
  // Moved by its title bar, sized by its corner, maximized over the page and back.
  const w1 = win(A, "子会话：过热后射速怎么回落？");
  const fb = (await w1.boundingBox())!;
  const head = (await w1.locator(".float-title").boundingBox())!;
  await A.mouse.move(head.x + 10, head.y + 5);
  await A.mouse.down();
  await A.mouse.move(head.x + 60, head.y + 25, { steps: 5 });
  await A.mouse.move(head.x + 110, head.y + 45, { steps: 5 });
  await A.mouse.up();
  const moved = (await w1.boundingBox())!;
  expect([Math.round(moved.x - fb.x), Math.round(moved.y - fb.y)]).toEqual([100, 40]);
  const grip = (await w1.locator(".float-grip").boundingBox())!;
  await A.mouse.move(grip.x + 7, grip.y + 7);
  await A.mouse.down();
  await A.mouse.move(grip.x + 67, grip.y + 37, { steps: 5 });
  await A.mouse.up();
  expect(Math.round((await w1.boundingBox())!.width - fb.width)).toBe(60);
  await w1.getByRole("button", { name: "最大化" }).click();
  expect(await w1.boundingBox()).toEqual(await A.locator(".float-layer").boundingBox());
  await w1.getByRole("button", { name: "还原" }).click();
  expect(Math.round((await w1.boundingBox())!.x)).toBe(Math.round(moved.x));
  // Answer the questions one by one, then settle it.
  const first = win(A, "子会话：过热后射速怎么回落？");
  await first.getByRole("button", { name: "逐条回答" }).click();
  await first.locator(".cw-answer button.opt", { hasText: "1.2 秒" }).click();
  await first.getByLabel("回答：回落期间能开火吗").fill("不能，回落完才能开火");
  await first.getByRole("button", { name: "回答", exact: true }).click();
  await expect(first.locator(".msg", { hasText: "不能，回落完才能开火" })).toBeVisible();
  await expect(B.locator(".cw-subcard", { hasText: "过热后射速怎么回落？" })).toContainText("! 等你");
  await first.getByRole("button", { name: "定下结论…" }).click();
  await A.getByRole("textbox", { name: "结论" }).fill("回落 1.2 秒线性，回落期间不能开火");
  await A.getByRole("button", { name: "定下", exact: true }).click();
  await expect(A.locator(".cw-decisions")).toContainText("回落 1.2 秒线性");
  await expect(first.locator(".cw-sub-meta .cw-state")).toHaveText("✓ 已定");
  await expect(B.locator(".cw-decisions")).toContainText("回落 1.2 秒线性");
  expect(ask.thread?.id).toBeTruthy();
  await shot(li.app, "C09-sub-concluded");
  await theme(A, "dark");
  await shot(li.app, "C09-sub-concluded-dark");
  await theme(A, "light");
  // 转到我的会话: 老李's Studio is asked to take it (step 4's 「cowork-to-」 mark); 小王 has no Studio, the text is copied.
  await first.getByRole("button", { name: "转到我的会话" }).click();
  await expect.poll(() => opened).toEqual([JSON.stringify({ sessionId: `cowork-to-${ask.thread!.id}` })]);
  await expect(A.locator(".toast")).toContainText("在 Studio 里选一个会话");
  await win(B, "子会话：枪管从第几秒开始变红？").getByRole("button", { name: "转到我的会话" }).click();
  await expect(B.locator(".toast")).toContainText("已复制这个子会话的全文");
  await first.getByRole("button", { name: "关闭" }).click();
  await A.locator(".cw-dock .float-tab").click();
  await second.getByRole("button", { name: "关闭" }).click();
  await win(B, "子会话：枪管从第几秒开始变红？").getByRole("button", { name: "关闭" }).click();

  // ---- the 白板, both at once.
  await A.locator(".cowork-view .page-head").getByRole("button", { name: "打开白板" }).click();
  await B.locator(".cowork-view .page-head").getByRole("button", { name: "打开白板" }).click();
  const boardA = win(A, "白板");
  const boardB = win(B, "白板");
  await expect(boardA.locator(".bd-viewers")).toContainText("2 人在看");
  await expect(boardB.locator(".bd-viewers")).toContainText("2 人在看");
  // 老李 writes a note: 小王 sees 「在写」 and cannot write it meanwhile.
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
  await boardB.locator(".bd").focus();
  await B.keyboard.press("Control+z");
  await expect.poll(() => leftOf(noteA)).toBeLessThan(x0 + 10);
  await expect(noteA).toContainText("起转 0.8 秒，满速每秒 20 发");
  await B.keyboard.press("Control+z");
  await expect(B.locator(".toast")).toContainText("没有可以撤销的了");
  await expect(noteA).toContainText("起转 0.8 秒，满速每秒 20 发");
  await drag(B, noteB, 120, 40);
  await expect.poll(() => leftOf(noteA)).toBeGreaterThan(x0 + 60);
  // 小王's AI puts a card up: 「AI 刚改」.
  await wangStudio.coworkBoardOps(cw.id, [{ op: "add", opId: "ai-1", item: { kind: "note", text: "过热从第 6 秒开始（AI 记的）", x: 40, y: 260, w: 220, h: 110 } }], viaWang);
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
  // The other kinds: a group with the 子会话's card and a file read at a commit in it, a line from the note to the card.
  const noteId = note.id;
  await wangStudio.coworkBoardOps(cw.id, [
    { op: "add", opId: "w-g", item: { id: "g1", kind: "group", text: "过热和回落", x: 760, y: 20, w: 300, h: 330 } },
    { op: "add", opId: "w-s", item: { id: "s1", kind: "session", session: ask.thread!.id, x: 780, y: 60, w: 260, h: 110, group: "g1" } },
    { op: "add", opId: "w-r", item: { id: "r1", kind: "ref", ref: { kind: "file", path: "设计/加特林.md", commit: "3f2a91c", title: "加特林射速设计" }, x: 780, y: 200, w: 260, h: 90, group: "g1" } },
    { op: "add", opId: "w-l", item: { id: "l1", kind: "link", from: noteId, to: "s1" } },
  ]);
  await expect(card(A, "过热后射速怎么回落？")).toContainText("回落 1.2 秒线性");
  await expect(boardA.locator(".bd-link")).toHaveCount(1);
  // 标已过时 from the bar of the card picked.
  await card(A, "加特林射速设计").click({ position: { x: 30, y: 14 } });
  await boardA.locator(".bd-selbar").getByRole("button", { name: "标已过时" }).click();
  await expect(card(B, "加特林射速设计")).toContainText("! 已过时");
  await boardA.getByRole("button", { name: "回到中间" }).click();
  await expect(A.locator(".cw-fresh")).toHaveCount(0);
  await noSideOverflow(A);
  await shot(li.app, "C12-board");
  await theme(A, "dark");
  await shot(li.app, "C13-board-dark");
  await theme(A, "light");
  // Deleted, found in 最近删除, brought back; 老李's undo takes back only his own (the bringing back).
  const aiCard = card(A, "过热从第 6 秒开始");
  await aiCard.click({ position: { x: 30, y: 14 } });
  await boardA.locator(".bd-selbar").getByRole("button", { name: "删除" }).click();
  await expect(card(B, "过热从第 6 秒开始")).toHaveCount(0);
  await boardA.getByRole("button", { name: "最近删除 · 1" }).click();
  await boardA.locator(".bd-pop").getByRole("button", { name: "找回" }).click();
  await expect(card(B, "过热从第 6 秒开始")).toBeVisible();
  await boardA.locator(".bd").focus();
  await A.keyboard.press("Control+z");
  await expect(card(B, "过热从第 6 秒开始")).toHaveCount(0);
  // Its history.
  await card(A, "起转 1 秒").click({ position: { x: 30, y: 14 } });
  await boardA.locator(".bd-selbar").getByRole("button", { name: "改动记录" }).click();
  await expect(boardA.locator(".bd-pop")).toContainText("改了文字");
  await shot(li.app, "C13-board-history");
  await boardA.locator(".bd-pop").getByRole("button", { name: "关闭" }).click();

  // ---- 信息栏: the goal changed, its history; then the page at 960 (信息栏 folded).
  await boardA.getByRole("button", { name: "收起" }).click();
  const info = A.locator(".cw-info");
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
  // The 白板's changes came as one folded line in the 群聊; opened, each is there.
  await expect(A.locator(".cw-fold")).toContainText(/白板上 \d+ 处改动/);
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
  await A.locator(".cowork-view .page-head").getByRole("button", { name: "打开白板" }).click();
  await theme(A, "dark");
  await expect.poll(async () => { const l = (await A.locator(".float-layer").boundingBox())!; const b = (await win(A, "白板").boundingBox())!; return b.x + b.width <= l.x + l.width + 1; }).toBe(true);
  await shot(li.app, "C17-board-960-dark");
  await theme(A, "light");
  await win(A, "白板").getByRole("button", { name: "关闭" }).click();
  await size(li.app, 1280, 800);

  // ---- the AIs' run: 30 in a row in the 群聊 and they wake nobody more, a line says so.
  for (let i = 0; i < 30; i++) await (i % 2 ? liStudio : wangStudio).postCowork(cw.id, { kind: "text", body: `第 ${i + 1} 条（AI 之间）`, via: i % 2 ? viaLi : viaWang });
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
