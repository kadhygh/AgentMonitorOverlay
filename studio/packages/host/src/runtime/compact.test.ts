import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTO_COMPACT_TOKENS, type ModelProfile, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { ClaudeRuntime } from "./claude/claude-runtime.js";
import { StaticCredentialReader } from "./credentials.js";
import { CodexRuntime } from "./codex/codex-runtime.js";
import { FakeServers } from "./codex/fake-servers.test-support.js";
import { RuntimeRouter } from "./runtime.js";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { readAutoCompact } from "./compact.js";

// 自动压缩点 (2026-10-17): one setting, given to Claude processes (CLAUDE_CODE_AUTO_COMPACT_WINDOW) and Codex threads
// (model_auto_compact_token_limit).

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-claude", label: "Claude", runtime: "claude", provider: "mock", model: "mock-claude", credentialId: "mock" },
];

let root: string;
let store: Store;
let servers: FakeServers;
let claude: ClaudeRuntime;
let service: HostService;
let alpha: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-compact-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const codex = new CodexRuntime({ store, servers, profiles: PROFILES });
  claude = new ClaudeRuntime({ store, profiles: PROFILES, providers: { mock: { baseUrl: "http://127.0.0.1:9" } }, credentials: new StaticCredentialReader({ mock: "k" }), claudeHome: join(root, "claude-home") });
  service = new HostService(store, new RuntimeRouter(store, PROFILES, { codex, claude }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const threadConfig = (method: string) => (servers.fakes.get("p-ds")!.calls.filter((c) => c.method === method).at(-1)!.params as { config?: Record<string, unknown> }).config;

describe("自动压缩点", () => {
  it("is 272k until changed, takes null (the CLIs decide) and refuses what is out of range", () => {
    expect(service.config.settings().autoCompactTokens).toBe(DEFAULT_AUTO_COMPACT_TOKENS);
    expect(service.config.updateSettings({ autoCompactTokens: 200_000 }).autoCompactTokens).toBe(200_000);
    expect(() => service.config.updateSettings({ autoCompactTokens: 1000 })).toThrow(/autoCompactTokens/);
    expect(() => service.config.updateSettings({ autoCompactTokens: "272k" })).toThrow(/autoCompactTokens/);
    expect(service.config.updateSettings({ autoCompactTokens: null }).autoCompactTokens).toBeNull();
    expect(readAutoCompact(store)).toBeNull();
  });

  it("goes into a Codex thread's config when it starts", async () => {
    const task = store.createTask({ title: "t", workspaceId: alpha.id });
    await service.tasks.startSession({ taskId: task.id, topicId: null }, alpha, { profileId: "p-ds" });
    expect(threadConfig("thread/start")).toMatchObject({ model_auto_compact_token_limit: DEFAULT_AUTO_COMPACT_TOKENS });
    service.config.updateSettings({ autoCompactTokens: null });
    await service.tasks.startSession({ taskId: task.id, topicId: null }, alpha, { profileId: "p-ds" });
    expect(threadConfig("thread/start")).not.toHaveProperty("model_auto_compact_token_limit");
  });

  it("goes into a Claude process's environment", async () => {
    const task = store.createTask({ title: "t", workspaceId: alpha.id });
    const s = await claude.startSession({ taskId: task.id, topicId: null, profileId: "p-claude", workspace: alpha });
    service.config.updateSettings({ autoCompactTokens: 300_000 });
    expect((await claude.handoff(s.id)).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("300000");
  });
});
