import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

// AMO 中转's desktop client (plans/relay.md, relay-tasks.md) against a real service in this process: first start (loader →
// content download → login), register two people, a session sent by an AI through the command line the client
// installs, answered one by one in the other client and handed back (the AI fetches it, the person takes it over and
// closes it), team tasks (files on it, a note in the viewer sent with a reply, an HTML file without its scripts; a session under one, 接手任务 from it, 流转 back, seen, archived, shared settings), a direct chat and a topic next to it (archived on one side), updates (installed by the loader at start; applied by itself
// while signed in, when the window is not in use), and the service going away and coming back (the bar, the login
// screen's status). Needs `npm run relay:release` first (release/relay/client).
// That one runs with the full UI (localStorage amo-relay.full); the second test is the tightened one people see
// (2026-10-28, relay-ui/src/features.ts): an AI's session answered, asked again with a new round, closed by the AI.

// Async: the service runs in this process, so a blocking exec would stall it.
const exec = async (file: string, args: string[]) => (await promisify(execFile)(file, args, { encoding: "utf8" })).stdout;
const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const electronPath = createRequire(import.meta.url)("electron") as string;
// AMO_RELAY_E2E_RELEASE: test a build made with --out elsewhere before publishing it to the running service.
const built = join(process.env.AMO_RELAY_E2E_RELEASE ?? join(studio, "release", "relay"), "client");
const shots = join(studio, "screenshots", "relay");

const relay = await import(pathToFileURL(join(studio, "packages", "relay", "dist", "index.js")).href) as typeof import("../../packages/relay/src/index.js");
// The platform's account module: the profile is edited there now (2026-10-28), against this same service.
const account = await import(pathToFileURL(join(studio, "packages", "account", "dist", "index.js")).href) as typeof import("../../packages/account/src/index.js");

let root: string;
let publicDir: string;
let store: InstanceType<typeof relay.RelayStore>;
let server: Awaited<ReturnType<typeof relay.startRelayServer>>;
const apps: ElectronApplication[] = [];
/** Uncaught errors in the clients' pages: a crash unmounts the whole client, so the test ends with none. */
const pageErrors: string[] = [];

