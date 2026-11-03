import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { RuntimeRouter } from "../../runtime/runtime.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 问题 #14 (2026-11-03): 设置 → 模型 asks the Host where Claude 订阅 and GPT send requests; the other profiles have none.

const PROFILES: ModelProfile[] = [
  { id: "codex-default", label: "GPT", runtime: "codex", provider: null, model: null },
  { id: "claude-subscription", label: "Claude", runtime: "claude", provider: "anthropic", model: null },
  { id: "claude-glm", label: "GLM", runtime: "claude", provider: "glm", model: "glm-5.3[1m]", credentialId: "glm-5.2" },
  { id: "relay", label: "中转", runtime: "codex", provider: "relay", model: null, custom: true },
];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-endpoint-"));
  mkdirSync(join(root, "claude"));
  mkdirSync(join(root, "codex"));
  writeFileSync(join(root, "claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://cc.example.com" } }));
  writeFileSync(join(root, "codex", "config.toml"), 'model_provider = "x"\n[model_providers.x]\nbase_url = "https://cx.example.com/v1"\n');
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const runtime = new RuntimeRouter(store, PROFILES, { codex: new CodexRuntime({ store, servers, profiles: PROFILES }) });
  service = new HostService(store, runtime, PROFILES, { localClaudeHome: join(root, "claude"), codexHome: join(root, "codex") });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("ChannelsFeature.endpoint", () => {
  it("reads Claude 订阅's from the person's Claude Code dir and GPT's from their Codex home", () => {
    expect(service.channels.endpoint("claude-subscription")).toMatchObject({ url: "https://cc.example.com" });
    expect(service.channels.endpoint("codex-default")).toMatchObject({ url: "https://cx.example.com/v1" });
  });

  it("has nothing for profiles Studio routes itself", () => {
    expect(service.channels.endpoint("claude-glm")).toBeNull();
    expect(service.channels.endpoint("relay")).toBeNull();
    expect(() => service.channels.endpoint("nope")).toThrow();
  });
});
