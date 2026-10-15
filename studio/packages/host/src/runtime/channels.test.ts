import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { ChannelRegistry } from "./channels.js";
import { StaticCredentialReader } from "./credentials.js";
import { codexServerSpec, type CodexProviderDef } from "./profiles.js";
import { claudeEnv, type ClaudeProviderDef } from "./claude/claude-env.js";

function kv() {
  const m = new Map<string, string>();
  return { getKv: (k: string) => (m.has(k) ? { value: m.get(k)! } : undefined), setKv: (k: string, v: string) => m.set(k, v) };
}

const BUILTINS: ModelProfile[] = [
  { id: "codex-default", label: "GPT", runtime: "codex", provider: null, model: null },
  { id: "claude-glm", label: "GLM", runtime: "claude", provider: "glm", model: "glm-5.3[1m]", credentialId: "glm-5.2" },
];

function registry(secrets: Record<string, string> = {}) {
  const store = kv();
  const credentials = new StaticCredentialReader(secrets);
  const codexProviders: Record<string, CodexProviderDef> = {};
  const claudeProviders: Record<string, ClaudeProviderDef> = { glm: { baseUrl: "https://glm.example" } };
  const r = new ChannelRegistry({ kv: store, credentials, builtins: BUILTINS, codexProviders, claudeProviders, builtinBalance: { "claude-glm": { baseUrl: "https://glm.example", config: { template: "general" } } } });
  return { r, store, credentials, codexProviders, claudeProviders };
}

describe("ChannelRegistry", () => {
  it("adds a Codex channel to the very profile list and provider table the runtimes hold", () => {
    const { r, codexProviders, credentials } = registry();
    const list = r.profiles;
    const c = r.create({ kind: "codex", label: "中转 GPT", baseUrl: "https://relay.example/v1/", model: "gpt-5.6-sol", key: "sk-relay" });
    expect(c).toMatchObject({ kind: "codex", baseUrl: "https://relay.example/v1", keySaved: true, keyFrom: null });
    expect(r.profiles).toBe(list);
    const p = list.find((x) => x.id === c.id)!;
    expect(p).toMatchObject({ runtime: "codex", provider: `amo-${c.id}`, model: "gpt-5.6-sol", custom: true });
    expect(codexProviders[`amo-${c.id}`]).toMatchObject({ baseUrl: "https://relay.example/v1", wireApi: "responses" });
    expect(credentials.read(p.credentialId!)).toBe("sk-relay");
    // The app-server launch picks it up: provider, base URL and the key through its env var only.
    const spec = codexServerSpec(p, list, credentials, { providers: codexProviders });
    expect(spec.configArgs.join(" ")).toContain(`model_providers.amo-${c.id}.base_url="https://relay.example/v1"`);
    expect(spec.configArgs.join(" ")).not.toContain("sk-relay");
    expect(Object.values(spec.env)).toContain("sk-relay");
  });

  it("a Claude channel routes Claude Code: base URL, key variable, model and the quick model", () => {
    const { r, claudeProviders, credentials } = registry();
    const c = r.create({ kind: "claude", label: "中转 Claude", baseUrl: "https://cc.example/api", model: "claude-opus-5-5", smallModel: "claude-haiku-5-5", claudeAuth: "x-api-key", key: "sk-cc" });
    const p = r.profiles.find((x) => x.id === c.id)!;
    const env = claudeEnv(p, claudeProviders, credentials, { dir: "C:/tmp/home", login: "token" }, {});
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: "https://cc.example/api", ANTHROPIC_API_KEY: "sk-cc", ANTHROPIC_MODEL: "claude-opus-5-5", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5" });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(claudeProviders[c.id]!.models![0]!.id).toBe("claude-opus-5-5");
  });

  it("reuses old AMO's DXX key without writing it, and edits report a routing change", () => {
    const { r, credentials } = registry({ dxx: "sk-dxx" });
    const c = r.create({ kind: "codex", label: "GPT-Dxx", baseUrl: "https://gorilla-api.dxxapi.com", keyFrom: "dxx" });
    expect(c).toMatchObject({ keyFrom: "dxx", keySaved: true });
    expect(r.profiles.find((x) => x.id === c.id)!.credentialId).toBe("dxx");
    expect(r.update(c.id, { label: "DXX" }).routingChanged).toBe(true);
    expect(r.update(c.id, { balance: { template: "general" } }).routingChanged).toBe(false);
    r.remove(c.id);
    expect(credentials.read("dxx")).toBe("sk-dxx");
    expect(r.profiles.some((x) => x.id === c.id)).toBe(false);
    expect(() => r.create({ kind: "codex", label: "x", baseUrl: "https://x.example", keyFrom: "glm-5.2" })).toThrow(/不能沿用/);
  });

  it("hides any profile from the pickers, but never the last visible one", () => {
    const { r } = registry();
    r.setHidden("codex-default", true);
    expect(r.profiles.find((p) => p.id === "codex-default")!.hidden).toBe(true);
    expect(() => r.setHidden("claude-glm", true)).toThrow(/至少要留一个/);
    r.setHidden("codex-default", false);
    expect(r.profiles.find((p) => p.id === "codex-default")!.hidden).toBeUndefined();
  });

  it("checks what it is given and survives a restart", () => {
    const { r, store, credentials } = registry();
    expect(() => r.create({ kind: "codex", label: "", baseUrl: "https://x.example" })).toThrow(/名字/);
    expect(() => r.create({ kind: "codex", label: "a", baseUrl: "ftp://x" })).toThrow(/http/);
    expect(() => r.create({ kind: "codex", label: "a", baseUrl: "https://x.example", model: "two words" })).toThrow(/空格/);
    expect(() => r.create({ kind: "claude", label: "a", baseUrl: "https://x.example", balance: { template: "custom" } })).toThrow(/查询地址/);
    const c = r.create({ kind: "claude", label: "a", baseUrl: "https://x.example", key: "k", balance: { template: "newapi", userId: "7" }, accessToken: "t" });
    expect(c.accessTokenSaved).toBe(true);
    const again = new ChannelRegistry({ kv: store, credentials, builtins: BUILTINS, codexProviders: {}, claudeProviders: {} });
    expect(again.profiles.map((p) => p.id)).toEqual(["codex-default", "claude-glm", c.id]);
    expect(again.balanceOf(c.id)).toMatchObject({ key: "k", accessToken: "t", config: { template: "newapi", userId: "7" } });
    // Built-in balance queries read the profile's own key.
    expect(registry({ "glm-5.2": "g" }).r.balanceOf("claude-glm")).toMatchObject({ key: "g" });
  });
});
