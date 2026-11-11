import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DshStatus, ModelProfile, StateSnapshot } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { dshPermissionMode } from "../choices.js";
import { catalogPatchYaml, channelModels, dshModelId, dshModels, dshModelValue, modelPatchYaml, noImagesMessage } from "./dsh-runtime.js";
import { locateDshDesktop } from "@amo-studio/locate";
import { DSH_AUTH_KEY, DSH_DESKTOP_PATH_KEY, DSH_PATH_KEY, DSH_SOURCE_KEY, accountPatchYaml, describeDsh, dshAccountFile, dshAccountSignedIn, dshStatus, readDshAuth, resolveDsh, retryPatchYaml, type KvStore } from "./install.js";
import { turnEndOf } from "./subagents.js";
import { describeDshTool } from "./transcript.js";

const RETRY = ["    retryPolicy:", "      mode: normal", "      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, STREAM_CLOSED]"];

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

  it("keeps DSH's word that deepseek-flash takes images in a channel's catalog; the others stay text only (2026-11-11)", () => {
    const yaml = catalogPatchYaml("Dxx-DS", ["deepseek-v4-flash", "deepseek-flash"], "deepseek-flash");
    expect(yaml).toContain('    models:\n      - id: "deepseek-v4-flash"\n      - id: "deepseek-flash"\n        inputModalities: ["text", "image"]\n    retryPolicy:');
    expect(yaml).toContain('    model: "deepseek-flash"\n');
    // The channel's own 能看图: a relay's name for V4.1-Flash, and deepseek-flash put out.
    const marked = catalogPatchYaml("中转", ["deepseek/deepseek-v4.1-flash", "deepseek-flash"], "deepseek-flash", new Set(["deepseek/deepseek-v4.1-flash"]));
    expect(marked).toContain('      - id: "deepseek/deepseek-v4.1-flash"\n        inputModalities: ["text", "image"]\n      - id: "deepseek-flash"\n    retryPolicy:');
  });

  it("says why a picture was refused and where to change it (2026-11-11)", () => {
    const channel: ModelProfile = { id: "ch-1", runtime: "dsh", label: "Dxx-DS", custom: true, model: null, credentialId: "channel-ch-1" } as ModelProfile;
    const both = channelModels(["deepseek-v4-flash", "deepseek-flash"], null, null);
    expect(noImagesMessage(channel, both, "deepseek-official/deepseek-v4-flash", false)).toBe("「deepseek-v4-flash」不收图片；点输入框下面的型号（Alt M）换成「deepseek-flash（DeepSeek-V4.1-Flash）」再发（上下文不变）");
    // No model of the channel takes images: where to mark one.
    const one = channelModels(["deepseek-v4-flash"], null, null);
    expect(noImagesMessage(channel, one, undefined, false)).toBe(
      "「Dxx-DS」的型号都没标「能看图」：到 设置 → 模型 →「Dxx-DS」→ 编辑，在「能看图」那一行点亮能看图的型号（DeepSeek 能看图的是 DeepSeek-V4.1-Flash，官方叫 deepseek-flash；列表里没有就加一行，可以点「从网址读取」看这个网址叫它什么），保存后点输入框下面的型号（Alt M）换过去再发",
    );
    // The channel's own marks: a relay's name lit is the one to switch to.
    const relay = channelModels(["deepseek/v4-flash", "deepseek/v4.1-flash"], null, null);
    expect(noImagesMessage(channel, relay, "deepseek-official/deepseek/v4-flash", false, (id) => id.endsWith("/deepseek/v4.1-flash"))).toBe("「deepseek/v4-flash」不收图片；点输入框下面的型号（Alt M）换成「deepseek/v4.1-flash」再发（上下文不变）");
    // Switched during a turn: the process still runs the old one until it ends.
    expect(noImagesMessage(channel, both, "deepseek-official/deepseek-flash", true)).toBe("型号刚换过：这一轮做完才用上「deepseek-flash（DeepSeek-V4.1-Flash）」，现在这个不收图片；等这一轮做完再发图片");
    // A model that takes images, yet DSH said no: nothing to pick.
    expect(noImagesMessage(channel, both, "deepseek-official/deepseek-flash", false)).toMatch(/^DSH 说「deepseek-flash（DeepSeek-V4.1-Flash）」不收图片.*设置 → 模型 → DeepSeek 点「检查」/);
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
  const desktopBefore = process.env.AMO_STUDIO_DSH_DESKTOP;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-dshset-"));
    // This machine may have the desktop app; these tests are about the clone.
    process.env.AMO_STUDIO_DSH_DESKTOP = "";
  });
  afterEach(async () => {
    for (const h of running.splice(0)) await h.shutdown();
    removeTempDir(root);
    if (desktopBefore === undefined) delete process.env.AMO_STUDIO_DSH_DESKTOP;
    else process.env.AMO_STUDIO_DSH_DESKTOP = desktopBefore;
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
    expect((await profile()).unavailable).toMatch(/没找到 DeepSeek Harness 桌面版/);

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
    expect((await profile()).unavailable).toMatch(/没找到 DeepSeek Harness 桌面版/);
    status = await call<DshStatus>("PUT", "/api/dsh", { source: "clone" });
    expect(status).toMatchObject({ source: "clone", desktop: null, active: null });
    expect((await profile()).unavailable).toMatch(/还没有设置 DSH 源码位置/);
    await expect(call("PUT", "/api/dsh", { source: "npm" })).rejects.toThrow(/source must be/);

    // The desktop app's folder (2026-11-02): only one that has the app; null goes back to looking for it.
    await expect(call("PUT", "/api/dsh", { desktopPath: root })).rejects.toThrow(/里没有 DeepSeek Harness 桌面版/);
    const app = join(root, "elsewhere", "DeepSeek Harness");
    mkdirSync(join(app, "resources"), { recursive: true });
    writeFileSync(join(app, "DeepSeek Harness.exe"), "");
    writeFileSync(join(app, "resources", "app.asar"), "");
    expect(await call<DshStatus>("PUT", "/api/dsh", { desktopPath: app })).toMatchObject({ desktopChosen: app, desktop: { path: app, from: "chosen" } });
    expect(await call<DshStatus>("PUT", "/api/dsh", { desktopPath: null })).toMatchObject({ desktopChosen: null });
  });
});

