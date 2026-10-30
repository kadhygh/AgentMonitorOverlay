import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayClient, RelayStore, startRelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { Backoff } from "../remote/link.js";

// 问题页 ↔ 会话 (2026-10-31, plans/issues.md stage 3), against a relay service on this machine (never the team server):
// a session lists the person's issues, reads one with its screenshot as a local file, takes it, answers with a
// screenshot of its own, and marks what a test build fixed — each entry the AI's, as the person's account.

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: "x", model: "m" }];
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-issues-${name}-`));
  cleanups.push(() => removeTempDir(d));
  return d;
};

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what = "condition", ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function setup(signedIn = true) {
  const relayStore = new RelayStore(":memory:");
  const relay = await startRelayServer({ store: relayStore, filesDir: tempDir("files"), host: "127.0.0.1", port: 0 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const me = relayStore.register("戴", "pw-aaaa");
  const home = tempDir("home");
  const env = { AMO_HOME: home, COMPUTERNAME: "DEV-PC" };
  if (signedIn) await saveAccount({ server: relay.url, name: "戴", key: me.key }, { env, protector: fake });
  const root = tempDir("data");
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  service.remote.start({ env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }) });
  cleanups.push(async () => {
    service.remote.stop();
    await servers.close();
    store.close();
  });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const t = amoToolsFor(service, { sessionId: "s-x" } as never).find((x) => x.name === name)!;
    const out = await t.run(args);
    const text = out.content.map((c) => c.text).join("");
    return { text, error: !!out.isError, value: out.isError ? null : (JSON.parse(text) as Record<string, any>) };
  };
  if (signedIn) await until(() => service.remote.teamLogin(), (l) => !!l, "the platform's login");
  return { tool, page: new RelayClient(relay.url, me.key), root };
}

describe("问题页 tools", () => {
  it("list, read with screenshots, take, answer with a picture, release", async () => {
    const { tool, page, root } = await setup();
    // The person reports two issues on the page, one with a screenshot; one of them is closed.
    const shot = await page.uploadIssueImage("bug.png", PNG, "image/png");
    await page.createIssue({ title: "输入栏没缓存", body: "切走再回来，写了一半的话没了", tool: "studio", version: "0.9.16", images: [shot.id] });
    const old = await page.createIssue({ body: "旧问题" });
    await page.updateIssue(old.number, { status: "closed" });

    const list = (await tool("issue_list")).value!;
    expect(list.issues.map((i: { number: number }) => i.number)).toEqual([1]);
    expect(list.issues[0]).toMatchObject({ title: "输入栏没缓存", status: "new", statusLabel: "新", tool: "studio", version: "0.9.16", awaitsAi: true });
    expect((await tool("issue_list", { all: true })).value!.issues).toHaveLength(2);

    const one = (await tool("issue_get", { number: 1 })).value!;
    const image = one.entries[0].images[0];
    expect(image.path).toBe(join(root, "issue-images", `${shot.id}.png`));
    expect(readFileSync(image.path)).toEqual(PNG);

    // Take it, then answer with a screenshot and 已修好.
    expect((await tool("issue_update", { number: 1, status: "working", worker: "Opus 5.5 · 任务「问题 #1」" })).value).toMatchObject({ status: "working", worker: "Opus 5.5 · 任务「问题 #1」" });
    const mine = join(root, "after.png");
    writeFileSync(mine, PNG);
    const answered = (await tool("issue_reply", { number: 1, body: "修好了：输入栏按任务存草稿", status: "fixed", images: [mine] })).value!;
    expect(answered).toMatchObject({ status: "fixed", awaitsAi: false });
    const back = await page.issue(1);
    const last = back.entries!.at(-1)!;
    expect(last).toMatchObject({ ai: true, author: "戴", body: "修好了：输入栏按任务存草稿" });
    expect(last.images).toHaveLength(1);
    expect(back.entries!.filter((e) => e.kind === "status" && e.ai)).toHaveLength(1);

    // Refusals the agent can read.
    expect(await tool("issue_reply", { number: 1, images: ["relative.png"] })).toMatchObject({ error: true, text: expect.stringContaining("完整路径") });
    expect(await tool("issue_reply", { number: 1, images: [join(root, "studio.db")] })).toMatchObject({ error: true, text: expect.stringContaining("只能传图片") });
    expect(await tool("issue_get", { number: 99 })).toMatchObject({ error: true });
    expect(await tool("issue_update", { number: 1 })).toMatchObject({ error: true, text: expect.stringContaining("没有要改的") });

    // 发布打包 asked on the page; the build goes out.
    expect((await page.requestIssueRelease()).requestedBy).toBe("戴");
    expect((await tool("issue_list")).value!.release.requestedAt).toEqual(expect.any(Number));
    const released = (await tool("issue_released", { version: "Studio 0.9.17", numbers: [1] })).value!;
    expect(released).toMatchObject({ released: [1], release: { requestedAt: null, last: { version: "Studio 0.9.17" } } });
    expect(await page.issue(1)).toMatchObject({ status: "released", fixedIn: "Studio 0.9.17" });
  });

  it("says to sign in on the platform when there is no login", async () => {
    const { tool } = await setup(false);
    expect(await tool("issue_list")).toMatchObject({ error: true, text: "要先在 AMO 平台里登录团队服务器，才能读写问题页。" });
  });
});
