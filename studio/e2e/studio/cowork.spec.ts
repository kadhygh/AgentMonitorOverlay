import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication } from "@playwright/test";
import type { CoworkJoin, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 协作 (2026-11-23, plans/cowork.md 第 4 步): the planner brings a Studio session into a 协作 the coder started on AMO 中转 (a
// relay service started here, never the team server); its line shows how its AI stands there; the coder @-s it and the
// message comes into the conversation folded as the 协作's, with 在中转里打开; the AI answers there with cowork_post; the
// coder asks the planner in a 子会话, which the 中转 client hands to Studio (转到我的会话) and a session here takes.

const relay = (await import(pathToFileURL(join(studioRoot, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");
const account = (await import(pathToFileURL(join(studioRoot, "packages", "account", "dist", "index.js")).href)) as typeof import("../../packages/account/src/index.js");

const lastCopied = (app: ElectronApplication) => app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1));

let root = "";
let store: InstanceType<typeof relay.RelayStore> | undefined;
let server: Awaited<ReturnType<typeof relay.startRelayServer>> | undefined;
let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close().catch(() => undefined);
  studio = undefined;
  await server?.close();
  store?.close();
  server = undefined;
  store = undefined;
  if (root) removeTempDir(root);
  root = "";
});

test("协作: 拉进协作, the AI's state, an @ folded into the conversation, cowork_post, 转到我的会话 (2026-11-23)", async () => {
  test.setTimeout(240_000);
  root = mkdtempSync(join(tmpdir(), "amo-cowork-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, filesDir: join(root, "relay", "files"), host: "127.0.0.1", port: 0, name: "测试组" });
  const plannerKey = store.register("策划小王", "pw-aaaa").key;
  const coderKey = store.register("程序老李", "pw-bbbb").key;
  const coder = new relay.RelayClient(server.url, coderKey);
  const home = join(root, "home");
  await account.saveAccount({ server: server.url, name: "策划小王", key: plannerKey }, { env: { AMO_HOME: home } });
  const c = await coder.createCowork({ title: "射速调整", goal: "把射速上限做成可配，策划能在表里调。", repo: "game", branch: "feat/rate", members: ["策划小王"] });

  // The 中转 client this computer has open (its running.json): the 协作 line starts it; test mode only records that.
  const relayHome = join(root, "relay-home");
  mkdirSync(relayHome, { recursive: true });
  const relayExe = join(relayHome, "AMO 中转.exe");
  writeFileSync(relayExe, "");
  writeFileSync(join(relayHome, "running.json"), JSON.stringify({ pid: 1, exe: relayExe, startedAt: new Date().toISOString() }));
  studio = await launchStudio({ env: { AMO_HOME: home, AMO_RELAY_HOME: relayHome } });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "射速文档", workspaceId: ws.id, firstSession: { profileId: "claude-mock", title: "射速文档", text: "先读一下设计文档。" } });
  await page.getByTestId("task-card").filter({ hasText: "射速文档" }).click();
  const transcript = page.getByTestId("thread");
  await expect(transcript).toContainText("先读一下设计文档。", { timeout: 60_000 });

  // 拉进协作… from the session's 更多 menu: the 协作 the planner is in, the name it goes by there.
  await page.getByTestId("session-more").click();
  await page.getByTestId("session-cowork").click();
  const dialog = page.getByTestId("cowork-join-dialog");
  await expect(dialog.getByTestId("cowork-choice")).toContainText("射速调整");
  await expect(dialog.getByTestId("cowork-choice")).toContainText("把射速上限做成可配");
  await expect(dialog.getByTestId("cowork-label")).toHaveValue("射速文档");
  await expect(dialog).toContainText("别人看到的是「策划小王 的 AI · 射速文档」");
  // 主控 or 执行 (2026-11-24): this side has no 主控 yet and no 事项 is open, so 主控.
  await expect(dialog.getByTestId("cowork-role-lead")).toBeChecked();
  await expect(dialog.getByTestId("cowork-role-worker")).toBeDisabled();
  await expect(dialog.getByTestId("cowork-roles")).toContainText("协作里还没有开着的事项");
  await screenshot(app, "cowork", "C1-join-dialog", page);
  await dialog.getByTestId("cowork-join").click();
  await expect(dialog).toHaveCount(0);
  const line = page.getByTestId("cowork-line");
  await expect(line).toContainText("「射速调整」");
  await expect(line.getByTestId("cowork-state")).toHaveText("✓ 待命", { timeout: 30_000 });
  await expect(line.getByTestId("cowork-role")).toHaveText("主控");
  const mark = (await studio.api<CoworkJoin[]>("GET", "/api/cowork/joined"))[0]!.mark;
  await expect.poll(async () => (await coder.cowork(c.id)).cowork.agents.map((a) => [a.name, a.state]), { timeout: 30_000 }).toEqual([["策划小王 的 AI · 射速文档", "idle"]]);
  await screenshot(app, "cowork", "C2-line", page);

  // 复制会话引用 and 复制编号 (2026-11-23): the lines to paste to an AI, the session's with the mark the 协作 knows it by.
  await page.getByTestId("session-more").click();
  await expect(page.getByTestId("session-copy-ref")).toHaveText("复制会话引用");
  await screenshot(app, "cowork", "C7-session-menu", page);
  await page.getByTestId("session-copy-ref").click();
  await expect.poll(() => lastCopied(app)).toBe(`Studio 会话「射速文档」 ${mark}（任务 ${task.id}）`);
  await expect(page.getByTestId("copied-ref")).toContainText(`已复制会话引用：Studio 会话「射速文档」 ${mark}`);
  await screenshot(app, "cowork", "C8-copied-session-ref", page);
  await page.getByTestId("task-copy-ref").click();
  await expect.poll(() => lastCopied(app)).toBe(`任务「射速文档」 ${task.id}`);
  await expect(page.getByTestId("copied-ref").last()).toContainText(`已复制任务编号：任务「射速文档」 ${task.id}`);

  // The line opens the 协作 in the 中转 client: the Host starts the open one with --open=cowork:<id>.
  const opened = page.waitForResponse((r) => r.url().includes("/api/cowork/open-in-relay"));
  await line.getByTestId("cowork-open").hover();
  await screenshot(app, "cowork", "C9-line-hover", page);
  await line.getByTestId("cowork-open").click();
  expect(await (await opened).json()).toMatchObject({ exe: relayExe, from: "running.json", args: [`--open=cowork:${c.id}`], dryRun: true });
  await expect(page.getByTestId("cowork-opened")).toContainText("正在 AMO 中转里打开协作「射速调整」");

  // Words in the composer: 等主人 (and the 协作 sees it).
  await page.getByLabel("输入消息").fill("我想想");
  await expect(line.getByTestId("cowork-state")).toHaveText("! 等主人", { timeout: 30_000 });
  await expect.poll(async () => (await coder.cowork(c.id)).cowork.agents[0]!.state, { timeout: 30_000 }).toBe("owner");
  await page.getByLabel("输入消息").fill("");
  await expect(line.getByTestId("cowork-state")).toHaveText("✓ 待命", { timeout: 30_000 });

  // The coder @-s it: one folded row, the 协作's, with what was said; 在中转里打开 opens that thread in the client.
  await coder.postCowork(c.id, { kind: "text", body: "上限放配置表 config/rate.json 行吗？", agentMentions: [mark] });
  const row = transcript.getByTestId("msg-origin").filter({ hasText: "程序老李 在群聊里 @ 了你（协作「射速调整」）" });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.getByTestId("msg-origin-brief")).toContainText("上限放配置表 config/rate.json 行吗？");
  await expect(row.getByTestId("msg-origin-brief")).not.toContainText("AMO Studio 从协作");
  await expect.poll(async () => (await coder.cowork(c.id)).deliveries.map((d) => d.state), { timeout: 30_000 }).toEqual(["delivered"]);
  await screenshot(app, "cowork", "C3-mention-folded", page);
  await row.getByTestId("msg-origin-toggle").click();
  await expect(row.getByTestId("msg-origin-body")).toContainText("cowork_post");
  await row.getByTestId("open-in-relay").click();
  await expect.poll(() => app.evaluate(() => (globalThis as { __amoRelayOpened?: Array<{ threadId: string }> }).__amoRelayOpened?.map((o) => o.threadId))).toEqual([c.id]);
  await row.scrollIntoViewIfNeeded();
  await screenshot(app, "cowork", "C4-mention-open", page);

  // Its answer, as the planner's AI, in the 群聊.
  await expect(line.getByTestId("cowork-state")).toHaveText("✓ 待命", { timeout: 60_000 });
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: cowork_post ${JSON.stringify({ body: "行，就放 config/rate.json。" })}]]` });
  await expect(transcript).toContainText("MOCK-MCP: 已发出", { timeout: 60_000 });
  await expect.poll(async () => (await coder.coworkFeed(c.id)).messages.find((m) => m.body.startsWith("行，"))?.via, { timeout: 30_000 }).toMatchObject({ kind: "ai", conv: mark });
  await expect.poll(async () => (await coder.cowork(c.id)).deliveries.map((d) => d.state)).toEqual(["replied"]);

  // 转到我的会话: the coder asks the planner in a 子会话; the 中转 client on this computer hands it to Studio (through
  // POST /api/ui/open, as a client that knows only that route does); a session here takes it.
  const asked = await coder.askCowork(c.id, { to: "策划小王", title: "射速曲线", body: "线性还是指数？" });
  await studio.api("POST", "/api/ui/open", { sessionId: `cowork-to-${asked.thread!.id}` });
  const handoff = page.getByTestId("cowork-handoff-dialog");
  await expect(handoff).toContainText("协作「射速调整」的子会话「射速曲线」（程序老李 问 策划小王）", { timeout: 30_000 });
  await expect(handoff.getByTestId("handoff-session")).toContainText("射速文档 · 射速文档");
  await screenshot(app, "cowork", "C5-handoff", page);
  await handoff.getByTestId("handoff-accept").click();
  await expect(handoff).toHaveCount(0);
  const handed = transcript.getByTestId("msg-origin").filter({ hasText: "策划小王 把子会话「射速曲线」转给你（协作「射速调整」）" });
  await expect(handed).toBeVisible({ timeout: 60_000 });
  await expect(handed.getByTestId("msg-origin-brief")).toContainText("线性还是指数？");
  await handed.scrollIntoViewIfNeeded();
  await screenshot(app, "cowork", "C6-handed", page);

  // 待我处理 (2026-11-24): the 事项「射速曲线」 waits on the planner — a row in Focus, counted in 需要你.
  const toggle = page.getByRole("button", { name: /^Focus/ });
  const focusOpened = app.waitForEvent("window");
  await toggle.click();
  const focus = await focusOpened;
  const pendingRow = focus.getByTestId("focus-pending");
  await expect(pendingRow).toContainText("待我处理", { timeout: 60_000 });
  await expect(pendingRow).toContainText("射速调整");
  await expect(focus.getByTestId("focus-needs")).toContainText("需要你");
  await screenshot(app, "cowork", "C10-focus-pending", focus, "focus");
  await toggle.click();

  // 现在看一遍: the 主控's patrol, now.
  await line.getByTestId("cowork-patrol").click();
  await expect(page.getByTestId("cowork-patrolled")).toBeVisible();

  // 改角色: 主控, or 执行 of the open 事项.
  await line.getByTestId("cowork-role-change").click();
  const roleDialog = page.getByTestId("cowork-role-dialog");
  await expect(roleDialog.getByTestId("cowork-role-lead")).toBeChecked();
  await roleDialog.getByTestId("cowork-role-worker").check();
  await expect(roleDialog.getByTestId("cowork-role-matter")).toContainText("事项 1「射速曲线」");
  await screenshot(app, "cowork", "C11-role-dialog", page);
  await roleDialog.getByRole("button", { name: "取消" }).click();
  await expect(roleDialog).toHaveCount(0);

  // 退出.
  await line.getByTestId("cowork-leave").click();
  await expect(page.getByTestId("cowork-bar")).toHaveCount(0);
  await expect.poll(async () => (await coder.cowork(c.id)).cowork.agents).toEqual([]);

  // 在我的 Studio 里开这一方的主控 (2026-11-24): the 中转 client asks through POST /api/ui/open; a session here takes it
  // and is given the 协作 (goal, 已定的事, 事项).
  await studio.api("POST", "/api/ui/open", { sessionId: `cowork-lead-${c.id}` });
  const leadAsk = page.getByTestId("cowork-handoff-dialog");
  await expect(leadAsk).toContainText("在 Studio 里开「射速调整」这一方的主控", { timeout: 30_000 });
  await expect(leadAsk.getByTestId("handoff-new")).toBeChecked();
  await screenshot(app, "cowork", "C12-lead-ask", page);
  await leadAsk.getByTestId("handoff-existing").check();
  await leadAsk.getByTestId("handoff-accept").click();
  await expect(leadAsk).toHaveCount(0);
  const leadMsg = transcript.getByTestId("msg-origin").filter({ hasText: "让你当这一方的主控" });
  await expect(leadMsg).toBeVisible({ timeout: 60_000 });
  await expect(line.getByTestId("cowork-role")).toHaveText("主控", { timeout: 30_000 });
  await leadMsg.getByTestId("msg-origin-toggle").click();
  await expect(leadMsg.getByTestId("msg-origin-body")).toContainText("把射速上限做成可配");
  await leadMsg.scrollIntoViewIfNeeded();
  await screenshot(app, "cowork", "C13-lead-landed", page);
  await line.getByTestId("cowork-leave").click();
  await expect(page.getByTestId("cowork-bar")).toHaveCount(0);
});
