import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { REMOTE_FORK_SINCE, type RemoteState, type Session, type SessionItem, type StateSnapshot, type Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程分支 (2026-11-12, the user: 远控模式下也能开分支). Two Studios paired through a relay started here (never the team
// server): B, driving A's task, forks a session from its first turn; the branch is made on A (its model runs there),
// shows on B with the conversation through that turn, and takes B's next message.

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

test("B forks a remote task's session from its first turn: made on A, shown on B with the turns through it, and B goes on in it", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("remote-fork");
  const { task, session } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "远程分支", firstSession: { profileId: "codex-mock", text: "先看看现状" } });
  await until(() => replies(a, session.id), (r) => r.some((t) => t.includes("MOCK: 先看看现状")), "A's first reply");
  await until(() => a.api<StateSnapshot>("GET", "/api/state"), (s) => s.sessions.find((x) => x.id === session.id)?.status !== "running", "A idle");
  await a.api("POST", `/api/sessions/${session.id}/messages`, { text: "再改一下导出" });
  await until(() => replies(a, session.id), (r) => r.some((t) => t.includes("MOCK: 再改一下导出")), "A's second reply");
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "笔记本的我", device: (await b.api<RemoteState>("GET", "/api/remote")).device!.id });

  const page = b.page;
  const card = page.getByTestId("task-card").filter({ hasText: "远程分支" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  await expect(page.getByTestId("msg-agent")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 再改一下导出");

  // Under the first turn's reply, beside 复制, as on A's own sessions.
  const first = page.getByTestId("turn-foot").first();
  await first.hover();
  await expect(first.getByTestId("turn-fork")).toBeEnabled();
  await first.getByTestId("turn-fork").click();
  const dialog = page.getByTestId("fork-dialog");
  await expect(dialog.getByTestId("fork-turn")).toHaveValue(/.+/, { timeout: 30_000 });
  await expect(dialog).toContainText("带上第 1 到第 1 轮，后面 1 轮不带");
  await expect(dialog.getByTestId("fork-title")).toHaveValue("先看看现状 · 第 1 轮分支");
  // The model and settings are the session's there: nothing to pick on B.
  await expect(dialog.getByTestId("fork-remote")).toContainText("分支建在 A 台式机 上");
  await expect(dialog.getByTestId("fork-more")).toHaveCount(0);
  await dialog.getByTestId("fork-mode-peer").click();
  await dialog.getByTestId("fork-title").fill("B 分的");
  await screenshot(b.app, "studio", "remote-fork-dialog", page);
  await dialog.getByTestId("fork-submit").click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });

  // On B: beside the source, selected, with the conversation through the first turn.
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const branch = rows.filter({ hasText: "B 分的" });
  await expect(branch).toHaveAttribute("data-kind", "main");
  await expect(branch.getByTestId("session-forked-from")).toHaveText("第 1 轮分出");
  await expect(page.getByTestId("msg-agent")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 先看看现状");
  await expect(page.getByText("从「先看看现状」第 1 轮分出")).toBeVisible();

  // On A: made there, as A's own 分支.
  const made = (await a.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.title === "B 分的")!;
  expect(made).toMatchObject({ taskId: task.id, runtime: "codex", kind: "main", parentId: null, forkOf: { sessionId: session.id, turn: 1 } });

  // B goes on in it: the message runs on A, the reply comes back.
  const composer = page.getByLabel("输入消息");
  await composer.fill("分支里接着说");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 分支里接着说", { timeout: 60_000 });
  expect((await replies(a, made.id)).some((t) => t.includes("MOCK: 分支里接着说"))).toBe(true);
  expect((await replies(a, session.id)).some((t) => t.includes("分支里接着说"))).toBe(false);
  await screenshot(b.app, "studio", "remote-fork-peer", page);

  // An older Studio on A (its snapshot has no fork): B greys 分支, saying what A has to update to. Made so by taking
  // the mark off B's copy (A says it again only with its next snapshot or task push).
  const db = new DatabaseSync(join(b.dataDir, "studio.db"));
  try {
    const row = db.prepare("SELECT remote FROM tasks WHERE id = ?").get(task.id) as { remote: string };
    const { fork: _fork, ...older } = JSON.parse(row.remote) as Record<string, unknown>;
    db.prepare("UPDATE tasks SET remote = ? WHERE id = ?").run(JSON.stringify(older), task.id);
  } finally {
    db.close();
  }
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  if (await card.isVisible({ timeout: 10_000 }).catch(() => false)) await card.click();
  await page.getByTestId("session-row").filter({ hasText: "先看看现状" }).click();
  await expect(page.getByTestId("msg-agent")).toHaveCount(2, { timeout: 30_000 });
  const old = page.getByTestId("turn-foot").first();
  await old.hover();
  await expect(old.getByTestId("turn-fork")).toBeDisabled();
  await expect(old.getByTestId("turn-fork")).toHaveAttribute("title", `A 台式机 上的 Studio 要更新到 ${REMOTE_FORK_SINCE} 或更新的版本，才能从这台电脑开分支`);
  await page.getByTestId("thread-head").getByRole("button", { name: "会话的更多操作" }).click();
  await expect(page.getByTestId("session-fork")).toBeDisabled();
  await expect(page.getByTestId("session-fork")).toHaveAttribute("title", /要更新到/);
  await expect(page.getByTestId("session-fork-off")).toHaveText(`A 台式机 上的 Studio 要更新到 ${REMOTE_FORK_SINCE} 或更新的版本，才能从这台电脑开分支`);
  await screenshot(b.app, "studio", "remote-fork-old-peer", page);
});