test.beforeAll(async () => {
  test.skip(!existsSync(join(built, "manifest.json")), "run npm run relay:release first");
  root = mkdtempSync(join(tmpdir(), "relay-e2e-"));
  publicDir = join(root, "public");
  cpSync(built, join(publicDir, "client"), { recursive: true });
  store = new relay.RelayStore(join(root, "server", "relay.db"));
  server = await startServer(0);
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await server?.close();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const startServer = (port: number) => relay.startRelayServer({ store, publicDir, filesDir: join(root, "files"), host: "127.0.0.1", port, name: "测试组", clientWatchMs: 300 });

async function launch(who: string, extraArgs: string[] = []): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = join(root, who);
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(studio, "packages", "relay-app", "dist", "main.js"), "--server", server.url, ...extraArgs],
    // AMO_HOME: the platform's folder (account.json), empty unless the test logs in there — never this machine's own.
    env: { ...process.env, AMO_RELAY_HOME: home, AMO_HOME: join(home, "amo-home"), AMO_RELAY_TEST: "1" },
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.stack ?? e.message}`));
  return { app, page, home };
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}

async function register(page: Page, name: string, role: string, full = true): Promise<void> {
  await expect(page.getByRole("button", { name: "没有账号？注册一个" })).toBeVisible({ timeout: 30_000 });
  if (full) await page.evaluate(() => localStorage.setItem("amo-relay.full", "1"));
  await page.getByRole("button", { name: "没有账号？注册一个" }).click();
  await page.getByLabel("名字").fill(name);
  await page.getByLabel("密码", { exact: true }).fill("pw-1234");
  await page.getByLabel("再输一次密码").fill("pw-1234");
  await page.getByLabel(/负责什么/).fill(role);
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.locator(".view-tabs")).toBeVisible();
}

test("register, an AI's request answered in the other client, updates, the service away and back", async () => {
  const a = await launch("planner");
  await register(a.page, "策划小王", "策划");
  const b = await launch("coder");
  await register(b.page, "程序老李", "程序 · 战斗");
  await shot(b.app, "01-home-empty");

  // The planner's AI asks through the command line the client installed (its own exe as Node).
  const cli = join(a.home, "amo-relay.cmd");
  expect(existsSync(cli)).toBe(true);
  // 复制用法 copies where the usage file is; the file holds the whole text, kept current.
  await a.page.getByRole("button", { name: "复制用法" }).click();
  const usageFile = join(a.home, "AMO中转用法.md");
  await expect.poll(() => existsSync(usageFile)).toBe(true);
  expect(readFileSync(usageFile, "utf8")).toContain("我是 策划小王（策划）");
  expect(readFileSync(usageFile, "utf8")).toContain("程序老李（程序 · 战斗）");
  expect(readFileSync(usageFile, "utf8")).toContain("`relay newtask --title");
  const copied = await a.app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toContain(usageFile);
  expect(copied.length).toBeLessThan(400);
  const req = join(root, "req.json");
  writeFileSync(req, JSON.stringify({ to: "程序老李", title: "技能冷却按等级递减", body: "方案：每升 1 级冷却 **-0.5s**，最低 3s。\n\n| 等级 | 冷却 |\n|---|---|\n| 1 | 8s |\n| 10 | 3.5s |", questions: [{ text: "现在的技能表能直接加这一列吗", options: ["能", "要改结构"] }, { text: "大概要几天" }] }));
  const asked = await exec("cmd.exe", ["/c", cli, "ask", "--json", req]);
  expect(asked).toContain("已发给 程序老李");

  // The coder sees it in 待处理 and answers one by one; a session from an AI cannot be closed by the person asked.
  const row = (page: Page, text: string) => page.locator(".scope-nav .srow", { hasText: text });
  await expect(row(b.page, "技能冷却按等级递减")).toContainText("等你处理");
  await row(b.page, "技能冷却按等级递减").click();
  await expect(b.page.locator(".msg.kind-request")).toContainText("最低 3s");
  await expect(b.page.locator(".msg .tag.ai")).toContainText("AI 代发");
  await expect(b.page.getByRole("button", { name: "标记完成" })).toHaveCount(0);
  await expect(b.page.locator(".reply-form .why")).toContainText("AI 发来的会话一定要回复");
  await b.page.locator(".reply-form .opt", { hasText: "能" }).click();
  await b.page.locator(".reply-form .rq").nth(1).locator("input").fill("两天");
  await b.page.getByPlaceholder("补充说明（支持 Markdown）").fill("配置在 `skill.xlsx`，我来加列。");
  await b.page.locator(".vbtn", { hasText: "同意" }).click();
  await shot(b.app, "02-reply-form");
  await b.page.getByRole("button", { name: "回复并返回给 策划小王 的 AI" }).click();
  await expect(b.page.locator(".msg.kind-reply")).toContainText("两天");
  await expect(row(b.page, "技能冷却按等级递减")).toContainText("已返回给 策划小王");

  // Back with the planner: the AI has not taken it yet; the AI reads it through the command line — 「已取回」 —
  // then the planner takes it over (我来处理): the AI is refused from then on; the planner closes it.
  await row(a.page, "技能冷却按等级递减").click();
  await expect(a.page.locator(".msg.kind-reply .verdict")).toContainText("同意");
  await expect(a.page.locator(".aiband")).toContainText("程序老李 回复了");
  await shot(a.app, "03-planner-returned");
  const threadId = /threadId: (\S+)/.exec(asked)![1]!;
  const replies = await exec("cmd.exe", ["/c", cli, "replies", threadId]);
  expect(replies).toContain("**现在的技能表能直接加这一列吗** → 能");
  await expect(a.page.locator(".aiband")).toContainText("已取回");
  await expect(row(a.page, "技能冷却按等级递减")).toContainText("AI 已取回");
  await a.page.getByRole("button", { name: "我来处理" }).click();
  await expect(a.page.locator(".event").last()).toContainText("从 AI 手里接手了这个会话");
  await expect(exec("cmd.exe", ["/c", cli, "send", threadId, "--body", "再问一句", "--then", "ask"])).rejects.toThrow(/本人接手/);
  // A follow-up in words is answered in words: no form with the first round again.
  await a.page.getByPlaceholder("继续追问 程序老李…（发出后会话回到对方手里）").fill("那周三前能加上吗？");
  await a.page.getByRole("button", { name: "继续追问" }).click();
  await row(b.page, "技能冷却按等级递减").click();
  await expect(b.page.locator(".reply-form")).toHaveCount(0);
  await b.page.getByPlaceholder(/的追问…/).fill("可以，周三前加上");
  await b.page.getByRole("button", { name: /^回复并返回给/ }).click();
  await expect(a.page.locator(".msg.theirs").last()).toContainText("周三前加上");
  await a.page.locator(".dock").getByRole("button", { name: "标记完成" }).click();
  await expect(a.page.locator(".event").last()).toContainText("标记完成");
  await expect(a.page.getByRole("button", { name: "重新打开" })).toBeVisible();

  // Team tasks (2b): the planner makes one and opens a session under it; the coder takes the task over from the
  // session (it needs a reply, so the session goes back answered); hands it back for 验收; the planner sees it handed
  // to them, finishes and archives it. Settings are the team's: the coder's 流程速查 shows the planner's change.
  await a.page.locator(".view-tab", { hasText: "任务" }).click();
  await a.page.getByRole("button", { name: "＋ 新任务" }).click();
  await shot(a.app, "18-new-task-dialog");
  await a.page.getByPlaceholder("比如：加特林").fill("加特林");
  await a.page.locator(".dialog textarea").fill("按住连射，射速逐步升高，会过热。");
  await a.page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(a.page.locator(".head-title")).toHaveText("加特林");
  // Files (2c): the designdoc goes into the task, and along with the session.
  await a.page.locator(".pane input[type=file]").setInputFiles({ name: "designdoc.md", mimeType: "text/markdown", buffer: Buffer.from("# 加特林\n\n基础射速每秒 12 发，按住 2 秒后升到 20 发。\n\n连续射击 6 秒进入过热。") });
  await expect(a.page.locator(".file-row")).toContainText("designdoc.md");
  await a.page.locator(".session-list").getByTitle("在这个任务下新建会话").click();
  await expect(a.page.locator(".att-pick .att.on")).toContainText("designdoc.md v1");
  await shot(a.app, "17-new-session-dialog");
  await expect(a.page.locator('.dialog [aria-label="所属任务"] [aria-checked="true"]')).toHaveText("加特林");
  await a.page.getByPlaceholder("一句话说清要对方处理什么").fill("射速和过热怎么做");
  await a.page.locator(".dialog textarea").fill("设计见任务说明。");
  await a.page.getByPlaceholder("问题").fill("推进方式");
  await a.page.getByPlaceholder("选项，用逗号隔开（可不填）").fill("策划在主分支直接推进, 程序接手开发");
  await a.page.getByRole("button", { name: "发出" }).click();
  await expect(a.page.locator(".session-list .srow", { hasText: "射速和过热怎么做" })).toContainText("在 程序老李 手里");
  await shot(a.app, "11-task-page");

  await b.page.locator(".view-tab", { hasText: "待处理" }).click();
  await row(b.page, "射速和过热怎么做").click();
  await expect(b.page.locator(".page-crumb")).toContainText("任务 · 加特林");

  // Notes (2d): the coder opens the attachment, selects a passage and notes it.
  await b.page.locator(".atts .att", { hasText: "designdoc.md" }).click();
  await expect(b.page.locator(".md-doc")).toContainText("基础射速每秒 12 发");
  await b.page.evaluate((quote) => {
    const root = document.querySelector(".md-doc")!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(quote);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + quote.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
  }, "每秒 12 发");
  await b.page.getByRole("button", { name: "写批注" }).click();
  await b.page.getByPlaceholder("写意见，比如：这里配成表更好调").fill("升速曲线建议配表");
  await b.page.locator(".note.new").getByRole("button", { name: "保存" }).click();
  await expect(b.page.locator(".notes-pane .note").first()).toContainText("每秒 12 发");
  await expect(b.page.locator(".notes-pane .note").first()).toContainText("升速曲线建议配表");
  await shot(b.app, "15-viewer");
  await b.page.locator(".viewer-foot").getByRole("button", { name: "完成", exact: true }).click();

  // An HTML file in the session: its script does not run unless asked to.
  await b.page.locator(".atts input[type=file]").setInputFiles({ name: "原型.html", mimeType: "text/html", buffer: Buffer.from("<p>原型说明：枪管发红</p><script>document.body.insertAdjacentHTML('beforeend', '<b>脚本运行了</b>')</script>") });
  await b.page.locator(".atts .att", { hasText: "原型.html" }).click();
  const proto = b.page.frameLocator(".doc-frame").locator("body");
  await expect(proto).toContainText("原型说明：枪管发红");
  await expect(proto).not.toContainText("脚本运行了");
  await b.page.getByRole("button", { name: "不运行脚本 · 可批注" }).click();
  await expect(proto).toContainText("脚本运行了");
  await b.page.locator(".dialog.viewer .x").click();
  await expect(b.page.locator(".reply-form")).toContainText("附上我的批注（1）");
  await expect(b.page.getByRole("button", { name: "标记完成" })).toHaveCount(0);
  await b.page.getByRole("button", { name: "接手任务…" }).click();
  await b.page.getByPlaceholder("比如：涉及武器底层，我来改接口").fill("涉及武器底层，我来改接口");
  await shot(b.app, "12-takeover");
  await b.page.getByRole("button", { name: "接手", exact: true }).click();
  await expect(b.page.locator(".msg.kind-reply").last()).toContainText("我接手了这个任务（开发中）：涉及武器底层");
  await expect(a.page.locator(".head-meta").first()).toContainText("在 程序老李 手里");
  await a.page.locator(".session-list .nav-row", { hasText: "记录" }).click();
  await expect(a.page.locator(".log")).toContainText("接手任务 · 开发中 · 原因：涉及武器底层，我来改接口");
  await expect(a.page.locator(".log")).toContainText("上传 designdoc.md v1");

  // The planner asks again in that session; the coder answers with the form and sends the note along.
  await a.page.locator(".session-list .srow", { hasText: "射速和过热怎么做" }).click();
  // A follow-up with a new round: only its questions are in the form.
  await a.page.getByPlaceholder("继续追问 程序老李…（发出后会话回到对方手里）").fill("再定一下推进方式");
  await a.page.getByRole("button", { name: "＋ 加逐条回答的问题" }).click();
  await a.page.locator(".followup").getByPlaceholder("问题").fill("推进方式定哪个");
  await a.page.locator(".followup").getByPlaceholder("选项，用逗号隔开（可不填）").fill("程序接手开发, 策划拉独立分支");
  await a.page.getByRole("button", { name: "继续追问" }).click();
  await row(b.page, "射速和过热怎么做").click();
  await expect(b.page.locator(".reply-form .rq")).toHaveCount(1);
  await expect(b.page.locator(".reply-form .rq")).toContainText("推进方式定哪个");
  await b.page.locator(".reply-form .opt", { hasText: "程序接手开发" }).click();
  await expect(b.page.locator(".reply-form")).toContainText("附上我的批注（1）");
  await b.page.getByRole("button", { name: "回复并返回给 策划小王" }).click();
  await expect(a.page.locator(".msg.kind-reply").last()).toContainText("推进方式定哪个");
  await expect(a.page.locator(".msg.kind-reply .notes-in").last()).toContainText("升速曲线建议配表");
  await expect(a.page.locator(".msg.kind-reply .notes-in").last()).toContainText("designdoc.md v1：每秒 12 发");
  await shot(a.app, "16-reply-notes");

  // The coder hands it back: 待处理 for the planner, gone once opened.
  await a.page.locator(".view-tab", { hasText: "待处理" }).click();
  await b.page.locator(".view-tab", { hasText: "任务" }).click();
  await b.page.locator(".card", { hasText: "加特林" }).click();
  await b.page.getByRole("button", { name: "流转…" }).click();
  await b.page.locator('.dialog [aria-label="交给"]').getByRole("radio", { name: /策划小王/ }).click();
  await b.page.locator('.dialog [aria-label="状态"]').getByRole("radio", { name: "待处理" }).click();
  await b.page.getByPlaceholder("比如：涉及武器底层，我来改接口").fill("接口改好了，请验收");
  await b.page.getByRole("button", { name: "流转", exact: true }).click();
  await a.page.locator(".view-tab", { hasText: "待处理" }).click();
  await expect(a.page.locator(".scope-nav .srow", { hasText: "任务交给你：加特林" })).toContainText("接口改好了，请验收");
  await shot(a.app, "13-handed");
  await a.page.locator(".scope-nav .srow", { hasText: "任务交给你：加特林" }).click();
  await expect(a.page.locator(".head-meta").first()).toContainText("在 策划小王 手里");
  await a.page.locator(".view-tab", { hasText: "待处理" }).click();
  await expect(a.page.locator(".scope-nav .srow", { hasText: "任务交给你" })).toHaveCount(0);

  // Finished and archived; the board says so.
  await a.page.locator(".view-tab", { hasText: "任务" }).click();
  await a.page.locator(".nav-row", { hasText: "全部任务" }).click();
  await expect(a.page.locator(".column", { hasText: "待处理" }).locator(".card")).toContainText("加特林");
  await shot(a.app, "14-board");
  await a.page.locator(".card", { hasText: "加特林" }).click();
  await a.page.getByRole("button", { name: "编辑" }).click();
  await a.page.locator('.editor [aria-label="状态"]').getByRole("radio", { name: "已完成" }).click();
  await a.page.getByRole("button", { name: "保存" }).click();
  await a.page.locator(".head-actions").getByRole("button", { name: "归档" }).click();
  await a.page.getByRole("button", { name: "任务", exact: true }).first().click();
  await expect(a.page.getByRole("button", { name: "已归档 1" })).toBeVisible();

  // 设置 · 团队流程: the flow document goes up to the service (its copy button works, scripts allowed), a phrase is added.
  await a.page.getByRole("button", { name: "设置", exact: true }).click();
  await a.page.locator(".settings-nav").getByRole("button", { name: "团队流程" }).click();
  const flowHtml = `<!doctype html><html><head><title>流程</title></head><body><h1>团队流程</h1><button id="copy" onclick="navigator.clipboard.writeText('按团队流程推进这个任务')">复制提示词</button></body></html>`;
  await a.page.locator('.flow-card input[type="file"]').setInputFiles({ name: "团队流程.html", mimeType: "text/html", buffer: Buffer.from(flowHtml) });
  await expect(a.page.locator(".flow-card")).toContainText("第 1 版");
  await a.page.locator(".kw-add").fill("先做一个可玩的原型");
  await a.page.keyboard.press("Enter");
  await shot(a.app, "21-settings-flow");
  await a.page.locator(".dialog-foot").getByRole("button", { name: "保存" }).click();
  await b.page.getByRole("button", { name: "流程速查" }).click();
  await expect(b.page.locator(".dialog")).toContainText("先做一个可玩的原型");
  await b.page.locator(".dialog").getByRole("button", { name: "好" }).click();
  const flowShortcut = b.page.locator(".shortcut", { hasText: "团队流程" });
  await expect(flowShortcut).toContainText("有更新");
  await flowShortcut.click();
  await b.page.frameLocator(".doc-frame").locator("#copy").click();
  await expect(b.page.locator(".toast")).toHaveText("已复制");
  expect(await b.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("按团队流程推进这个任务");
  await b.page.locator(".viewer-foot").getByRole("button", { name: "完成" }).click();
  await expect(flowShortcut).not.toContainText("有更新");

  // Direct chat both ways, from 成员.
  await b.page.locator(".view-tab", { hasText: "成员" }).click();
  await b.page.locator(".nav-row", { hasText: "策划小王" }).click();
  await b.page.getByRole("button", { name: "私聊" }).click();
  await b.page.getByPlaceholder("发给 策划小王…").fill("下午三点对一下数值？");
  await b.page.keyboard.press("Control+Enter");
  await a.page.locator(".view-tab", { hasText: "聊天" }).click();
  await a.page.locator(".person-node", { hasText: "程序老李" }).locator(".srow", { hasText: "普通聊天" }).click();
  await expect(a.page.locator(".msg.theirs")).toContainText("下午三点对一下数值？");
  await expect(a.page.locator(".topbar .win-controls")).toBeVisible();
  await shot(a.app, "05-direct-chat");

  // Topics next to the plain chat: each its own conversation; mine on the right, theirs on the left.
  await a.page.getByRole("button", { name: "＋ 新话题" }).click();
  await a.page.getByPlaceholder("话题，比如：技能表结构").fill("数值平衡");
  await a.page.getByRole("button", { name: "开始" }).click();
  await expect(a.page.locator(".head-title")).toHaveText("数值平衡");
  await a.page.getByPlaceholder("发给 程序老李…").fill("这个单独聊：暴击率上限定多少？");
  await a.page.keyboard.press("Control+Enter");
  await expect(a.page.locator(".msg.mine")).toContainText("暴击率上限");
  await row(b.page, "数值平衡").click();
  await expect(b.page.locator(".msg.theirs")).toContainText("暴击率上限");
  await expect(b.page.locator(".person-node", { hasText: "策划小王" }).locator(".srow", { hasText: "普通聊天" })).toBeVisible();
  await b.page.getByPlaceholder("发给 策划小王…").fill("先定 **60%**，超了收益太高");
  await b.page.keyboard.press("Control+Enter");
  await expect(a.page.locator(".msg.theirs")).toContainText("超了收益太高");
  const sides = await a.page.locator(".msg .msg-body").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  expect(sides[0]).toBeGreaterThan(sides[1]! + 50);
  await shot(a.app, "08-topic");

  // Archived on the planner's side only; the coder's next message brings it back.
  await a.page.locator(".head-actions").getByRole("button", { name: "归档" }).click();
  await expect(a.page.locator(".nav-fold", { hasText: "已归档 1" })).toBeVisible();
  await expect(b.page.locator(".nav-fold", { hasText: "已归档" })).toHaveCount(0);
  await shot(a.app, "09-archived");
  await b.page.getByPlaceholder("发给 策划小王…").fill("暴击伤害另说");
  await b.page.keyboard.press("Control+Enter");
  await expect(a.page.locator(".nav-fold", { hasText: "已归档" })).toHaveCount(0);

  // A group: @-ing someone into the plain chat brings them in, history and all; it shows under each of its people.
  const zhou = await new relay.RelayClient(server.url).register("美术小周", "pw-1234", { role: "美术" });
  await a.page.locator(".person-node", { hasText: "程序老李" }).locator(".srow", { hasText: "普通聊天" }).click();
  await a.page.getByPlaceholder("发给 程序老李…").fill("@美");
  await expect(a.page.locator(".mention-pop")).toContainText("美术小周");
  await a.page.keyboard.press("Enter");
  await a.page.keyboard.type("来看看枪管过热的特效");
  await a.page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(a.page.locator(".dialog")).toContainText("这个对话会变成群聊");
  await a.page.getByRole("button", { name: "拉进来并发送" }).click();
  await expect(a.page.locator(".page-crumb")).toHaveText("群聊");
  await expect(a.page.locator(".faces .face")).toHaveCount(3);
  await expect(a.page.locator(".msg").last()).toContainText("@美术小周");
  await shot(a.app, "19-group");
  await expect(b.page.locator(".person-node", { hasText: "策划小王" })).toContainText("群聊 · 1");
  const zhouClient = new relay.RelayClient(server.url, zhou.key);
  const [group] = (await zhouClient.threads()).filter((t) => t.kind === "group");
  expect((await zhouClient.messages(group!.id)).messages.map((m) => m.body)).toContain("下午三点对一下数值？");
  await b.page.locator(".view-tab", { hasText: "成员" }).click();
  await expect(b.page.locator(".scope-nav .srow", { hasText: "美术小周" })).toContainText("3 人");
  await b.page.locator(".view-tab", { hasText: "聊天" }).click();

  // 我的资料 (2026-10-28): shown here, edited in AMO 平台's 账号 — the me-chip opens it with no way to edit.
  await a.page.locator(".me-chip").click();
  const mine = a.page.locator(".settings-dialog");
  await expect(mine.locator(".settings-nav [aria-current=page]")).toHaveText("我的资料");
  await expect(mine.getByTestId("profile-in-platform")).toHaveText("在 AMO 平台的「账号」里改昵称、头像和负责什么，改完这里会跟着变。");
  await expect(mine.getByRole("button", { name: "编辑资料" })).toHaveCount(0);
  await expect(mine.locator("input")).toHaveCount(0);
  // The platform's way (@amo-studio/account's updateProfile, with this account's key): a nickname shows first, the
  // account name faintly after it, in the open client and the other one, without a restart.
  const planner = await new relay.RelayClient(server.url).login("策划小王", "pw-1234");
  await account.updateProfile({ server: server.url, key: planner.key }, { nick: "小王" });
  await expect(mine.locator(".me-card b")).toHaveText("小王(策划小王)");
  await shot(a.app, "20-profile");
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator(".me-chip .me-name")).toHaveText("小王(策划小王)");
  await expect(b.page.locator(".person-node", { hasText: "策划小王" }).locator(".aka")).toHaveText("(策划小王)");

  // A newer client on the service: the planner restarts and the loader installs it before the login screen.
  const manifestFile = join(publicDir, "client", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { version: string };
  const publish = (version: string) => writeFileSync(manifestFile, JSON.stringify({ ...manifest, version }));
  const next = `${manifest.version}-next`;
  publish(next);
  await a.app.close();
  const again = await launch("planner");
  await expect(again.page.locator(".login-foot")).toContainText(next, { timeout: 30_000 });
  await expect(again.page.locator(".notice.update")).toHaveCount(0);
  await expect(again.page.locator(".server-line")).toContainText("服务器在线");
  await expect(again.page.getByLabel("密码", { exact: true })).toHaveValue("pw-1234");
  await again.page.getByRole("button", { name: "登录" }).click();
  await again.page.locator(".view-tab", { hasText: "聊天" }).click();
  await row(again.page, "数值平衡").click();
  const myState = again.page.locator(".me-chip .conn-chip");
  await expect(myState).toHaveText("服务器在线");

  // Published while signed in: even with the window in the tray (not in use) it waits — the bottom left offers it; a
  // click updates and comes back signed in, the same conversation open.
  const third = `${manifest.version}-third`;
  publish(third);
  await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  const updateStrip = again.page.locator(".strip", { hasText: "有新版本" });
  await expect(updateStrip).toContainText(third, { timeout: 15_000 });
  await again.page.waitForTimeout(7000);
  expect(await again.page.evaluate(async () => (await (window as unknown as { relayShell: { info(): Promise<{ contentVersion: string }> } }).relayShell.info()).contentVersion)).not.toBe(third);
  await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive());
  await updateStrip.click();
  await expect.poll(() => again.page.evaluate(async () => (await (window as unknown as { relayShell: { info(): Promise<{ contentVersion: string }> } }).relayShell.info()).contentVersion).catch(() => "reloading"), { timeout: 30_000 }).toBe(third);
  await expect(again.page.locator(".scope-nav .srow[aria-current=true]")).toContainText("数值平衡", { timeout: 15_000 });
  await expect(again.page.locator(".head-title")).toHaveText("数值平衡");
  await expect(updateStrip).toHaveCount(0);

  // The service goes away: the bar over the conversation, members' state unknown; the other one logs out and its
  // login screen says the service is offline. It comes back: both see it without doing anything.
  const port = server.port;
  await server.close();
  await expect(again.page.locator(".strip.error")).toContainText("服务器离线", { timeout: 15_000 });
  await expect(myState).toHaveText("服务器离线");
  await again.page.locator(".view-tab", { hasText: "成员" }).click();
  await expect(again.page.locator(".scope-nav")).toContainText("在线状态未知");
  await shot(again.app, "06-offline-bar");
  await b.page.getByRole("button", { name: "设置", exact: true }).click();
  await b.page.locator(".settings-nav").getByRole("button", { name: "我的资料" }).click();
  await b.page.getByRole("button", { name: "退出登录" }).click();
  await expect(b.page.locator(".server-down")).toContainText("服务器离线", { timeout: 15_000 });
  await expect(b.page.getByRole("button", { name: /服务器离线/ })).toBeDisabled();
  await shot(b.app, "07-login-offline");
  server = await startServer(port);
  await again.page.locator(".strip.error").click();
  await expect(again.page.locator(".strip.error")).toHaveCount(0, { timeout: 15_000 });
  await expect(myState).toHaveText("服务器在线");
  await expect(b.page.locator(".server-line")).toContainText("服务器在线", { timeout: 15_000 });
  await b.page.getByRole("button", { name: "登录" }).click();
  await expect(b.page.locator(".view-tabs")).toBeVisible();

  // Both themes: Studio's dark one too.
  // 设置 · 通用: dark, and a bigger font for the text.
  await b.page.getByRole("button", { name: "设置", exact: true }).click();
  await b.page.getByRole("radio", { name: "深色" }).click();
  await b.page.getByRole("radio", { name: /^大/ }).click();
  await expect(b.page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await b.page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("15px");
  await shot(b.app, "22-settings-general");
  await b.page.keyboard.press("Escape");
  await b.page.locator(".view-tab", { hasText: "待处理" }).click();
  await b.page.locator(".nav-fold", { hasText: "已完成" }).click();
  await row(b.page, "技能冷却按等级递减").click();
  await shot(b.app, "10-dark-session");
  expect(pageErrors).toEqual([]);
});

