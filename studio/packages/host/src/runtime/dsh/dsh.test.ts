import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DshStatus, ModelProfile, StateSnapshot } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { dshPermissionMode } from "../choices.js";
import { catalogPatchYaml, channelModels, dshModelId, dshModels, dshModelValue } from "./dsh-runtime.js";
import { describeDsh } from "./install.js";
import { describeDshTool } from "./transcript.js";

const CONFIG = [
  {
    id: "model",
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options: [{ group: "deepseek-official", name: "DeepSeek", options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" }, { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro", description: "Stronger" }] }],
  },
  { id: "reasoning_effort", currentValue: "high", options: [{ value: "off" }, { value: "low" }, { value: "high" }, { value: "max" }] },
];

describe("DSH models and permissions", () => {
  it("names DSH's model routes as ids session options accept, and back", () => {
    expect(dshModels(CONFIG)).toEqual([
      { id: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", efforts: ["off", "low", "high", "max"], defaultEffort: "high", isDefault: true },
      { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek-V4-Pro", description: "Stronger", efforts: ["off", "low", "high", "max"], defaultEffort: "high" },
    ]);
    expect(dshModelId("plain")).toBe("plain");
    expect(dshModelValue("deepseek-official/deepseek-v4-pro", CONFIG)).toBe('["deepseek-official","deepseek-v4-pro"]');
    // Not offered (yet): the route is rebuilt.
    expect(dshModelValue("deepseek-official/deepseek-v5", null)).toBe('["deepseek-official","deepseek-v5"]');
    // A relay's name with a "/" of its own stays one name.
    expect(dshModelValue("deepseek-official/deepseek/deepseek-v4-pro", CONFIG)).toBe('["deepseek-official","deepseek/deepseek-v4-pro"]');
    expect(dshModelId('["deepseek-official","deepseek/deepseek-v4-pro"]')).toBe("deepseek-official/deepseek/deepseek-v4-pro");
  });

  it("gives a channel's own model names to DSH as its catalog, and to the pickers (2026-10-19)", () => {
    const yaml = catalogPatchYaml("中转", ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"], "deepseek/deepseek-v4-pro");
    expect(yaml).toContain('- id: llm-deepseek\n  config:\n    models:\n      - id: "deepseek/deepseek-v4.1-flash"\n      - id: "deepseek/deepseek-v4-pro"\n');
    expect(yaml).toContain('- id: acp\n  config:\n    provider: deepseek-official\n    model: "deepseek/deepseek-v4-pro"\n');
    expect(channelModels(["a/x", "a/y"], "deepseek-official/a/y", CONFIG)).toEqual([
      { id: "deepseek-official/a/x", label: "a/x", efforts: ["off", "low", "high", "max"], defaultEffort: "high" },
      { id: "deepseek-official/a/y", label: "a/y", efforts: ["off", "low", "high", "max"], defaultEffort: "high", isDefault: true },
    ]);
    expect(channelModels(["a/x"], null, null)[0]).toMatchObject({ isDefault: true, efforts: [] });
  });

  it("maps Studio's permission ids to DSH's sandbox, defaulting to the workspace", () => {
    expect(dshPermissionMode(undefined)).toBe("workspace-write");
    expect(dshPermissionMode("read-only")).toBe("read-only");
    expect(dshPermissionMode("full-access")).toBe("danger-full-access");
    expect(dshPermissionMode("ask")).toBe("workspace-write");
  });
});

describe("DSH tool rows", () => {
  const cwd = "C:\\work\\proj";
  it("shows shell calls as commands (or reads and listings), MCP tools by server and tool, edits with a diff", () => {
    expect(describeDshTool("pwsh", { command: "npm test", description: "run tests" }, cwd)).toMatchObject({ name: "shell", kind: "command", summary: "npm test", input: "npm test" });
    expect(describeDshTool("pwsh", { command: "Get-Content C:\\work\\proj\\a.txt" }, cwd)).toMatchObject({ kind: "read", summary: "a.txt" });
    expect(describeDshTool("mcp__amo__amo_whoami", {}, cwd)).toMatchObject({ kind: "mcp", summary: "amo · amo_whoami" });
    expect(describeDshTool("read", { path: "C:\\work\\proj\\src\\x.ts" }, cwd)).toMatchObject({ kind: "read", summary: "src/x.ts" });
    expect(describeDshTool("grep", { pattern: "TODO", path: "src" }, cwd)).toMatchObject({ kind: "search", summary: "TODO · src" });
    const edit = describeDshTool("str_replace_editor", { command: "str_replace", path: "C:\\work\\proj\\a.ts", old_str: "a", new_str: "b" }, cwd);
    expect(edit).toMatchObject({ kind: "edit", summary: "a.ts", files: [{ path: "a.ts", change: "update", added: 1, removed: 1 }] });
    expect(describeDshTool("write", { path: "n.md", content: "x\ny" }, cwd)).toMatchObject({ kind: "edit", files: [{ path: "n.md", change: "add", added: 2, removed: 0 }] });
    expect(describeDshTool("web_search", { query: "acp" }, cwd)).toMatchObject({ kind: "web", summary: "acp" });
  });
});

describe("DSH clone setting", () => {
  let root: string;
  const running: RunningHost[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-dshset-"));
  });
  afterEach(async () => {
    for (const h of running.splice(0)) await h.shutdown();
    removeTempDir(root);
  });

  it("keeps the DSH profile out of the pickers until a built clone is set; reads its version", async () => {
    const PROFILES: ModelProfile[] = [{ id: "dsh-deepseek", label: "DeepSeek", runtime: "dsh", provider: "deepseek-official", model: null, credentialId: "deepseek-v4" }];
    const host = await startHost({ dataDir: join(root, "data"), port: 0, profiles: PROFILES, servers: new FakeServers([]) });
    running.push(host);
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${host.info.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = (await res.json()) as T;
      if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(data)}`);
      return data;
    };
    const profile = async () => (await call<StateSnapshot>("GET", "/api/state")).profiles[0]!;
    expect((await profile()).unavailable).toMatch(/还没有设置 DSH 源码位置/);

    const clone = join(root, "deepseek-harness");
    mkdirSync(join(clone, "apps", "cli", "lib"), { recursive: true });
    writeFileSync(join(clone, "apps", "cli", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.1" }));
    await expect(call("PUT", "/api/dsh", { path: root })).rejects.toThrow(/不是 DSH 源码克隆/);
    let status = await call<DshStatus>("PUT", "/api/dsh", { path: clone });
    expect(status).toMatchObject({ path: clone, version: "0.2.1-rc.1", built: false });
    expect((await profile()).unavailable).toMatch(/还没有构建/);

    writeFileSync(join(clone, "apps", "cli", "lib", "bin.js"), "");
    expect(describeDsh(clone)?.built).toBe(true);
    status = await call<DshStatus>("PUT", "/api/dsh", { path: clone });
    expect(status.built).toBe(true);
    expect((await profile()).unavailable).toBeUndefined();

    await call("PUT", "/api/dsh", { path: null });
    expect((await profile()).unavailable).toMatch(/还没有设置/);
  });
});