describe("DSH source (2026-10-26)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-dshsrc-"));
  });
  afterEach(() => removeTempDir(root));
  const kv = (values: Record<string, string>): KvStore => ({ getKv: (k) => (k in values ? { value: values[k]! } : undefined), setKv: () => undefined });

  it("runs the desktop app when it is installed, the clone when it is chosen or there is no desktop app", () => {
    // A stand-in desktop app: its exe and app.asar (the exe cannot tell its version, so that stays unknown).
    const desktop = join(root, "DeepSeek Harness");
    mkdirSync(join(desktop, "resources"), { recursive: true });
    writeFileSync(join(desktop, "DeepSeek Harness.exe"), "");
    writeFileSync(join(desktop, "resources", "app.asar"), "");
    const clone = join(root, "deepseek-harness");
    mkdirSync(join(clone, "apps", "cli", "lib"), { recursive: true });
    writeFileSync(join(clone, "apps", "cli", "package.json"), JSON.stringify({ version: "0.2.1-rc.2" }));
    writeFileSync(join(clone, "apps", "cli", "lib", "bin.js"), "");
    const env = { AMO_STUDIO_DSH_DESKTOP: desktop, AMO_STUDIO_NODE: process.execPath };

    expect(resolveDsh(kv({ [DSH_PATH_KEY]: clone }), env)).toMatchObject({
      kind: "desktop",
      command: join(desktop, "DeepSeek Harness.exe"),
      args: ["--expose-internals", join(desktop, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(resolveDsh(kv({ [DSH_PATH_KEY]: clone, [DSH_SOURCE_KEY]: "clone" }), env)).toMatchObject({ kind: "clone", command: process.execPath, args: [join(clone, "apps", "cli", "lib", "bin.js")], version: "0.2.1-rc.2" });
    const none = { AMO_STUDIO_DSH_DESKTOP: join(root, "nowhere"), AMO_STUDIO_NODE: process.execPath };
    expect(resolveDsh(kv({ [DSH_PATH_KEY]: clone }), none)).toMatchObject({ kind: "clone" });
    expect(resolveDsh(kv({}), none)).toEqual({ error: expect.stringMatching(/没找到 DeepSeek Harness 桌面版/) });
  });

  it("the desktop app in a folder chosen in 设置 (2026-11-02), else the usual one or the registry's", () => {
    const chosen = join(root, "D", "DeepSeek Harness");
    mkdirSync(join(chosen, "resources"), { recursive: true });
    writeFileSync(join(chosen, "DeepSeek Harness.exe"), "");
    writeFileSync(join(chosen, "resources", "app.asar"), "");
    const env = { LOCALAPPDATA: join(root, "local"), AMO_STUDIO_DSH_REGISTRY: "0", AMO_STUDIO_NODE: process.execPath };
    expect(resolveDsh(kv({ [DSH_DESKTOP_PATH_KEY]: chosen }), env)).toMatchObject({ kind: "desktop", command: join(chosen, "DeepSeek Harness.exe") });
    expect(dshStatus(kv({ [DSH_DESKTOP_PATH_KEY]: chosen }), env)).toMatchObject({ desktop: { path: chosen, from: "chosen" }, desktopChosen: chosen });
    expect(resolveDsh(kv({}), env)).toEqual({ error: expect.stringMatching(/没找到/) });
    expect(locateDshDesktop(env, null, () => [join(root, "nowhere"), chosen])).toMatchObject({ dir: chosen, from: "registry" });
    // AMO_STUDIO_DSH_DESKTOP set ("" = nowhere): no usual folder, no registry — but the chosen folder still counts.
    expect(locateDshDesktop({ ...env, AMO_STUDIO_DSH_DESKTOP: "" }, null, () => [chosen])).toBeNull();
    expect(locateDshDesktop({ ...env, AMO_STUDIO_DSH_DESKTOP: "" }, chosen, () => [])).toMatchObject({ dir: chosen, from: "chosen" });
  });
});

describe("DeepSeek sign-in (2026-11-03)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-dshauth-"));
  });
  afterEach(() => removeTempDir(root));
  const kv = (values: Record<string, string>): KvStore => ({ getKv: (k) => (k in values ? { value: values[k]! } : undefined), setKv: () => undefined });

  it("uses the key when one is saved and nothing was chosen, else the desktop app's account; a choice wins", () => {
    expect(readDshAuth(kv({}), true)).toBe("key");
    expect(readDshAuth(kv({}), false)).toBe("account");
    expect(readDshAuth(kv({ [DSH_AUTH_KEY]: "account" }), true)).toBe("account");
    expect(readDshAuth(kv({ [DSH_AUTH_KEY]: "key" }), false)).toBe("key");
  });

  it("finds the desktop app's sign-in in its DSH home without reading the token out", () => {
    const file = dshAccountFile({ DSH_HOME: root });
    expect(file).toBe(join(root, ".credentials.yaml"));
    expect(dshAccountFile({}).endsWith(join(".dsh", ".credentials.yaml"))).toBe(true);
    expect(dshAccountSignedIn(file)).toBe(false);
    writeFileSync(file, ["version: 1", "records:", "  deepseek-account-platform/device:", "    kind: grant", "refs:", "  DEEPSEEK_API_KEY: sk-x", ""].join("\n"));
    expect(dshAccountSignedIn(file)).toBe(false);
    writeFileSync(file, ["version: 1", "records:", "  deepseek-account-platform/default:", "    kind: grant", ""].join("\r\n"));
    expect(dshAccountSignedIn(file)).toBe(true);
    expect(dshStatus(kv({}), { DSH_HOME: root, AMO_STUDIO_DSH_DESKTOP: "" }, false)).toMatchObject({ auth: "account", keySaved: false, account: { file, signedIn: true } });
  });

  it("points DSH's credential store at the app's file and starts the ACP agent on the account", () => {
    const yaml = accountPatchYaml(String.raw`C:\Users\me\.dsh\.credentials.yaml`, "deepseek-flash");
    expect(yaml).toContain(["- id: credentials", "  config:", '    path: "C:\\\\Users\\\\me\\\\.dsh\\\\.credentials.yaml"', "- id: acp", "  config:", "    provider: deepseek-account", '    model: "deepseek-flash"', ""].join("\n"));
    expect(yaml).toContain(["- id: llm-deepseek-account", "  config:", ...RETRY].join("\n"));
  });

  it("asks DSH again after a stream cut off before its end, on both routes and in every patch (2026-11-07)", () => {
    // Checked against the clone with its mock server: without it the turn fails on STREAM_CLOSED, with it the second
    // request answers and the cut-off half is not in the reply.
    expect(retryPatchYaml()).toContain(["- id: llm-deepseek", "  config:", ...RETRY, "- id: llm-deepseek-account", "  config:", ...RETRY].join("\n"));
    expect(modelPatchYaml("deepseek-official", "deepseek-v4-pro")).toContain(["- id: llm-deepseek", "  config:", ...RETRY, "- id: acp"].join("\n"));
    // The catalog's llm-deepseek entry says both (a patch's config replaces the entry's whole config).
    expect(catalogPatchYaml("中转", ["a/x"], "a/x")).toContain(["- id: llm-deepseek", "  config:", "    models:", '      - id: "a/x"', ...RETRY, "- id: acp"].join("\n"));
  });
});