test("tightened: an AI's session answered over two rounds, closed by the AI; no tasks, no 新会话", async () => {
  const a = await launch("planner2");
  await register(a.page, "策划小张", "策划", false);
  const b = await launch("coder2");
  await register(b.page, "程序老赵", "程序 · 系统", false);
  for (const p of [a.page, b.page]) {
    await expect(p.locator(".view-tab")).toHaveText(["待处理", "聊天", "成员"]);
    await expect(p.getByRole("button", { name: /＋ 新/ })).toHaveCount(0);
    await expect(p.locator(".shortcut")).toHaveText(["复制用法"]);
  }
  await a.page.getByRole("button", { name: "复制用法" }).click();
  const usageFile = join(a.home, "AMO中转用法.md");
  await expect.poll(() => existsSync(usageFile) && readFileSync(usageFile, "utf8").includes("策划小张")).toBe(true);
  const usage = readFileSync(usageFile, "utf8");
  expect(usage).not.toContain("newtask");
  expect(usage).toContain("`relay put <本机文件> --thread <threadId>`");
  expect(usage).toContain("发完就结束这一轮");
  expect(usage).not.toContain("wait <threadId>");

  // The planner's AI hits a snag: it asks the coder, with its designdoc in the session, and ends its turn.
  const cli = join(a.home, "amo-relay.cmd");
  const req = join(root, "req2.json");
  writeFileSync(req, JSON.stringify({ to: "程序老赵", title: "背包格子上限怎么存", body: "打算把上限写死在客户端常量里，**每升 10 级 +5 格**。", questions: [{ text: "上限放哪", options: ["客户端常量", "服务端配置表"] }] }));
  const threadId = /threadId: (\S+)/.exec(await exec("cmd.exe", ["/c", cli, "ask", "--json", req]))![1]!;
  const doc = join(root, "bag-design.md");
  writeFileSync(doc, "# 背包\n\n初始 40 格，每升 10 级 +5 格。");
  expect(await exec("cmd.exe", ["/c", cli, "put", doc, "--thread", threadId])).toContain("已上传 bag-design.md v1");

  // The coder: told it waits on them; the session has the attachment; only 回复并返回 — no task to take over.
  const row = (page: Page, text: string) => page.locator(".scope-nav .srow", { hasText: text });
  await expect(b.page.locator(".strip.attn")).toContainText("1 件等你处理");
  await expect(row(b.page, "背包格子上限怎么存")).toContainText("等你处理");
  await row(b.page, "背包格子上限怎么存").click();
  await expect(b.page.locator(".page-crumb")).toHaveText("待处理");
  await expect(b.page.locator(".atts .att", { hasText: "bag-design.md" })).toBeVisible();
  await expect(b.page.getByRole("button", { name: /接手任务/ })).toHaveCount(0);
  await expect(b.page.getByRole("button", { name: "标记完成" })).toHaveCount(0);
  await b.page.locator(".reply-form .opt", { hasText: "服务端配置表" }).click();
  await b.page.getByPlaceholder("补充说明（支持 Markdown）").fill("运营会调上限，放配置表；客户端从登录数据里取。");
  await b.page.locator(".vbtn", { hasText: "需要改" }).click();
  await shot(b.app, "30-tight-reply");
  await b.page.getByRole("button", { name: "回复并返回给 策划小张 的 AI" }).click();
  await expect(row(b.page, "背包格子上限怎么存")).toContainText("已返回给 策划小张");

  // The planner sees it waiting on them and copies it over to the AI, with what to do next.
  await expect(a.page.locator(".strip.attn")).toContainText("1 件等你处理");
  await expect(row(a.page, "背包格子上限怎么存")).toContainText("回复已到 · 复制给 AI 继续");
  await row(a.page, "背包格子上限怎么存").click();
  await expect(a.page.locator(".aiband")).toContainText("程序老赵 回复了");
  await shot(a.app, "33-tight-planner-back");
  await a.page.locator(".aiband").getByRole("button", { name: "复制给 AI" }).click();
  await expect.poll(() => a.app.evaluate(({ clipboard }) => clipboard.readText())).toContain(`程序老赵 回复了你发的会话（threadId ${threadId}）`);
  expect(await a.app.evaluate(({ clipboard }) => clipboard.readText())).toContain("**上限放哪** → 服务端配置表");

  // The AI reads it and asks again with a new round; the coder answers that one too.
  expect(await exec("cmd.exe", ["/c", cli, "replies", threadId])).toContain("**上限放哪** → 服务端配置表");
  await expect(row(a.page, "背包格子上限怎么存")).toContainText("AI 已取回");
  const qs = join(root, "qs2.json");
  writeFileSync(qs, JSON.stringify([{ text: "配置表用哪张", options: ["player_level", "新建 bag_limit"] }]));
  expect(await exec("cmd.exe", ["/c", cli, "send", threadId, "--body", "好，改放配置表。", "--then", "ask", "--questions", qs])).toContain("会话回到对方手里");
  await expect(row(b.page, "背包格子上限怎么存")).toContainText("等你处理");
  await expect(b.page.locator(".reply-form")).toContainText("配置表用哪张");
  await b.page.locator(".reply-form .opt", { hasText: "新建 bag_limit" }).click();
  await b.page.getByRole("button", { name: "回复并返回给 策划小张 的 AI" }).click();

  // Settled: the AI closes it; both see it done.
  expect(await exec("cmd.exe", ["/c", cli, "replies", threadId])).toContain("**配置表用哪张** → 新建 bag_limit");
  expect(await exec("cmd.exe", ["/c", cli, "send", threadId, "--body", "按 bag_limit 表做，谢谢。", "--then", "done"])).toContain("已标记完成");
  await expect(b.page.getByRole("button", { name: "重新打开" })).toBeVisible();
  await expect(b.page.locator(".strip.calm")).toContainText("没有等你处理的");
  await a.page.locator(".nav-fold", { hasText: "已完成" }).click();
  await row(a.page, "背包格子上限怎么存").click();
  await expect(a.page.locator(".msg.kind-reply")).toHaveCount(2);
  await shot(a.app, "31-tight-planner-done");

  // Between people: a chat, not a session.
  await b.page.locator(".view-tab", { hasText: "成员" }).click();
  await b.page.locator(".nav-row.person", { hasText: "策划小张" }).click();
  await expect(b.page.getByRole("button", { name: "私聊" })).toBeVisible();
  await expect(b.page.getByRole("button", { name: "发起会话" })).toHaveCount(0);
  await shot(b.app, "32-tight-member");
  expect(pageErrors).toEqual([]);
});

