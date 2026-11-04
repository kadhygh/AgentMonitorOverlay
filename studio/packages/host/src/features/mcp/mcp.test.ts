import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_SECRET_MASK, type ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { StaticCredentialReader } from "../../runtime/credentials.js";
import { codexServerSpec } from "../../runtime/profiles.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { expandVars, projectServers, userServers } from "./local.js";

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let secrets: Record<string, string>;
let claudeDir: string;
let configFile: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-mcp-"));
  claudeDir = join(root, "claude");
  configFile = join(claudeDir, ".claude.json");
  project = join(root, "Alpha");
  mkdirSync(claudeDir);
  mkdirSync(join(project, ".claude"), { recursive: true });
  // The person's own Claude Code config: a user-level server, the relay's MCP, this project's own entry (keyed as
  // Claude Code writes it: forward slashes), and a .mcp.json with one approved and one not.
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" }, "amo-relay": { command: "node", args: ["relay.mjs"] }, amo: { command: "x" } },
      projects: { [project.replaceAll("\\", "/")]: { mcpServers: { "pixso-desktop": { type: "http", url: "http://127.0.0.1:3667/mcp" } }, enabledMcpjsonServers: ["shared-ok"] } },
    }),
  );
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "shared-ok": { command: "npx", args: ["ok"] }, "shared-new": { command: "npx", args: ["${HOME_TOOL:-tool}"], env: { KEY: "${MCP_TEST_KEY}" } } } }));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  secrets = {};
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { credentials: new StaticCredentialReader(secrets), localClaudeHome: claudeDir, claudeConfigFile: configFile });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const names = (entries: Array<{ name: string; on: boolean }>) => Object.fromEntries(entries.map((e) => [e.name, e.on]));

describe("the person's Claude Code config", () => {
  it("reads user, local and project servers, with Claude Code's approvals", () => {
    expect(userServers(configFile).map((s) => s.name)).toEqual(["figma", "amo-relay"]);
    const own = projectServers(configFile, claudeDir, project);
    expect(own.map((s) => [s.name, s.source, s.approved])).toEqual([
      ["pixso-desktop", "local", undefined],
      ["shared-ok", "project", true],
      ["shared-new", "project", null],
    ]);
    // A project folder written with backslashes and another case is the same entry.
    expect(projectServers(configFile, claudeDir, project.toUpperCase()).map((s) => s.name)).toContain("pixso-desktop");
    expect(userServers(join(root, "missing.json"))).toEqual([]);
  });

  it("expands ${VAR} and ${VAR:-default} as Claude Code does in .mcp.json", () => {
    const spec = projectServers(configFile, claudeDir, project).find((s) => s.name === "shared-new")!.spec;
    expect(expandVars(spec, { MCP_TEST_KEY: "k1" })).toEqual({ type: "stdio", command: "npx", args: ["tool"], env: { KEY: "k1" } });
  });
});

