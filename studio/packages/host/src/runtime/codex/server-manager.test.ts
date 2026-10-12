import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { mockCodexProvider, removeTempDir, startMockModel, type MockModelServer } from "@amo-studio/testkit";
import { StaticCredentialReader } from "../credentials.js";
import { CodexServerManager, type CodexServerHandle } from "./server-manager.js";

// Integration: real `codex app-server` (npm package) against the local mock model. No model budget is spent.

const PROFILE: ModelProfile = { id: "codex-mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" };
const root = mkdtempSync(join(tmpdir(), "amo-studio-test-servers-"));
mkdirSync(join(root, "codex-home"), { recursive: true });
let mock: MockModelServer;
const managers: CodexServerManager[] = [];

function manager(dataDir = join(root, "data")) {
  const m = new CodexServerManager({
    dataDir,
    profiles: [PROFILE],
    credentials: new StaticCredentialReader({ mock: "mock-key" }),
    cwd: root,
    env: { CODEX_HOME: join(root, "codex-home") },
    providers: { "amo-mock": mockCodexProvider(mock.baseUrl) },
    portRange: [47940, 47949],
    backoffMs: { first: 200, max: 1000 },
  });
  managers.push(m);
  return m;
}

async function runTurn(handle: CodexServerHandle, threadId: string, text: string) {
  const done = new Promise<{ status: string }>((resolve) => {
    handle.client.on("notification", (n) => {
      if (n.method === "turn/completed" && n.params.threadId === threadId) resolve(n.params.turn);
    });
  });
  await handle.client.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] } as never);
  return done;
}

const nextEvent = <T>(m: CodexServerManager, name: "ready" | "down") => new Promise<T>((resolve) => m.once(name, resolve as never));

beforeAll(async () => {
  mock = await startMockModel();
});

afterAll(async () => {
  for (const m of managers) await m.stopAll();
  await mock.close();
  removeTempDir(root);
});

describe("CodexServerManager", () => {
  let first: CodexServerManager;
  let handle: CodexServerHandle;
  let threadId: string;

  it("starts a server for a profile and reuses it", async () => {
    first = manager();
    handle = await first.ensure(PROFILE.id);
    expect(handle.port).toBeGreaterThanOrEqual(47940);
    expect(await first.ensure(PROFILE.id)).toBe(handle);

    const started = await handle.client.request("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "read-only" } as never);
    expect(started.modelProvider).toBe("amo-mock");
    threadId = started.thread.id;
    expect((await runTurn(handle, threadId, "hello")).status).toBe("completed");
  }, 60_000);

  it("restarts a crashed server on the same port and token, and the thread resumes", async () => {
    const down = nextEvent(first, "down");
    const ready = nextEvent<CodexServerHandle>(first, "ready");
    first.killForTest(PROFILE.id);
    await down;
    const again = await ready;
    expect(again.port).toBe(handle.port);
    expect(again.token).toBe(handle.token);
    const resumed = await again.client.request("thread/resume", { threadId } as never);
    expect(resumed.modelProvider).toBe("amo-mock");
    expect((await runTurn(again, threadId, "after restart")).status).toBe("completed");
    handle = again;
  }, 60_000);

  it("lets a new Host adopt the running server instead of spawning another", async () => {
    const second = manager();
    const adopted = await second.ensure(PROFILE.id);
    expect(adopted.port).toBe(handle.port);
    const read = await adopted.client.request("thread/read", { threadId } as never);
    expect(read.thread.id).toBe(threadId);
    // Detaching closes the connection without treating it as a crash or killing the server.
    second.detachAll();
    expect(first.handle(PROFILE.id)?.client.isOpen).toBe(true);
  }, 60_000);

  it("stops the server and frees the port", async () => {
    await first.stopAll();
    expect(first.handle(PROFILE.id)).toBeNull();
    const probe = manager();
    // The adopted connection is gone, so a fresh ensure must spawn again on the saved port.
    const fresh = await probe.ensure(PROFILE.id);
    expect(fresh.port).toBe(handle.port);
    await probe.stopAll();
  }, 60_000);
});
