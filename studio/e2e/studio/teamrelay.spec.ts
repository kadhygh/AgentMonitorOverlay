import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { Session, Task, TeamSend, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 会话里用中转 (2026-10-30, plans/relay-in-sessions.md): a session asks someone on the team through AMO 中转; the person
// confirms it (Focus, the task page); it goes as them (AI 代发); the other person replies in 中转 and the reply comes back
// into the session by itself. Against a relay service started here on a free port — never the team server — with an
// AMO_HOME logged in as the AMO platform would.

const relay = (await import(pathToFileURL(join(studioRoot, "packages", "relay", "dist", "index.js")).href)) as typeof import("../../packages/relay/src/index.js");
const account = (await import(pathToFileURL(join(studioRoot, "packages", "account", "dist", "index.js")).href)) as typeof import("../../packages/account/src/index.js");

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

test("会话里用中转: the session asks 程序老李, the person sends it, the reply comes back into the session (2026-10-30)", async () => {
  test.setTimeout(180_000);
  root = mkdtempSync(join(tmpdir(), "amo-teamrelay-e2e-"));
  store = new relay.RelayStore(join(root, "relay", "relay.db"));
  server = await relay.startRelayServer({ store, filesDir: join(root, "relay", "files"), host: "127.0.0.1", port: 0, name: "测试组" });
  const plannerKey = store.register("策划小王", "pw-aaaa").key;
  const coderKey = store.register("程序老李", "pw-bbbb").key;
  const coder = new relay.RelayClient(server.url, coderKey);
  const home = join(root, "home");
  await account.saveAccount({ server: server.url, name: "策划小王", key: plannerKey }, { env: { AMO_HOME: home } });

  studio = await launchStudio({ env: { AMO_HOME: home } });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const ask = { to: "程序老李", title: "背包上限存哪", body: "打算把上限写死在客户端常量里，每升 10 级 +5 格。", questions: [{ text: "上限放哪", options: ["客户端常量", "服务端配置表"] }] };
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "背包扩容",
    workspaceId: ws.id,
    firstSession: { profileId: "claude-mock", text: `[[mcp: team_ask ${JSON.stringify(ask)}]]` },
  });
  await expect.poll(async () => (await studio!.api<TeamSend[]>("GET", "/api/teamrelay/sends")).map((s) => s.state), { timeout: 60_000 }).toEqual(["pending"]);
  // Nothing went out before the person said so.
  expect(await coder.threads()).toEqual([]);

  // Focus shows it, answerable in place.
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-teamsend")).toContainText("AI 想找 程序老李 确认", { timeout: 30_000 });
  await expect(focus.getByTestId("focus-teamsend")).toContainText("背包扩容");

  // The task's page too, with what it says and asks; 发送 sends it as the person, marked as their AI's.
  await page.getByTestId("task-card").filter({ hasText: "背包扩容" }).click();
  const banner = page.getByTestId("teamsend-banner");
  await expect(banner.getByTestId("teamsend-card")).toContainText("上限放哪（客户端常量 / 服务端配置表）");
  await screenshot(app, "teamrelay", "T1-confirm", page);
  await banner.getByTestId("teamsend-send").click();
  await expect(banner.getByTestId("teamsend-card")).toHaveCount(0);
  await expect(focus.getByTestId("focus-teamsend")).toHaveCount(0);
  await expect.poll(async () => (await coder.threads()).length).toBe(1);
  const [thread] = await coder.threads();
  expect(thread!.request).toMatchObject({ from: "策划小王", to: "程序老李", byAi: true });
  expect(thread!.last?.via).toMatchObject({ kind: "ai", client: "AMO Studio" });

  // Whom it waits on: on the task's page and its card.
  await expect(banner.getByTestId("team-wait")).toContainText("等 程序老李 回复（中转）");
  await page.getByRole("button", { name: /返回看板|看板/ }).first().click();
  await expect(page.getByTestId("task-card").filter({ hasText: "背包扩容" }).getByTestId("card-team-wait")).toContainText("等 程序老李 回复（中转）");
  await screenshot(app, "teamrelay", "T2-card-waiting", page);

  // The coder replies in 中转: it comes into the session by itself, a new turn.
  await coder.send(thread!.id, { kind: "reply", answers: [{ questionId: "q1", choice: "服务端配置表" }], body: "运营会调上限。", verdict: "change" });
  await page.getByTestId("task-card").filter({ hasText: "背包扩容" }).click();
  const transcript = page.getByTestId("thread");
  await expect(transcript).toContainText("【中转回复】", { timeout: 60_000 });
  await expect(transcript).toContainText("上限放哪");
  await expect(transcript).toContainText("服务端配置表");
  await expect(page.getByTestId("teamsend-banner")).toHaveCount(0);
  expect((await coder.threads())[0]!.request!.pickedAt).not.toBeNull();
  await screenshot(app, "teamrelay", "T3-reply-back", page);
  expect(session.id).toBeTruthy();

  // 设置 → 功能 → 中转 (2026-10-30): asks can go without the person's 发送; off by default.
  await page.getByRole("button", { name: "设置" }).first().click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("tab", { name: "功能" }).click();
  const auto = settings.getByTestId("team-auto-send");
  await expect(auto).not.toBeChecked();
  await auto.check();
  await expect.poll(async () => (await studio!.api<{ teamAutoSend: boolean }>("GET", "/api/settings")).teamAutoSend).toBe(true);
  await screenshot(app, "teamrelay", "T4-auto-send-setting", page);
});