test("what waits shows outside the window: the taskbar flashes with the count, the tray blinks with it; started by the platform, in attention.json", async () => {
  type Shown = { flashing: boolean; overlay: number; trayBadge: boolean; tooltip: string; count: number; inUse: boolean; blinking: boolean };
  const shown = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __relayAttention: () => Shown }).__relayAttention());
  // The planner runs on its own (its own tray); the coder as AMO 平台 starts it (no tray, the count in a file).
  const a = await launch("planner3");
  await register(a.page, "策划小周", "策划", false);
  const b = await launch("coder3", ["--amo-tray=platform"]);
  await register(b.page, "程序老吴", "程序", false);
  const file = join(b.home, "attention.json");
  const attention = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { count: number; blink: boolean; pid: number }) : null);
  expect(await shown(b.app)).toMatchObject({ count: 0, overlay: 0, blinking: false });

  // An AI's session waiting on the coder: 1, flashing and blinking (a test window is never focused: nobody looks).
  const req = join(root, "req3.json");
  writeFileSync(req, JSON.stringify({ to: "程序老吴", title: "掉落表要不要分服", body: "想分服配，可以吗？" }));
  const threadId = /threadId: (\S+)/.exec(await exec("cmd.exe", ["/c", join(a.home, "amo-relay.cmd"), "ask", "--json", req]))![1]!;
  await expect(b.page.locator(".strip.attn")).toContainText("1 件等你处理");
  await expect.poll(() => shown(b.app)).toMatchObject({ count: 1, overlay: 1, flashing: true, blinking: true, tooltip: "AMO 中转 · 1 条待处理 / 未读" });
  const pid = await b.app.evaluate(() => process.pid);
  await expect.poll(attention).toEqual({ count: 1, blink: true, pid, at: expect.any(String) as unknown as string });
  // Looked at: no more flashing or blinking, the count stays (the platform's icon stops blinking, keeps the count).
  await b.app.evaluate(({ BrowserWindow }) => {
    // A test window cannot take focus: told so, as if it had.
    const w = BrowserWindow.getAllWindows()[0]!;
    (w as unknown as { isFocused: () => boolean }).isFocused = () => true;
    w.emit("focus");
  });
  await expect.poll(() => shown(b.app)).toMatchObject({ count: 1, inUse: true, flashing: false, blinking: false, overlay: 1 });
  await expect.poll(attention).toMatchObject({ count: 1, blink: false });

  // Answered: nothing waits on the coder; the planner (its own tray) has the reply waiting, blinking there.
  const row = (page: Page, text: string) => page.locator(".scope-nav .srow", { hasText: text });
  await row(b.page, "掉落表要不要分服").click();
  await b.page.getByPlaceholder("补充说明（支持 Markdown）").fill("可以，按服读配置。");
  await b.page.getByRole("button", { name: "回复并返回给 策划小周 的 AI" }).click();
  await expect.poll(() => shown(b.app)).toMatchObject({ count: 0, overlay: 0, blinking: false });
  await expect.poll(attention).toMatchObject({ count: 0, blink: false });
  await expect(a.page.locator(".strip.attn")).toContainText("1 件等你处理");
  await expect.poll(() => shown(a.app)).toMatchObject({ count: 1, overlay: 1, trayBadge: expect.any(Boolean) as unknown as boolean, blinking: true });
  // Started on its own it writes no file for the platform.
  expect(existsSync(join(a.home, "attention.json"))).toBe(false);
  expect(threadId).toBeTruthy();

  // The coder's client quits: the file goes with it.
  await b.app.close();
  expect(existsSync(file)).toBe(false);
  expect(pageErrors).toEqual([]);
});

