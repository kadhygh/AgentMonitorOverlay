import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANTHROPIC_DEFAULT_URL, CHATGPT_DEFAULT_URL, OPENAI_DEFAULT_URL, claudeEndpoint, codexEndpoint, tomlTables } from "./endpoints.js";

// 问题 #14 (2026-11-03): 设置 → 模型 shows where Claude 订阅 and GPT send requests, as ccswitch-style tools leave the setup.

const dirs: string[] = [];
function dir(files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "amo-endpoint-"));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("claudeEndpoint", () => {
  it("is Anthropic's own address when nothing is set", () => {
    const e = claudeEndpoint(dir());
    expect(e).toMatchObject({ url: ANTHROPIC_DEFAULT_URL, from: null, model: null });
    expect(claudeEndpoint(dir({ "settings.json": '{"permissions":{}}' }))).toMatchObject({ url: ANTHROPIC_DEFAULT_URL, from: null });
  });

  it("reads what ccswitch writes into settings.json's env", () => {
    const d = dir({ "settings.json": "﻿" + JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://relay.example.com/api", ANTHROPIC_MODEL: "kimi-k3", ANTHROPIC_AUTH_TOKEN: "sk-x" }, model: "opus" }) });
    const e = claudeEndpoint(d);
    expect(e.url).toBe("https://relay.example.com/api");
    expect(e.from).toBe(`${join(d, "settings.json")} 的 env.ANTHROPIC_BASE_URL`);
    expect(e.model).toBe("kimi-k3");
    expect(e.modelFrom).toContain("env.ANTHROPIC_MODEL");
    expect(JSON.stringify(e)).not.toContain("sk-x");
  });

  it("falls back to settings.json's model, and says when the file cannot be read", () => {
    expect(claudeEndpoint(dir({ "settings.json": '{"model":"sonnet"}' }))).toMatchObject({ model: "sonnet", url: ANTHROPIC_DEFAULT_URL });
    const bad = claudeEndpoint(dir({ "settings.json": "{ not json" }));
    expect(bad.url).toBe(ANTHROPIC_DEFAULT_URL);
    expect(bad.problem).toContain("读不了");
  });
});

describe("codexEndpoint", () => {
  const chatgpt = { "auth.json": JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x" } }) };

  it("is ChatGPT's address for a ChatGPT sign-in, the API's for a key, OPENAI_BASE_URL when set", () => {
    expect(codexEndpoint(dir(chatgpt), {})).toMatchObject({ url: CHATGPT_DEFAULT_URL, from: null });
    expect(codexEndpoint(dir({ "auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-1" }) }), {})).toMatchObject({ url: OPENAI_DEFAULT_URL });
    expect(codexEndpoint(dir(chatgpt), { OPENAI_BASE_URL: "https://proxy.example.com/v1" })).toMatchObject({ url: "https://proxy.example.com/v1", from: "环境变量 OPENAI_BASE_URL" });
  });

  it("reads the provider ccswitch writes into config.toml", () => {
    const toml = ['model_provider = "packycode"', 'model = "gpt-5.5-codex"  # comment', 'model_reasoning_effort = "high"', "", '[model_providers.packycode]', 'name = "packycode"', 'base_url = "https://codex-api.packycode.com/v1"', 'wire_api = "responses"', "requires_openai_auth = true"].join("\r\n");
    const d = dir({ "config.toml": toml, ...chatgpt });
    const e = codexEndpoint(d, { OPENAI_BASE_URL: "https://ignored" });
    expect(e.url).toBe("https://codex-api.packycode.com/v1");
    expect(e.from).toBe(`${join(d, "config.toml")} 的 [model_providers.packycode] base_url`);
    expect(e).toMatchObject({ model: "gpt-5.5-codex" });
  });

  it("follows `profile = …` and quoted table names", () => {
    const toml = ['profile = "work"', 'model = "gpt-5.5"', '[profiles.work]', "model_provider = 'my-relay'", 'model = "o5"', '[model_providers."my-relay"]', "base_url = 'http://10.0.0.2:8080/v1'"].join("\n");
    const e = codexEndpoint(dir({ "config.toml": toml }), {});
    expect(e).toMatchObject({ url: "http://10.0.0.2:8080/v1", model: "o5" });
    expect(e.modelFrom).toContain("[profiles.work] model");
  });

  it("says when the named provider has no address", () => {
    const e = codexEndpoint(dir({ "config.toml": 'model_provider = "gone"\n' }), {});
    expect(e.url).toBe("");
    expect(e.problem).toContain("gone");
    expect(codexEndpoint(dir({ "config.toml": 'model_provider = "ollama"\n' }), {}).url).toBe("http://localhost:11434/v1");
  });
});

describe("tomlTables", () => {
  it("keeps only string values, by table", () => {
    const t = tomlTables('a = "1"\nb = 2\n[x.y]\nc = "3"\n# d = "4"\n');
    expect([...t.get("")!]).toEqual([["a", "1"]]);
    expect([...t.get("x.y")!]).toEqual([["c", "3"]]);
  });
});
