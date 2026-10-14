import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// PATCH /api/sessions/:id/options with 「Fast」 (stage 13): true / false are kept with the session, null clears it.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-gpt", label: "GPT", runtime: "codex", provider: null, model: null }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-options-route-"));
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

describe("session options over HTTP", () => {
  it("keeps Fast on and off with the session, clears it with null, and refuses other values", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, "ws") })).data;
    const { session } = (await api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "t", workspaceId: ws.id, firstSession: { profileId: "p-gpt", options: { fast: true } } })).data;
    expect(session.options).toEqual({ fast: true });
    const path = `/api/sessions/${session.id}/options`;

    expect((await api<Session>("PATCH", path, { effort: "low" })).data.options).toEqual({ fast: true, effort: "low" });
    expect((await api<Session>("PATCH", path, { fast: false })).data.options).toEqual({ fast: false, effort: "low" });
    // Kept in the database.
    const reopened = new Store(join(root, "studio.db"));
    expect(reopened.getSession(session.id)!.options).toEqual({ fast: false, effort: "low" });
    reopened.close();
    expect((await api<Session>("PATCH", path, { fast: null })).data.options).toEqual({ effort: "low" });
    expect((await api("PATCH", path, { fast: "yes" })).status).toBe(400);
  });
});
