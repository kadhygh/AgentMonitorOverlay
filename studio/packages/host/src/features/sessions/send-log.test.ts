import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 2026-11-05: a message the person sent right after 停止 never came back and left no trace anywhere. What fails or
// hangs is now written to host.log, and the runtimes' own lines get there too (nobody listened to them before).

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let runtime: CodexRuntime;
let service: HostService;
let session: Session;
let lines: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-send-log-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  service = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
  lines = [];
  service.on("log", (line) => lines.push(line));
  mkdirSync(join(root, "alpha"));
  const alpha: Workspace = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const task: Task = store.createTask({ title: "日志", workspaceId: alpha.id });
  session = await service.tasks.addSession(task.id, { profileId: "p-ds" });
});

afterEach(async () => {
  vi.useRealTimers();
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("a message from the person in host.log", () => {
  it("one that fails is written with the session and the reason, and still fails", async () => {
    vi.spyOn(runtime, "sendMessage").mockRejectedValueOnce(new Error("DSH 起不来"));
    await expect(service.sessions.sendMessage(session.id, "你好")).rejects.toThrow(/DSH 起不来/);
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^${session.id} \\(codex\\): a message from the person failed after \\d+ ms: DSH 起不来$`))]);
  });

  it("one still on its way after 5 s is written then, and again when it goes in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let release!: () => void;
    vi.spyOn(runtime, "sendMessage").mockImplementationOnce(() => new Promise((r) => (release = () => r({ mode: "start" }))));
    const sent = service.sessions.sendMessage(session.id, "你好");
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines).toEqual([`${session.id} (codex): a message from the person is still on its way after 5000 ms`]);
    release();
    await expect(sent).resolves.toEqual({ mode: "start" });
    expect(lines[1]).toMatch(/: the message went in after \d+ ms \(start\)$/);
  });

  it("a quick one writes nothing; a runtime's own line is passed on", async () => {
    vi.spyOn(runtime, "sendMessage").mockResolvedValueOnce({ mode: "start" });
    await service.sessions.sendMessage(session.id, "你好");
    expect(lines).toEqual([]);
    runtime.emit("log", "the codex turn did not stop within 15000 ms");
    expect(lines).toEqual(["the codex turn did not stop within 15000 ms"]);
  });
});
