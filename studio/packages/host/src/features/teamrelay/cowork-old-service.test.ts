import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageOrigin, ModelProfile, Session } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayClient, RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import { listenInStudioRange, removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { OLD_SERVICE } from "./cowork.js";

// A new Studio against an old 中转 service (2026-11-25, 中转迭代讨论; plans/collab-framework.md 「已有的协作、新旧版本混用」):
// health says cowork 1 and the 协作 has no 事项 or roles. The service here is the current one behind a stand-in that answers
// the way an old one does — /api/health with cowork: 1, and no `matters`, `role`, `matter` or `matterNo` in what it returns —
// so the Host takes the old path: 拉进协作 without a role, the old card and deliveries, cowork_post / ask / conclude as before,
// and the new tools (cowork_matter, cowork_mark, cowork_retract) saying plainly that the service is still the old one.

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: "x", model: "m" }];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-oldrelay-${name}-`));
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

/** What a service from before 事项 does not send. */
const NEW_KEYS = new Set(["matters", "role", "matter", "matterNo"]);
function asOld(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(asOld);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !NEW_KEYS.has(k)).map(([k, x]) => [k, asOld(x)]));
}

/** The stand-in in front of the real service: every request goes on to it, JSON answers come back the old way. */
async function oldStandIn(target: string): Promise<{ url: string; server: Server }> {
  const to = new URL(target);
  const server = createServer((req, res) => {
    const up = request({ host: to.hostname, port: to.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => {
        let body = Buffer.concat(chunks);
        if (String(r.headers["content-type"] ?? "").includes("json") && body.length) {
          const v = JSON.parse(body.toString()) as Record<string, unknown>;
          body = Buffer.from(JSON.stringify(req.url?.startsWith("/api/health") ? { ...v, cowork: 1 } : asOld(v)));
        }
        const headers: IncomingHttpHeaders = { ...r.headers, "content-length": String(body.length) };
        delete headers["transfer-encoding"];
        res.writeHead(r.statusCode ?? 502, headers);
        res.end(body);
      });
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  const port = await listenInStudioRange(server);
  return { url: `http://127.0.0.1:${port}`, server };
}

async function setup() {
  const relayStore = new RelayStore(":memory:");
  const relay: RelayServer = await startRelayServer({ store: relayStore, filesDir: tempDir("files"), host: "127.0.0.1", port: 0 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const old = await oldStandIn(relay.url);
  cleanups.push(() => new Promise<void>((r) => old.server.close(() => r())));
  const planner = relayStore.register("策划小王", "pw-aaaa");
  const coder = relayStore.register("程序老李", "pw-bbbb");
  const home = tempDir("home");
  const env = { AMO_HOME: home, COMPUTERNAME: "PLANNER-PC" };
  // The planner's Studio talks to the old-looking service; the coder (another client) to the service itself.
  await saveAccount({ server: old.url, name: "策划小王", key: planner.key }, { env, protector: fake });
  const root = tempDir("data");
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  const alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const session = (title: string): Session => {
    const task = store.createTask({ title, workspaceId: alpha.id });
    return store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: alpha.id, title, status: "idle", writer: "workbench", runtimeRef: null });
  };
  const told: Array<{ sessionId: string; text: string; origin?: MessageOrigin }> = [];
  service.sessions.inbox.put = async (sessionId: string, text: string, origin?: MessageOrigin) => {
    told.push({ sessionId, text, ...(origin ? { origin } : {}) });
    return { delivered: true, waiting: 0 };
  };
  service.teamLink.start({ env, protector: fake, watchMs: 30 });
  service.teamRelay.pauseMs = { signedOut: 50, failed: 100, wait: 300 };
  service.teamRelay.cowork.pauseMs = { signedOut: 50, failed: 100, wait: 300, held: 100, report: 200 };
  service.pending.patrolMs = 3600_000;
  service.teamRelay.start();
  service.pending.start();
  if (service.teamRelay.coworkPending) service.teamRelay.coworkPending.waitMs = { person: 300, failed: 100 };
  cleanups.push(async () => {
    service.pending.stop();
    service.teamRelay.stop();
    service.teamLink.stop();
    await servers.close();
    store.close();
  });
  const coderClient = new RelayClient(relay.url, coder.key);
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const t = amoToolsFor(service, { sessionId } as never).find((x) => x.name === name)!;
    const out = await t.run(args);
    return { text: out.content.map((c) => (c.type === "text" ? c.text : "")).join(""), error: !!out.isError };
  };
  await until(() => service.teamLink.login(), (l) => !!l, "the platform's login");
  return { service, told, session, coderClient, tool };
}