test("a moved service: the last 3 servers offered, the last one picked; accounts saved for the old address still sign in", async () => {
  const first = await launch("mover");
  await register(first.page, "搬家小周", "测试", false);
  await first.app.close();
  // The service "moved": the one used last is gone, the same one is now at another address (localhost), and the list
  // holds four addresses, of which three are offered.
  const port = new URL(server.url).port;
  const moved = `http://localhost:${port}`;
  const gone = "http://127.0.0.1:1";
  writeFileSync(join(root, "mover", "shell.json"), JSON.stringify({ server: gone, recent: [gone, moved, server.url, "http://127.0.0.1:2"] }));
  const again = await launch("mover");
  const page = again.page;
  await expect(page.locator(".server-down")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "更换" }).click();
  const rows = page.locator("#recent button");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("127.0.0.1:1");
  await expect(rows.nth(0)).toContainText("上次连接");
  await expect(rows.nth(0)).toHaveClass(/on/);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveClass(/on/);
  await expect(page.locator("#server")).toHaveValue(moved);
  await shot(again.app, "34-recent-servers");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByText("这些账号是在别的服务器地址上记住的")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("名字")).toHaveValue("搬家小周");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".view-tabs")).toBeVisible();
  const saved = JSON.parse(readFileSync(join(root, "mover", "shell.json"), "utf8")) as { server: string; recent: string[] };
  expect(saved).toEqual({ server: moved, recent: [moved, gone, server.url] });
  expect(pageErrors).toEqual([]);
});

