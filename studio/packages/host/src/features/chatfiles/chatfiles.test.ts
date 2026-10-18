import { execFileSync } from "node:child_process";
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
import { findByEnd, resolveMentioned } from "./service.js";

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

describe("a path written from inside the project (S18)", () => {
  it("links the one file of a git project whose path ends with it", async () => {
    const dir = join(root, "game");
    const sim = join(dir, "Unity", "Assets", "Simulation");
    mkdirSync(join(sim, "System", "V2"), { recursive: true });
    mkdirSync(join(sim, "Custom"), { recursive: true });
    mkdirSync(join(dir, "Docs"), { recursive: true });
    writeFileSync(join(sim, "System", "V2", "Resolver.cs"), "class A {}\n");
    writeFileSync(join(sim, "Custom", "Cache.Parts.cs"), "class B {}\n");
    writeFileSync(join(sim, "README.md"), "a\n");
    writeFileSync(join(dir, "Docs", "README.md"), "b\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.cs\n");
    writeFileSync(join(sim, "ignored.cs"), "\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "-A"], { cwd: dir });
    writeFileSync(join(sim, "Custom", "New.cs"), "\n"); // untracked, not ignored
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: dir })).data;
    const r = await api<FsExistsResult>("POST", "/api/fs/exists", {
      workspaceId: ws.id,
      paths: ["System/V2/Resolver.cs", "system\\v2\\resolver.cs", "Cache.Parts.cs", "./Custom/Cache.Parts.cs", "New.cs", "README.md", "ignored.cs", "V2/Nope.cs", "../Resolver.cs"],
    });
    const at = (...p: string[]) => ({ path: join(ws.path, ...p), dir: false });
    expect(r.data.found["System/V2/Resolver.cs"]).toEqual(at("Unity", "Assets", "Simulation", "System", "V2", "Resolver.cs"));
    expect(r.data.found["system\\v2\\resolver.cs"]).toEqual(at("Unity", "Assets", "Simulation", "System", "V2", "Resolver.cs"));
    expect(r.data.found["Cache.Parts.cs"]).toEqual(at("Unity", "Assets", "Simulation", "Custom", "Cache.Parts.cs"));
    expect(r.data.found["./Custom/Cache.Parts.cs"]).toEqual(at("Unity", "Assets", "Simulation", "Custom", "Cache.Parts.cs"));
    expect(r.data.found["New.cs"]).toEqual(at("Unity", "Assets", "Simulation", "Custom", "New.cs"));
    // Two READMEs: which one is meant is unknown, so neither.
    expect(r.data.found["README.md"]).toBeNull();
    expect(r.data.found["ignored.cs"]).toBeNull();
    expect(r.data.found["V2/Nope.cs"]).toBeNull();
    expect(r.data.found["../Resolver.cs"]).toBeNull();
  });

  it("matches whole folder names, not the end of one", () => {
    const files = ["src/OldResolver.cs", "src/a/Resolver.cs", "lib/x/b.ts"];
    const list = { files, lower: files.map((f) => f.toLowerCase()) };
    expect(findByEnd("Resolver.cs", list)).toBe("src/a/Resolver.cs");
    expect(findByEnd("a/resolver.cs", list)).toBe("src/a/Resolver.cs");
    expect(findByEnd("/x/b.ts", list)).toBe("lib/x/b.ts");
    expect(findByEnd("ib/x/b.ts", list)).toBeNull();
    expect(findByEnd("x/", list)).toBeNull();
  });
});
