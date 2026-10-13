import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, OpenInResult, TextFile, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { cliScript, decode } from "./service.js";

// Opening files outside Studio and reading them for a quick look (stage 12, S12-0). Test mode only records launches.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let http: HostServer;

beforeEach(async () => {
  vi.stubEnv("AMO_STUDIO_TEST", "1");
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-openin-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
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

function makeProject(): string {
  const dir = join(root, "game");
  mkdirSync(join(dir, "Assets"), { recursive: true });
  writeFileSync(join(dir, "Assets", "Player.cs"), "﻿public class Player {}\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return dir;
}

describe("open in", () => {
  it("opens project files in Explorer and the default program (recorded in test mode)", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    const r = await api<OpenInResult>("POST", "/api/open-in", { path: "Assets/Player.cs", workspaceId: ws.id, app: "explorer" });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ app: "explorer", path: join(ws.path, "Assets", "Player.cs"), dryRun: true });
    expect(service.openIn.launches.at(-1)).toEqual({ command: "explorer.exe", args: [`/select,"${join(ws.path, "Assets", "Player.cs")}"`] });

    await api("POST", "/api/open-in", { path: join(ws.path, "Assets"), app: "default" });
    expect(service.openIn.launches.at(-1)!.args).toEqual([`"${join(ws.path, "Assets")}"`]);
  });

  it("refuses missing files, unknown apps and relative paths without a project", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    expect((await api("POST", "/api/open-in", { path: "nope.cs", workspaceId: ws.id, app: "explorer" })).status).toBe(404);
    expect((await api("POST", "/api/open-in", { path: "Assets/Player.cs", workspaceId: ws.id, app: "notepad" })).status).toBe(400);
    expect((await api("POST", "/api/open-in", { path: "Assets/Player.cs", app: "explorer" })).status).toBe(400);
    expect(service.openIn.launches).toEqual([]);
  });

  it("tells whether VS Code is there", async () => {
    const r = await api<{ vscode: boolean }>("GET", "/api/open-in/apps");
    expect(r.status).toBe(200);
    expect(typeof r.data.vscode).toBe("boolean");
  });

  it("finds VS Code's CLI script through bin/code.cmd", () => {
    const install = join(root, "Microsoft VS Code");
    mkdirSync(join(install, "bin"), { recursive: true });
    mkdirSync(join(install, "abc123", "resources", "app", "out"), { recursive: true });
    writeFileSync(join(install, "abc123", "resources", "app", "out", "cli.js"), "");
    writeFileSync(join(install, "bin", "code.cmd"), '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\abc123\\resources\\app\\out\\cli.js" %*\r\n');
    expect(cliScript(join(install, "Code.exe"))).toBe(join(install, "abc123", "resources", "app", "out", "cli.js"));
    expect(cliScript(join(root, "elsewhere", "Code.exe"))).toBeNull();
  });
});

describe("quick look", () => {
  it("reads text files and tells binary ones", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    const text = await api<TextFile>("GET", `/api/fs/text?workspaceId=${ws.id}&path=${encodeURIComponent("Assets/Player.cs")}`);
    expect(text.status).toBe(200);
    expect(text.data.text).toBe("public class Player {}\n");
    const bin = await api<TextFile>("GET", `/api/fs/text?path=${encodeURIComponent(join(ws.path, "logo.png"))}`);
    expect(bin.data.binary).toBe(true);
    expect(bin.data.text).toBeUndefined();
    expect((await api("GET", `/api/fs/text?path=${encodeURIComponent(join(ws.path, "Assets"))}`)).status).toBe(400);
  });

  it("serves images with the token in the query, nothing else", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    const img = await fetch(`${http.url}/api/fs/raw?path=${encodeURIComponent(join(ws.path, "logo.png"))}&token=${TOKEN}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toContain("image/png");
    const cs = await fetch(`${http.url}/api/fs/raw?path=${encodeURIComponent(join(ws.path, "Assets", "Player.cs"))}&token=${TOKEN}`);
    expect(cs.status).toBe(400);
  });

  it("decodes UTF-16 with a BOM", () => {
    expect(decode(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toBe("AB");
    expect(decode(Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toBe("A");
    expect(decode(Buffer.from([0x41, 0x00, 0x42]))).toBeNull();
  });
});
