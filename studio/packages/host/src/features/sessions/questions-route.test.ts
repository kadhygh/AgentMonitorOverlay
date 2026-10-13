import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-questions-route-"));
  mkdirSync(join(root, "ws"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
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
});