/** Every file under `dir` (relative), node_modules left out. */
function filesIn(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? filesIn(dir, join(rel, e.name)) : [join(rel, e.name)]));
}

// Last: it puts a desktop program zip on the service and, for a while, content that needs a newer shell.
test("installed by AMO 平台: no 更新桌面程序 (the platform updates the shell), a newer shell is asked for there, nothing written into its folder", async () => {
  // The program folder as the platform installs it (package-portable.mjs --platform): resources/app/package.json says
  // amoBuild.mode "platform"; the dependencies come from the checkout (a junction), Electron is the dev one.
  const program = join(root, "apps", "relay", "0.9.0");
  const app = join(program, "resources", "app");
  const pkg = join(studio, "packages", "relay-app");
  mkdirSync(join(app, "packages", "relay-app"), { recursive: true });
  cpSync(join(pkg, "dist"), join(app, "packages", "relay-app", "dist"), { recursive: true });
  cpSync(join(pkg, "assets"), join(app, "packages", "relay-app", "assets"), { recursive: true });
  cpSync(join(pkg, "package.json"), join(app, "packages", "relay-app", "package.json"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "amo-relay", version: "0.9.0", type: "module", amoBuild: { mode: "platform", runtime: "44.7.0" } }));
  symlinkSync(join(studio, "node_modules"), join(app, "node_modules"), "junction");
  const before = filesIn(program).sort();
  // The service hands out a desktop program zip (for the unpacked clients): a client from the sources offers it, the
  // platform's never does.
  const downloads = join(publicDir, "downloads");
  mkdirSync(downloads, { recursive: true });
  writeFileSync(join(downloads, "AMO-Relay-win.zip"), "zip");
  writeFileSync(join(downloads, "AMO-Relay-win.json"), JSON.stringify({ build: "2026.10.28-120000", size: 3, sha256: "0".repeat(64) }));
  const manifestFile = join(publicDir, "client", "manifest.json");
  const manifest = readFileSync(manifestFile, "utf8");
  try {
    const launchFrom = async (main: string, who: string) => {
      const a = await _electron.launch({ executablePath: electronPath, args: [main, "--server", server.url], env: { ...process.env, AMO_RELAY_HOME: join(root, who), AMO_HOME: join(root, who, "amo-home"), AMO_RELAY_TEST: "1" } });
      apps.push(a);
      const page = await a.firstWindow();
      page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.stack ?? e.message}`));
      return { app: a, page };
    };
    // Login lives in the platform (2026-10-29, AGENTS.md rule 7): logged in there, the client signs in by itself, no form.
    const zhao = store.register("平台小赵", "pw-1234", "策划");
    const zhaoHome = { env: { AMO_HOME: join(root, "platform-user", "amo-home") } };
    await account.saveAccount({ server: server.url, name: zhao.name, key: zhao.key }, zhaoHome);
    const fromPlatform = await launchFrom(join(app, "packages", "relay-app", "dist", "main.js"), "platform-user");
    await expect(fromPlatform.page.locator(".view-tabs")).toBeVisible({ timeout: 30_000 });
    await expect(fromPlatform.page.getByRole("button", { name: "没有账号？注册一个" })).toHaveCount(0);
    // Its MCP and command line use that account too.
    expect(JSON.parse(readFileSync(join(root, "platform-user", "settings.json"), "utf8"))).toMatchObject({ name: "平台小赵", key: zhao.key });
    // Nobody logged in there: where to log in, no form; logged in later, it signs in by itself; logged out there, so here.
    const later = await launchFrom(join(app, "packages", "relay-app", "dist", "main.js"), "platform-later");
    await expect(later.page.getByTestId("platform-login")).toContainText("在 AMO 平台里登录", { timeout: 30_000 });
    await expect(later.page.getByRole("button", { name: "没有账号？注册一个" })).toHaveCount(0);
    await shot(later.app, "43-platform-login-there");
    const sun = store.register("平台小孙", "pw-1234", "程序");
    const sunHome = { env: { AMO_HOME: join(root, "platform-later", "amo-home") } };
    await account.saveAccount({ server: server.url, name: sun.name, key: sun.key }, sunHome);
    await expect(later.page.locator(".view-tabs")).toBeVisible({ timeout: 20_000 });
    account.clearAccount(sunHome);
    await expect(later.page.getByTestId("platform-login")).toBeVisible({ timeout: 20_000 });
    await later.app.close();
    const dev = await launch("dev-user");
    await register(dev.page, "源码小钱", "程序", false);
    type Info = { updatedBy?: string; shellBuild?: string };
    const info = (page: Page) => page.evaluate(async () => (await (window as unknown as { relayShell: { info(): Promise<Info> } }).relayShell.info()) as Info);
    expect(await info(fromPlatform.page)).toMatchObject({ updatedBy: "platform" });
    expect((await info(fromPlatform.page)).shellBuild).toBeUndefined();
    expect((await info(dev.page)).updatedBy).toBeUndefined();
    // The one from the sources is offered the service's desktop program; the platform's is not, and refuses to swap.
    await expect(dev.page.getByText("桌面程序可更新").first()).toBeVisible({ timeout: 15_000 });
    await expect(fromPlatform.page.getByText("桌面程序可更新")).toHaveCount(0);
    const refused = await fromPlatform.page.evaluate(() => (window as unknown as { relayShell: { updateShell(): Promise<void> } }).relayShell.updateShell().then(() => "updated", (e: Error) => e.message));
    expect(refused).toContain("这个 AMO 中转是 AMO 平台装的，桌面程序在 AMO 平台的「工具」里更新");
    await shot(fromPlatform.app, "40-platform-no-shell-update");

    // Content that needs a newer shell: the platform's client is pointed at the platform, not at a download page.
    const parsed = JSON.parse(manifest) as { version: string; minShell: number };
    writeFileSync(manifestFile, JSON.stringify({ ...parsed, version: `${parsed.version}-next`, minShell: 99 }));
    await expect(fromPlatform.page.getByText("要新的桌面程序，在 AMO 平台的「工具」里更新 AMO 中转").first()).toBeVisible({ timeout: 15_000 });
    await expect(dev.page.getByText("要换新的桌面程序").first()).toBeVisible({ timeout: 15_000 });
    await shot(fromPlatform.app, "41-platform-new-shell");
    // A first start then: the loader says the same, with no download page to open.
    const fresh = await launchFrom(join(app, "packages", "relay-app", "dist", "main.js"), "platform-fresh");
    await expect(fresh.page.locator("#errText")).toHaveText("服务器上的客户端要新的桌面程序：在 AMO 平台的「工具」里更新 AMO 中转。", { timeout: 30_000 });
    await expect(fresh.page.locator("#download")).toBeHidden();
    // capturePage on this third window can fail (UnknownVizError); the page's own screenshot does not.
    await fresh.page.screenshot({ path: join(shots, "42-platform-loader-new-shell.png") });

    // Its MCP and command line run its exe (a platform install's `current`, unit-tested in build-mode.test.ts), and
    // nothing was written into its program folder: no build stamp, no …amo-old files, no update.log.
    expect(readFileSync(join(root, "platform-user", "amo-relay.cmd"), "utf8")).toContain(electronPath);
    expect(filesIn(program).sort()).toEqual(before);
    expect(pageErrors).toEqual([]);
  } finally {
    writeFileSync(manifestFile, manifest);
    rmSync(downloads, { recursive: true, force: true });
    // The junction goes as a link (rmSync never walks into it), before afterAll removes the rest.
    rmSync(join(app, "node_modules"), { recursive: true, force: true });
  }
});
