import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Annotation, ModelProfile, QuestionReply, Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// POST /api/sessions/:id/questions/:itemId/answer (stage 12, S12-B): the reply is checked against the item before the
// runtime sends it on.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;
let runtime: CodexRuntime;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-questions-route-"));
  mkdirSync(join(root, "ws"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  const service = new HostService(store, runtime, PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

const until = async (pred: () => boolean, label: string) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 4000) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("answering a question over HTTP", () => {
  it("checks the reply against the question, then answers it once", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, "ws") })).data;
    const { session } = (await api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "t", workspaceId: ws.id, firstSession: { profileId: "p-ds", text: "[[form]]" } })).data;
    const question = () => store.listItems(session.id).find((i): i is Extract<SessionItem, { type: "question" }> => i.type === "question");
    await until(() => !!question(), "the form");
    const path = `/api/sessions/${session.id}/questions/${question()!.id}/answer`;

    expect((await api("POST", path, { action: "approve" })).status).toBe(400);
    expect((await api("POST", path, { action: "nope" })).status).toBe(400);
    const invalid = await api<{ error: { message: string } }>("POST", path, { action: "submit", values: { version: "", channel: "steam" } });
    expect(invalid.status).toBe(400);
    expect(invalid.data.error.message).toBe("版本号：必填");
    expect((await api("POST", `/api/sessions/${session.id}/questions/i-missing/answer`, { action: "dismiss" })).status).toBe(404);

    expect(await api("POST", path, { action: "submit", values: { version: "2.0", channel: "steam" } })).toEqual({ status: 200, data: { ok: true } });
    expect(question()).toMatchObject({ state: "answered", values: { version: "2.0", channel: "steam" } });
    expect((await api("POST", path, { action: "dismiss" })).status).toBe(409);
  });

  it("要修改 from the plan window: the plan's annotations go after the text and count as sent (2026-11-09)", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, "ws") })).data;
    const { session } = (await api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "t", workspaceId: ws.id, firstSession: { profileId: "p-ds", text: "hi" } })).data;
    // A plan Claude asks to have reviewed (the Claude runtime makes these; here it is put in by hand and answered by a stand-in).
    const plan = ["# 计划", "", "第一步：加上重试", "第二步：写测试"].join("\n");
    const item = store.appendItem({ id: "i-plan-1", sessionId: session.id, createdAt: new Date().toISOString(), type: "question", source: "plan-review", plan, state: "pending" } as never);
    const replies: QuestionReply[] = [];
    runtime.answerQuestion = async (_s, _i, reply) => void replies.push(reply);

    const start = plan.indexOf("加上重试");
    const made = await api<Annotation>("POST", `/api/sessions/${session.id}/annotations`, { itemId: item.id, quote: "加上重试", start, end: start + 4, prefix: "", suffix: "", note: "重试三次就够" });
    expect(made.status).toBe(200);
    expect((await api("POST", `/api/sessions/${session.id}/annotations`, { itemId: item.id, quote: "x", start: 0, end: plan.length + 5, note: "n" })).status).toBe(400);
    // Not sent as a message of its own: it goes with the review.
    expect((await api("POST", `/api/sessions/${session.id}/annotations/send`)).status).toBe(400);

    const path = `/api/sessions/${session.id}/questions/${item.id}/answer`;
    expect((await api("POST", path, { action: "revise", feedback: "  " })).status).toBe(400);
    expect((await api("POST", path, { action: "revise", feedback: "", annotations: ["an-missing"] })).status).toBe(400);
    expect(await api("POST", path, { action: "revise", feedback: "", annotations: [made.data.id] })).toEqual({ status: 200, data: { ok: true } });
    expect(replies).toHaveLength(1);
    const sent = replies[0] as Extract<QuestionReply, { action: "revise" }>;
    expect(sent.feedback).toContain(`【批注${made.data.n}】`);
    expect(sent.feedback).toContain("> 加上重试");
    expect(sent.feedback).toContain("我的批注：重试三次就够");
    expect(store.getAnnotation(made.data.id)?.sentAt).toBeTruthy();
  });
});
