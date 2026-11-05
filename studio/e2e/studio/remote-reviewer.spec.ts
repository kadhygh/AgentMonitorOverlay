import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { GitReviewComment, RemoteState, Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 远程 Reviewer (plans/done/remote-reviewer.md, 2026-11-02): two Studios on this machine (each its own AMO_HOME and data,
// the mock model), paired through a relay service started here on a free port — never the team server. A grants B a
// task in a git project. B's message makes A's agent open a 查看包 and a Review: they pop up on B (the turn is B's),
// read from A; B writes comments there, which stay on B — copied with 任务文件夹/ paths, or sent into the task's
// conversation (发到对话), which reaches A as B's message. With 「我也关心」 ticked on A, B's turns pop up on A too; A's own turns never on B.

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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

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

async function nextWindow(app: ElectronApplication, act: () => Promise<unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await act();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

const copied = (s: Studio) => s.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1) ?? "");

test("B's turn opens A's 查看包 and Review on B, read from A; B's comments stay on B, copied with 任务文件夹/ paths or sent into the conversation", async () => {
  test.setTimeout(300_000);
  const { a, b } = await pairedStudios("remote-reviewer");
  const dir = a.workspace("掉落表");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.1\nlocal boss = 'Lv10'\nreturn { rate = rate, boss = boss }\n");
  writeFileSync(join(dir, "notes.md"), "# 掉落\n\n先改概率，再看 boss 等级。\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.25\nlocal boss = 'Lv10'\nreturn { rate = rate, boss = boss }\n");
  const ws = await a.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { task, session } = await a.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "远程看改动", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello" } });
  await a.page.getByTestId("task-card").filter({ hasText: "远程看改动" }).click();
  await expect(a.page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 60_000 });
  await a.api("POST", "/api/remote/grants", { taskId: task.id, account: "笔记本的我", device: (await b.api<RemoteState>("GET", "/api/remote")).device!.id });

  // 「我也关心」 on A's 已授权 banner (2026-11-02: one tick for Focus and for what agents open); off by default.
  const alsoMine = a.page.getByTestId("granted-also-mine");
  await expect(alsoMine).toBeVisible({ timeout: 30_000 });
  await expect(alsoMine.locator("input")).not.toBeChecked();
  await expect(alsoMine).toHaveAttribute("title", /查看包和 Review 也在这台电脑上弹/);

  const card = b.page.getByTestId("task-card").filter({ hasText: "远程看改动" });
  await expect(card).toHaveAttribute("data-remote", "online", { timeout: 30_000 });
  await card.click();
  await expect(b.page.getByTestId("msg-agent").last()).toContainText("MOCK", { timeout: 30_000 });
  // No tick of its own on B: it shows what its own turns open.
  await expect(b.page.getByTestId("remote-banner").locator("input[type=checkbox]")).toHaveCount(0);

  // B's message: A's agent opens a pack — on B (the turn is B's), not on A (「我也关心」 is off there).
  const aWindows = a.app.windows().length;
  const items = [
    { kind: "file", path: "drop.lua", highlights: [{ line: 1, note: "0.1 → 0.25" }] },
    { kind: "file", path: "notes.md" },
    { kind: "git", files: ["drop.lua"] },
  ];
  const win = await nextWindow(b.app, () => b.api("POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: view_open ${JSON.stringify({ title: "远程的包", items })}]]` }));
  await expect(win.getByTestId("viewpack-title")).toHaveText("远程的包", { timeout: 30_000 });
  await expect(win.getByTestId("viewpack-entry")).toHaveCount(3);
  await expect(win.getByText("A 台式机 · 任务文件夹").first()).toBeVisible();
  await expect(win.locator('.gr-line[data-line="new:1"]')).toContainText("rate = 0.25", { timeout: 30_000 });
  await expect(win.getByTestId("highlight-note")).toContainText("0.1 → 0.25");
  // Nothing of B's own: no Explorer.
  await expect(win.getByTestId("viewer-reveal")).toHaveCount(0);
  expect(a.app.windows().length).toBe(aWindows);

  // A comment on B: kept on B, 发到对话 sends it into the task's conversation (to A, as B's message).
  await win.locator('[data-line="new:1"]').getByTestId("add-comment").click();
  await win.getByTestId("comment-draft").getByLabel("批注内容").fill("0.25 太高，先 0.15");
  await win.getByTestId("comment-draft").getByRole("button", { name: "保存" }).click();
  await expect(win.getByTestId("review-draft-count")).toHaveText("草稿批注 1 条");
  await expect(win.getByTestId("review-send")).toHaveText("发到对话（1）");
  await screenshot(b.app, "studio", "remote-reviewer-pack-comment", win, "viewer");
  expect(await a.api<GitReviewComment[]>("GET", `/api/workspaces/${ws.id}/review-comments`)).toEqual([]);
  await win.getByTestId("review-send").click();
  await expect(win.getByTestId("toast")).toContainText("已把 1 条批注发到对话");
  const got = await until(
    () => a.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`),
    (list) => list.some((i) => i.type === "user" && i.text.startsWith("文件批注")),
    "A gets the comments as a message",
  );
  const msg = got.find((i) => i.type === "user" && i.text.startsWith("文件批注")) as { text: string };
  expect(msg.text).toContain("「任务文件夹」的文件");
  expect(msg.text).toContain("### drop.lua");
  expect(msg.text).toContain("0.25 太高，先 0.15");
  expect(msg.text).not.toContain(dir);
  expect(await a.api<GitReviewComment[]>("GET", `/api/workspaces/${ws.id}/review-comments`)).toEqual([]);

  // The pack's git item: A's uncommitted changes, read through B; a comment there copied out with 任务文件夹/ paths.
  await win.getByTestId("viewpack-entry").nth(2).click();
  const changes = win.getByTestId("viewpack-git");
  await expect(changes.getByTestId("review-file-head")).toContainText("drop.lua", { timeout: 30_000 });
  await expect(changes.locator(".gr-line.add")).toContainText("rate = 0.25");
  await changes.locator(".gr-line.add").first().getByTestId("add-comment").click();
  await changes.getByTestId("comment-draft").getByLabel("批注内容").fill("改动也看了");
  await changes.getByTestId("comment-draft").getByRole("button", { name: "保存" }).click();
  await screenshot(b.app, "studio", "remote-reviewer-pack-git", win, "viewer");
  await win.getByTestId("review-copy").first().click();
  await expect.poll(() => copied(b)).toContain("改动也看了");
  const text = await copied(b);
  expect(text).toContain("「A 台式机 上的任务文件夹」");
  expect(text).toContain("任务文件夹/drop.lua");
  expect(text).not.toContain(dir);

  // review_open of the task's project, B's turn again: the Review window opens on B, its files read from A.
  await win.close();
  const review = await nextWindow(b.app, () => b.api("POST", `/api/sessions/${session.id}/messages`, { text: "[[mcp: review_open {}]]" }));
  await expect(review.getByTestId("review-file")).toHaveCount(1, { timeout: 30_000 });
  await expect(review.getByTestId("review-file")).toContainText("drop.lua");
  await expect(review.locator(".gr-line.add")).toContainText("rate = 0.25", { timeout: 30_000 });
  await screenshot(b.app, "studio", "remote-reviewer-review", review, "review");
  await review.close();
  expect(a.app.windows().length).toBe(aWindows);

  // The conversation's rows on B open them again (the copy's pack and Review, through A).
  const reopenPack = b.page.getByTestId("tool-open-pack").first();
  await expect(reopenPack).toBeVisible({ timeout: 30_000 });
  const again = await nextWindow(b.app, () => reopenPack.click());
  await expect(again.getByTestId("viewpack-title")).toHaveText("远程的包", { timeout: 30_000 });
  await again.close();
  const reopenReview = b.page.getByTestId("tool-open-review").last();
  await expect(reopenReview).toBeVisible({ timeout: 30_000 });
  const review2 = await nextWindow(b.app, () => reopenReview.click());
  await expect(review2.getByTestId("review-file")).toHaveCount(1, { timeout: 30_000 });
  await review2.close();

  // 「我也关心」 ticked on A: what B's turns open pops up on A too.
  await alsoMine.locator("input").check();
  await expect(alsoMine.locator("input")).toBeChecked();
  await screenshot(a.app, "studio", "remote-reviewer-also-mine", a.page);
  const onA = a.app.waitForEvent("window");
  const onB = b.app.waitForEvent("window");
  await b.api("POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: view_open ${JSON.stringify({ title: "两边都看", items: [{ kind: "file", path: "notes.md" }] })}]]` });
  const [packA, packB] = await Promise.all([onA, onB]);
  await expect(packA.getByTestId("viewpack-file")).toContainText("先改概率", { timeout: 30_000 });
  await expect(packB.getByTestId("viewpack-file")).toContainText("先改概率", { timeout: 30_000 });
  await packB.close();

  // A's own turn: shown on A as always; B is not told (its conversation's row opens it when wanted).
  const bWindows = b.app.windows().length;
  const rows = await b.page.getByTestId("tool-open-pack").count();
  await a.api("POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: view_open ${JSON.stringify({ title: "A 自己看", items: [{ kind: "file", path: "drop.lua" }] })}]]` });
  await expect(packA.locator('.gr-line[data-line="new:1"]')).toContainText("rate = 0.25", { timeout: 30_000 });
  await expect(b.page.getByTestId("tool-open-pack")).toHaveCount(rows + 1, { timeout: 30_000 });
  expect(b.app.windows().length).toBe(bWindows);
});