describe("协作 against an old 中转 service (health cowork 1)", () => {
  it("joins without a role and is told the old card; cowork_post / ask / conclude as before; an @ comes the old way; the new tools say the service is old; no 待我处理", async () => {
    const { service, told, session, coderClient, tool } = await setup();
    expect(await service.teamRelay.cowork.version()).toBe(1);
    expect(await service.teamRelay.cowork.hasMatters()).toBe(false);
    const c = await coderClient.createCowork({ title: "射速", goal: "把射速上限做成可配。", members: ["策划小王"] });
    const s = session("射速文档");

    // 拉进协作: in, without a role (there is none to choose), told the old card with its next message.
    expect(await service.teamRelay.cowork.roles(c.id)).toEqual({ coworkId: c.id, matters: false, lead: null, openMatters: [] });
    const j = await service.teamRelay.cowork.join(s.id, c.id);
    expect(j).toMatchObject({ coworkId: c.id, sessionId: s.id, matters: false, role: null, matter: null });
    const card = service.sessions.roleUpdate(s.id).lines.join("\n");
    expect(card).toContain("把这个会话拉进了协作「射速」");
    expect(card).toContain("cowork_conclude（给子会话定结论）");
    expect(card).not.toContain("你的角色：主控");
    await expect(service.teamRelay.cowork.setRole({ sessionId: s.id, coworkId: c.id, role: "lead" })).rejects.toThrow(/还是旧版本/);

    // cowork_post: goes out; a basis is a line in front (the old service keeps no basis).
    const posted = await tool(s.id, "cowork_post", { body: "上限我放配置表。", basis: "inferred" });
    expect(posted).toMatchObject({ error: false });
    expect(posted.text).toContain("已发出");
    const mine = (await coderClient.coworkFeed(c.id)).messages.find((m) => m.body.includes("上限我放配置表。"))!;
    expect(mine.body).toBe("〔我的判断，策划小王没确认过〕 上限我放配置表。");
    expect(mine.via).toMatchObject({ kind: "ai", conv: j.mark });

    // cowork_ask opens a 子会话; the coder answers; cowork_conclude closes it the old way.
    const asked = await tool(s.id, "cowork_ask", { to: "程序老李", title: "射速曲线", body: "线性还是指数？" });
    expect(asked).toMatchObject({ error: false });
    expect(asked.text).toContain("子会话「射速曲线」已开");
    const sub = (await coderClient.cowork(c.id)).cowork.sessions.find((x) => x.title === "射速曲线")!;
    await coderClient.send(sub.id, { kind: "reply", body: "线性。" });
    await until(() => told.filter((t) => t.sessionId === s.id).length, (n) => n === 1, "the reply in the session");
    // The old delivery, not the 事项 wake.
    expect(told[0]!.text).toContain("线性。");
    expect(told[0]!.text).toContain("AMO Studio 从协作「射速」转进来的");
    expect(told[0]!.text).not.toContain("【协作 · 待你处理】");
    const done = await tool(s.id, "cowork_conclude", { threadId: sub.id, conclusion: "先用线性。" });
    expect(done).toMatchObject({ error: false });
    expect(done.text).toContain("子会话「射速曲线」定下结论：先用线性。");

    // The new tools: nothing done, said plainly (not an error), with what to do instead.
    const matter = await tool(s.id, "cowork_matter", { action: "open", title: "射速上限", body: "放配置表？" });
    expect(matter).toEqual({ error: false, text: OLD_SERVICE.matter });
    expect(matter.text).toContain("还是旧版");
    expect(await tool(s.id, "cowork_mark", { seqs: [mine.seq] })).toEqual({ error: false, text: OLD_SERVICE.mark });
    expect(await tool(s.id, "cowork_retract", { seq: mine.seq })).toEqual({ error: false, text: OLD_SERVICE.retract });
    expect((await coderClient.coworkFeed(c.id)).messages.find((m) => m.seq === mine.seq)?.body).toBe("〔我的判断，策划小王没确认过〕 上限我放配置表。");

    // cowork_read: the old overview (no roles, no 事项 section).
    const read = await tool(s.id, "cowork_read");
    expect(read.text).toContain("把射速上限做成可配。");
    expect(read.text).not.toContain("## 开着的事项");

    // No 待我处理 from an old service, and the patrol finds nothing to wake.
    expect(service.pending.snapshot().groups.filter((g) => g.source === "cowork")).toEqual([]);
    expect(await service.pending.patrol([s.id])).toMatchObject({ woke: [] });
  }, 30_000);
});