describe("MCP 设置", () => {
  it("lists the global level: Studio's, the person's user servers; amo-relay off by default, amo never", () => {
    const state = service.mcp.state();
    expect(state.loadLocal).toBe(true);
    expect(names(state.entries)).toEqual({ figma: true, "amo-relay": false });
    expect(state.entries.find((e) => e.name === "amo-relay")?.note).toContain("team_ask");
  });

  it("keeps Studio's servers with their secrets in the credential store, masked when shown", () => {
    const s = service.mcp.create({ name: "img", spec: { command: "npx", args: ["-y", "img-mcp"], env: { IMG_KEY: "sk-1", EMPTY: "" } } });
    expect(s.spec.env).toEqual({ IMG_KEY: MCP_SECRET_MASK, EMPTY: "" });
    expect(JSON.parse(secrets[`mcp-${s.id}`]!)).toEqual({ env: { IMG_KEY: "sk-1", EMPTY: "" } });
    expect(store.getKv("mcp:servers")?.value).not.toContain("sk-1");
    // Sending the mask back keeps the stored value; a new value replaces it.
    service.mcp.update(s.id, { spec: { command: "npx", args: ["-y", "img-mcp"], env: { IMG_KEY: MCP_SECRET_MASK, EMPTY: "e" } } });
    expect(JSON.parse(secrets[`mcp-${s.id}`]!)).toEqual({ env: { IMG_KEY: "sk-1", EMPTY: "e" } });
    expect(() => service.mcp.create({ name: "img", spec: { command: "x" } })).toThrow("已经有");
    expect(() => service.mcp.create({ name: "amo", spec: { command: "x" } })).toThrow("Studio 自己");
    expect(() => service.mcp.create({ name: "bad name", spec: { command: "x" } })).toThrow("名字");
    expect(() => service.mcp.create({ name: "nourl", spec: { type: "http" } })).toThrow("url");
    service.mcp.remove(s.id);
    expect(secrets[`mcp-${s.id}`]).toBeUndefined();
    expect(service.mcp.state().servers).toEqual([]);
  });

  it("resolves global → project → session, and the task's next session inherits", async () => {
    const ws = store.addWorkspace({ name: "Alpha", path: project });
    const p0 = service.mcp.project(ws.id);
    expect(names(p0.entries)).toEqual({ "pixso-desktop": true, "shared-ok": true, "shared-new": false, figma: true, "amo-relay": false });
    expect(p0.entries.find((e) => e.name === "shared-new")?.note).toContain("还没批准");
    service.mcp.setGlobal({ choices: { figma: false } });
    const p1 = service.mcp.setProject(ws.id, { choices: { figma: true, "shared-new": true } });
    expect(p1.entries.find((e) => e.name === "figma")).toMatchObject({ on: true, inherited: false, choice: true });

    const task = store.createTask({ workspaceId: ws.id, title: "t" });
    const session = await service.tasks.startSession({ taskId: task.id, topicId: null }, ws, { profileId: "p-ds" });
    // Codex: no per-session choices (its app-server is shared).
    await expect(service.mcp.setSession(session.id, { choices: { figma: false } })).rejects.toThrow("Codex");

    // A DSH session (made in the store; this test has no DSH): choices on the session itself.
    const dsh = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "dsh", profileId: "p-ds", workspaceId: ws.id, title: "", status: "idle", runtimeRef: null, writer: "workbench" } as never);
    // The runtimes store the options (this test's Codex runtime does not know a DSH session).
    service.runtime.setOptions = async (id, options) => store.updateSession(id, { options });
    const after = await service.mcp.setSession(dsh.id, { choices: { figma: false, "pixso-desktop": false } });
    expect(names(after.entries)).toMatchObject({ figma: false, "pixso-desktop": false, "shared-new": true });
    expect(store.getSession(dsh.id)?.options.mcp).toEqual({ figma: false, "pixso-desktop": false });
    expect(service.mcp.inherited(task.id)).toEqual({ figma: false, "pixso-desktop": false });
    // null follows the level above again.
    await service.mcp.setSession(dsh.id, { choices: { "pixso-desktop": null } });
    expect(store.getSession(dsh.id)?.options.mcp).toEqual({ figma: false });
  });

  it("works out what each runtime starts with", () => {
    const ws = store.addWorkspace({ name: "Alpha", path: project });
    const img = service.mcp.create({ name: "img", spec: { command: "npx", env: { IMG_KEY: "sk-1" } } });
    service.mcp.setProject(ws.id, { choices: { "shared-new": true, figma: false } });
    // Claude in the person's own dir: their servers load natively; off ones are denied, .mcp.json ones approved.
    const native = service.mcp.launch({ workspaceId: ws.id }, true);
    expect(native.strict).toBe(false);
    expect(native.explicit).toEqual({ img: { type: "stdio", command: "npx", env: { IMG_KEY: "sk-1" } } });
    expect(native.deny.sort()).toEqual(["amo-relay", "figma"]);
    expect(native.enableJson.sort()).toEqual(["shared-new", "shared-ok"]);
    // Elsewhere (DSH, another account's dir): everything that is on, passed explicitly; strict.
    const explicit = service.mcp.launch({ workspaceId: ws.id, mcp: { img: false } }, false);
    expect(explicit.strict).toBe(true);
    expect(Object.keys(explicit.explicit).sort()).toEqual(["pixso-desktop", "shared-new", "shared-ok"]);
    // 加载本机 off: only Studio's, strict even natively.
    service.mcp.setGlobal({ loadLocal: false });
    expect(service.mcp.launch({ workspaceId: ws.id }, true)).toEqual({ explicit: { img: { type: "stdio", command: "npx", env: { IMG_KEY: "sk-1" } } }, deny: [], enableJson: [], strict: true });
    expect(service.mcp.state().entries.map((e) => e.name)).toEqual(["img"]);
    // Codex: Studio's servers that are on globally.
    expect(Object.keys(service.mcp.codexServers())).toEqual(["img"]);
    service.mcp.update(img.id, { on: false });
    expect(service.mcp.codexServers()).toEqual({});
  });

  it("keeps the statuses Claude sessions report and lists servers only seen there", () => {
    service.mcp.noteStatus("s1", [
      { name: "figma", status: "needs-auth", source: "user" },
      { name: "plugin:github", status: "connected", source: "plugin" },
      { name: "amo", status: "connected", source: "sdk" },
    ]);
    const entries = service.mcp.state().entries;
    expect(entries.find((e) => e.name === "figma")?.status?.status).toBe("needs-auth");
    expect(entries.find((e) => e.name === "plugin:github")).toMatchObject({ source: "seen", on: true });
    expect(entries.some((e) => e.name === "amo")).toBe(false);
  });
});

describe("Codex gets Studio's servers when its app-server starts", () => {
  it("passes them by -c, secrets in the env and kept from the agent's commands", () => {
    const spec = codexServerSpec(PROFILES[0]!, PROFILES, new StaticCredentialReader({}), {
      providers: { "amo-ds": { name: "DS", baseUrl: "http://x", wireApi: "responses", envKey: "DS_KEY" } } as never,
      extraMcp: { img: { type: "stdio", command: "npx", args: ["-y", "img"], env: { IMG_KEY: "sk-1", PATH: "C:/bin" } }, web: { type: "http", url: "https://w/mcp", headers: { Authorization: "Bearer t" } }, old: { type: "sse", url: "https://s" } },
      baseEnv: { PATH: "C:/Windows" },
    });
    const args = spec.configArgs.join(" ");
    expect(args).toContain('mcp_servers.img.command="npx"');
    expect(args).toContain('mcp_servers.img.args=["-y","img"]');
    expect(args).toContain('mcp_servers.img.env_vars=["IMG_KEY"]');
    expect(args).toContain('mcp_servers.img.env.PATH="C:/bin"');
    expect(args).toContain('mcp_servers.web.env_http_headers={"Authorization"="AMO_STUDIO_MCP_H0"}');
    expect(args).not.toContain("sk-1");
    expect(args).not.toContain("Bearer t");
    expect(args).not.toContain("mcp_servers.old");
    expect(spec.env).toMatchObject({ IMG_KEY: "sk-1", AMO_STUDIO_MCP_H0: "Bearer t" });
    expect(args).toMatch(/shell_environment_policy\.exclude=\[[^\]]*"IMG_KEY"[^\]]*\]/);
    expect(args).toMatch(/shell_environment_policy\.exclude=\[[^\]]*"AMO_STUDIO_MCP_H0"[^\]]*\]/);
  });
});
