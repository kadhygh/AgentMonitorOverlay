import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayClient } from "./client.js";
import type { Issue, IssueList } from "./issues-protocol.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";

let server: RelayServer | null = null;
let store: RelayStore | null = null;
let filesDir = "";
afterEach(async () => {
  await server?.close();
  store?.close();
  if (filesDir) rmSync(filesDir, { recursive: true, force: true });
  server = null;
  store = null;
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f4a1e40000000049454e44ae426082", "hex");

async function service() {
  store = new RelayStore(":memory:");
  filesDir = mkdtempSync(join(tmpdir(), "relay-issues-"));
  server = await startRelayServer({ store, filesDir, host: "127.0.0.1", port: 0, name: "测试组" });
  const anon = new RelayClient(server.url);
  const me = await anon.register("老戴", "pw-dai");
  const url = server.url;
  const call = async <T,>(method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string }): Promise<T> => {
    const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${me.key}`, ...(raw ? { "content-type": raw.type } : { "content-type": "application/json" }) }, body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json()) as T & { message?: string };
    if (!res.ok) throw new Error(json.message ?? String(res.status));
    return json;
  };
  return { url, key: me.key, call };
}

describe("问题页 (2026-10-31)", () => {
  it("reports an issue with a screenshot, the AI answers and asks, the person answers, it is fixed and released", async () => {
    const { url, key, call } = await service();
    // The page itself is plain; the download page links it.
    expect(await (await fetch(`${url}/issues`)).text()).toContain("· 问题");
    expect(await (await fetch(`${url}/`)).text()).toContain('href="/issues"');
    // Nothing without the account.
    expect((await fetch(`${url}/api/issues`)).status).toBe(401);

    const { image } = await call<{ image: { id: string; type: string } }>("POST", "/api/issues/images?name=%E6%88%AA%E5%9B%BE.png", undefined, { data: PNG, type: "image/png" });
    expect(image.type).toBe("image/png");
    await expect(call("POST", "/api/issues/images", undefined, { data: Buffer.from("hi"), type: "text/plain" })).rejects.toThrow("只能传图片");
    const shot = await fetch(`${url}/api/issues/images/${image.id}?key=${encodeURIComponent(key)}`);
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await shot.arrayBuffer()).equals(PNG)).toBe(true);

    const { issue } = await call<{ issue: Issue }>("POST", "/api/issues", { body: "任务里新会话的输入栏没有缓存\n切到别的任务再回来就空了", tool: "studio", version: "0.9.16", images: [image.id] });
    expect(issue).toMatchObject({ number: 1, title: "任务里新会话的输入栏没有缓存", status: "new", tool: "studio", version: "0.9.16", author: "老戴", awaitsAi: true, entryCount: 1 });
    expect(issue.entries![0]).toMatchObject({ kind: "report", ai: false, images: [{ id: image.id }] });
    // A picture goes with one entry only.
    await expect(call("POST", "/api/issues", { body: "再用一次", images: [image.id] })).rejects.toThrow("已经用过了");

    const first = await call<IssueList>("GET", "/api/issues");
    expect(first.issues.map((i) => i.number)).toEqual([1]);
    expect((await call<IssueList>("GET", `/api/issues?after=${first.rev}`)).issues).toEqual([]);

    // 值守's AI takes it and asks.
    await call("PATCH", "/api/issues/1", { status: "working", worker: "Opus 5.5 · 任务「问题 #1」", ai: true });
    const asked = (await call<{ issue: Issue }>("POST", "/api/issues/1/entries", { body: "是新建任务页还是任务里的「新会话」？", ai: true, status: "asking" })).issue;
    expect(asked).toMatchObject({ status: "asking", awaitsAi: false, worker: "Opus 5.5 · 任务「问题 #1」" });
    const changed = await call<IssueList>("GET", `/api/issues?after=${first.rev}`);
    expect(changed.issues.map((i) => i.number)).toEqual([1]);
    // The person answers: something for the AI again.
    expect((await call<{ issue: Issue }>("POST", "/api/issues/1/entries", { body: "任务里的新会话" })).issue).toMatchObject({ status: "asking", awaitsAi: true });
    await call("POST", "/api/issues/1/entries", { body: "修好了：草稿按会话存，切换时先写下去", ai: true, status: "fixed" });

    // 发布打包, then Studio says the build is out.
    expect((await call<{ release: { requestedAt: number | null } }>("POST", "/api/issues/release", {})).release.requestedAt).toBeTruthy();
    const out = await call<IssueList>("POST", "/api/issues/release/done", { version: "Studio 0.9.17", numbers: [1] });
    expect(out.release).toMatchObject({ requestedAt: null, last: { version: "Studio 0.9.17" } });
    expect(out.issues[0]).toMatchObject({ status: "released", fixedIn: "Studio 0.9.17", awaitsAi: false });

    // 「还不对」 on a released issue opens it again.
    const again = (await call<{ issue: Issue }>("POST", "/api/issues/1/entries", { body: "更新后还是空的" })).issue;
    expect(again).toMatchObject({ status: "new", awaitsAi: true });
    expect(again.entries!.map((e) => [e.kind, e.ai, e.status])).toEqual([
      ["report", false, null],
      ["status", true, "working"],
      ["comment", true, "asking"],
      ["comment", false, null],
      ["comment", true, "fixed"],
      ["status", true, "released"],
      ["comment", false, "new"],
    ]);
    await expect(call("PATCH", "/api/issues/1", { status: "done" })).rejects.toThrow("没有这个状态");
    await expect(call("GET", "/api/issues/9")).rejects.toThrow("没有问题 #9");
  });

  it("a test build says where it is: started, its steps, its end — the page reads it with the list", async () => {
    const { url, key } = await service();
    const client = new RelayClient(url, key);
    expect((await client.issues()).release.build).toBeNull();
    // A step with no build going on, or a bad one, is refused.
    await expect(client.reportIssueBuild({ step: 1 })).rejects.toThrow("现在没有在打包");
    await expect(client.reportIssueBuild({ start: { label: "AMO Studio 0.9.19", steps: [] } })).rejects.toThrow("1 到 12 个步骤");

    const started = await client.reportIssueBuild({ start: { label: "AMO Studio 0.9.19", steps: ["测试", "提交版本", "打包", "发布"] } });
    expect(started.build).toMatchObject({ label: "AMO Studio 0.9.19", step: 0, by: "老戴", endedAt: null, ok: null });
    const rev = (await client.issues()).rev;
    await client.reportIssueBuild({ step: 2 });
    // A step takes the counter up: the page's next look (after=rev) sees it.
    const later = await client.issues(rev);
    expect(later.rev).toBeGreaterThan(rev);
    // When each step began: the one skipped on the way (提交版本) began and ended at once.
    expect(later.release.build).toMatchObject({ step: 2, endedAt: null, stepAt: [started.build!.startedAt, expect.any(Number), expect.any(Number)] });
    await expect(client.reportIssueBuild({ step: 4 })).rejects.toThrow("步骤要在 2 到 3 之间");
    await expect(client.reportIssueBuild({ step: 1 })).rejects.toThrow("步骤要在 2 到 3 之间");

    // It stops at 打包: the step stays as where it stopped.
    const failed = await client.reportIssueBuild({ end: { ok: false, message: "npm run package:platform: exit 1" } });
    expect(failed.build).toMatchObject({ step: 2, ok: false, message: "npm run package:platform: exit 1", endedAt: expect.any(Number) });
    await expect(client.reportIssueBuild({ step: 3 })).rejects.toThrow("现在没有在打包");
    // The next one starts afresh; the last ones are kept, newest first (Jenkins' stage view on the page).
    await client.reportIssueBuild({ start: { label: "AMO Studio 0.9.19", steps: ["类型检查", "单测", "打包", "发布"] } });
    await client.reportIssueBuild({ step: 3 });
    const ok = await client.reportIssueBuild({ end: { ok: true, message: "已发到测试通道：AMO Studio 0.9.19" } });
    expect(ok.build).toMatchObject({ steps: ["类型检查", "单测", "打包", "发布"], step: 3, ok: true });
    expect(ok.builds.map((b) => b.ok)).toEqual([true, false]);
    // One that never said it ended is closed when the next starts.
    await client.reportIssueBuild({ start: { label: "AMO 便签 0.9.8", steps: ["打包", "发布"] } });
    const next = await client.reportIssueBuild({ start: { label: "AMO 便签 0.9.8", steps: ["打包", "发布"] } });
    expect(next.builds.map((b) => [b.ok, b.endedAt === null])).toEqual([[null, true], [false, false], [true, false], [false, false]]);
    expect(next.builds[1]!.message).toContain("没有报结束");
  });

  it("an issue keeps the Studio session that wrote on it last; 去会话讨论 is the person's", async () => {
    const { call } = await service();
    await call("POST", "/api/issues", { body: "便签的复制没有图" });
    expect((await call<{ issue: Issue }>("POST", "/api/issues/1/entries", { body: "哪个复制？", ai: true, status: "asking", session: "s-aaaa1111" })).issue).toMatchObject({ status: "asking", session: "s-aaaa1111" });
    // The person's own words do not change it; the AI's next update does.
    expect((await call<{ issue: Issue }>("POST", "/api/issues/1/entries", { body: "右键菜单里的", session: "s-zzzz" })).issue.session).toBe("s-aaaa1111");
    expect((await call<{ issue: Issue }>("PATCH", "/api/issues/1", { status: "working", ai: true, session: "s-bbbb2222" })).issue.session).toBe("s-bbbb2222");
    expect((await call<{ issue: Issue }>("PATCH", "/api/issues/1", { status: "discuss" })).issue).toMatchObject({ status: "discuss", session: "s-bbbb2222" });
  });

  it("an account renamed on the admin side keeps its issues", async () => {
    await service();
    const { IssueStore } = await import("./issues.js");
    const issues = new IssueStore(store!.db);
    issues.create("老戴", { body: "便签的复制没有图" });
    store!.renameMember("老戴", "戴");
    expect(issues.get(1).author).toBe("戴");
  });
});
