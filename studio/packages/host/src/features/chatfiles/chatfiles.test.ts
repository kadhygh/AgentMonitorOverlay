import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FsExistsResult, ModelProfile, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { resolveMentioned } from "./service.js";

// Which files a conversation names exist (stage 12, S12-C).

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let http: HostServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-chatfiles-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${p}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

describe("POST /api/fs/exists", () => {
  it("tells which of the paths exist, relative to the project or a working directory", async () => {
    const dir = join(root, "game");
    mkdirSync(join(dir, "src", "sub"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    writeFileSync(join(dir, "src", "sub", "b.ts"), "\n");
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: dir })).data;
    const abs = join(ws.path, "src", "a.ts");
    const r = await api<FsExistsResult>("POST", "/api/fs/exists", { workspaceId: ws.id, paths: ["src/a.ts", "src\\a.ts", "src", "nope.ts", abs, `file:///${abs.replaceAll("\\", "/")}`, "\\\\server\\share\\x.ts"] });
    expect(r.status).toBe(200);
    expect(r.data.found["src/a.ts"]).toEqual({ path: abs, dir: false });
    expect(r.data.found["src\\a.ts"]).toEqual({ path: abs, dir: false });
    expect(r.data.found.src).toEqual({ path: join(ws.path, "src"), dir: true });
    expect(r.data.found["nope.ts"]).toBeNull();
    expect(r.data.found[abs]).toEqual({ path: abs, dir: false });
    expect(r.data.found[`file:///${abs.replaceAll("\\", "/")}`]?.path.toLowerCase()).toBe(abs.toLowerCase());
    expect(r.data.found["\\\\server\\share\\x.ts"]).toBeNull();

    const sub = await api<FsExistsResult>("POST", "/api/fs/exists", { workspaceId: ws.id, cwd: join(ws.path, "src", "sub"), paths: ["b.ts", "a.ts"] });
    expect(sub.data.found["b.ts"]).toEqual({ path: join(ws.path, "src", "sub", "b.ts"), dir: false });
    expect(sub.data.found["a.ts"]).toBeNull();
  });

  it("refuses bad requests; relative paths without a base are not found", async () => {
    expect((await api("POST", "/api/fs/exists", { paths: "a.ts" })).status).toBe(400);
    expect((await api("POST", "/api/fs/exists", { paths: Array.from({ length: 201 }, (_, i) => `${i}.ts`) })).status).toBe(400);
    const r = await api<FsExistsResult>("POST", "/api/fs/exists", { paths: ["a.ts"] });
    expect(r.data.found).toEqual({ "a.ts": null });
  });
});

describe("resolveMentioned", () => {
  const w = path.win32;
  it("resolves the ways a reply writes a path", () => {
    expect(resolveMentioned("src/a.ts", "C:\\p", w, true)).toBe("C:\\p\\src\\a.ts");
    expect(resolveMentioned("/src/a.ts", "C:\\p", w, true)).toBe("C:\\p\\src\\a.ts");
    expect(resolveMentioned("D:/x/y.cs", "C:\\p", w, true)).toBe("D:\\x\\y.cs");
    expect(resolveMentioned("file:///D:/x/y%20z.cs", null, w, true)).toBe("D:\\x\\y z.cs");
    expect(resolveMentioned("../q.md", "C:\\p\\a", w, true)).toBe("C:\\p\\q.md");
  });
  it("leaves out what is not a local file", () => {
    expect(resolveMentioned("https://example.com/a.ts", "C:\\p", w, true)).toBeNull();
    expect(resolveMentioned("\\\\srv\\share\\a.ts", "C:\\p", w, true)).toBeNull();
    expect(resolveMentioned("~/a.ts", "C:\\p", w, true)).toBeNull();
    expect(resolveMentioned("a.ts", null, w, true)).toBeNull();
    expect(resolveMentioned("file:///%E0", null, w, true)).toBeNull();
  });
});
