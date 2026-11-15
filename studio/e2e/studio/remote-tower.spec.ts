import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { RemoteState, Session, SessionItem, StateSnapshot, Task, TowerData } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程任务的脉络 (2026-11-15, the user: 我是远端操控好像看不到). Two Studios paired through a relay started here (never
// the team server): B, driving A's task, sees its session's building — put together on A (rt.tracks), where its AI's
// titles are — ticks 脉络会话 (the tick is A's), and goes on in the composer under it.

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

const replies = async (s: Studio, sessionId: string) => (await s.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`)).flatMap((i) => (i.type === "agent" && !i.streaming ? [i.markdown] : []));

test("B opens a remote task's session as its building: read from A with its AI's titles, 脉络会话 ticked on A from B, and B goes on under it", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("remote-tower");
  // 脉络 is a 测试功能 on each computer: A's gives its AI the tool, B's shows the switch.
  await Promise.all([a, b].map((x) => x.api("PUT", "/api/settings", { experimentalFeatures: ["tracks"] })));
  const { task, session } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "远程脉络", firstSession: { profileId: "claude-mock", text: "先看看现状" } });
  await until(() => replies(a, session.id), (r) => r.some((t) => t.includes("MOCK")), "A's first reply");
  await until(() => a.api<StateSnapshot>("GET", "/api/state"), (s) => s.sessions.find((x) => x.id === session.id)?.status !== "running", "A idle");
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "笔记本的我", device: (await b.api<RemoteState>("GET", "/api/remote")).device!.id });
  const onA = () => a.api<TowerData>("GET", `/api/sessions/${session.id}/tracks`);

  const page = b.page;
  const card = page.getByTestId("task-card").filter({ hasText: "远程脉络" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  await expect(page.getByTestId("msg-agent")).toHaveCount(1, { timeout: 30_000 });
  // The switch is there on a copy too; ticked here, the session is a 脉络会话 on A.
  await expect(page.getByTestId("tower-switch")).toBeVisible();
  await expect(page.getByTestId("tower-off")).toHaveCount(0);
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible({ timeout: 30_000 });
  expect((await onA()).on).toBe(true);
  expect((await a.api<{ on: string[] }>("GET", "/api/tracks")).on).toEqual([session.id]);
  const frame = page.frameLocator('[data-testid="tower-frame"]');
  await expect(frame.locator("#rail button")).toHaveCount(2, { timeout: 30_000 });

  // B goes on under the building: the message runs on A, whose AI is told about 脉络 with it and titles the round.
  const note = `[[mcp: track_note ${JSON.stringify({ title: "从笔记本接着做", desc: "标题是 A 上的 AI 写的", points: ["远程也要能看脉络"] })}]]`;
  await page.getByLabel("输入消息").fill(note);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(onA, (t) => t.rounds.at(-1)?.title === "从笔记本接着做", "A's AI titles the round", 60_000);
  const sent = (await a.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!;
  expect(sent.text).toContain("这个会话开了「脉络」");
  // B's building is drawn anew from A's: the new floor with its title, and the point.
  await expect(frame.locator("#rail button")).toHaveCount(3, { timeout: 30_000 });
  await expect(frame.locator("#sideBody")).toContainText("远程也要能看脉络", { timeout: 30_000 });
  await frame.locator('#rail button[data-f="2"]').click();
  await expect(frame.locator("#sideBody h3")).toHaveText("从笔记本接着做");
  await page.waitForTimeout(1200);
  await screenshot(b.app, "studio", "remote-tower", page);
  // Back into the conversation on B, and the tick taken off from B is off on A.
  await frame.locator("#openSrc").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0, { timeout: 30_000 });
  expect((await onA()).on).toBe(false);
});