describe("DSH subagent turn endings", () => {
  it("says why an agent's turn did not finish", () => {
    expect(turnEndOf({ kind: "completed" })).toEqual({ state: "completed" });
    expect(turnEndOf({ kind: "error", error: { message: "DeepSeek Messages stream ended before message_stop", code: "STREAM_CLOSED" } })).toEqual({ state: "failed", error: "DeepSeek Messages stream ended before message_stop（STREAM_CLOSED）" });
    expect(turnEndOf({ kind: "error", error: { message: "boom", code: "UNKNOWN" } })).toEqual({ state: "failed", error: "boom" });
    expect(turnEndOf({ kind: "error", error: {} })).toEqual({ state: "failed", error: "出错了" });
    expect(turnEndOf({ kind: "aborted", reason: { kind: "parent" } })).toEqual({ state: "interrupted", note: "父会话停下了这个子 agent" });
    expect(turnEndOf({ kind: "aborted", reason: { kind: "hook", reason: "budget" } }).note).toBe("子 agent 被钩子停下了：budget");
    expect(turnEndOf({ kind: "max-tokens" }).note).toMatch(/max-tokens/);
    expect(turnEndOf({ kind: "something-new" })).toEqual({ state: "interrupted", note: "子 agent 停下了（something-new）" });
    expect(turnEndOf(undefined).note).toBe("子 agent 停下了（原因不明）");
  });
});
