import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// GET /api/sessions/:id/items?tail=n (2026-10-24): Focus reads a session's latest, not its whole log.

const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: null, model: null }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let session: Session;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-tail-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  const ws = store.addWorkspace({ path: root, name: "alpha" });
  const task = store.createTask({ title: "Long", workspaceId: ws.id });
  session = store.createSession({ taskId: task.id, topicId: null, runtime: "codex", profileId: "p", workspaceId: ws.id, title: "", status: "idle", writer: "workbench", runtimeRef: null, parentId: null, kind: "main" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("a session's latest items", () => {
  it("gives the last n oldest first, with the questions and approvals still waiting from before them", () => {
    const at = "2026-10-24T10:00:00.000Z";
    const add = (id: string, extra: Record<string, unknown>) => store.appendItem({ id, sessionId: session.id, createdAt: at, ...extra } as never);
    add("q-old", { type: "question", source: "codex-input", state: "answered", questions: [] });
    add("q-wait", { type: "question", source: "codex-input", state: "pending", questions: [] });
    add("ap-wait", { type: "approval", state: "pending", kind: "command", summary: "npm test" });
    for (let n = 0; n < 10; n++) add(`a${n}`, { type: "agent", markdown: `reply ${n}`, streaming: false });

    expect(service.sessions.items(session.id).map((i) => i.id)).toHaveLength(13);
    expect(service.sessions.items(session.id, 0, 3).map((i) => i.id)).toEqual(["q-wait", "ap-wait", "a7", "a8", "a9"]);
    // Within the last n already: once.
    const replies = Array.from({ length: 10 }, (_, n) => `a${n}`);
    expect(service.sessions.items(session.id, 0, 11).map((i) => i.id)).toEqual(["q-wait", "ap-wait", ...replies]);
    expect(store.listLastItems(session.id, 2).map((i) => i.id)).toEqual(["a8", "a9"]);
  });
});
