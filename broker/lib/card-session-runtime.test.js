const assert = require("node:assert/strict");
const test = require("node:test");
const { projectSessionRuntime, projectConversationRuntime } = require("./card-components/session-runtime");

const ref = { frameworkId: "codex", sessionId: "session-a" };
const source = (overrides = {}) => ({ sessionId: "session-a", tool: "codex-cli", state: "idle", cwd: "C:/work", ...overrides });
const project = (session, sessionRef = ref) => projectConversationRuntime(session, sessionRef, "conversation-a", "source-a");
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("session projection preserves exact component/reference identity and excludes provider metadata", () => {
  const session = deepFreeze(source({ workspaceId: "workspace-a", workspacePath: "C:/root", codexModel: "private-model", provider: { token: "private" } }));
  const sessionRef = deepFreeze({ ...ref });
  assert.deepEqual(projectSessionRuntime(session, sessionRef, "source-a"), {
    componentId: "source-a", sessionRef: ref, presence: "live", execution: "idle",
    workspaceId: "workspace-a", workspacePath: "C:/root",
  });
  project(session, sessionRef);
  assert.notEqual(projectSessionRuntime(session, sessionRef, "source-a").sessionRef, sessionRef);
});

test("missing runtime and mismatched SessionKeys stay detached with commands disabled", () => {
  for (const session of [null, source({ sessionId: "session-b" }), source({ tool: "claude" }), source({ sessionId: "session-a " })]) {
    assert.deepEqual(projectSessionRuntime(session, ref, "source-a"), {
      componentId: "source-a", sessionRef: ref, presence: "detached", execution: "unknown",
      workspaceId: null, workspacePath: "",
    });
    assert.deepEqual(project(session), {
      componentId: "conversation-a", sessionComponentId: "source-a", surface: "unbound",
      bindingKind: "unbound", availability: "unknown", capabilities: { activate: false, resume: false },
    });
  }
});

test("canonical aliases identify the same source without rewriting its stored reference", () => {
  for (const [frameworkId, tools] of [
    ["codex", ["codex", "openai codex", "codex-app"]],
    ["claude", ["claude-code", "claude_code", "claude code"]],
    ["grok", ["grok-build", "grok-code"]],
  ]) {
    for (const tool of tools) {
      assert.equal(projectSessionRuntime(source({ tool }), { ...ref, frameworkId }, "source").presence, "live");
    }
  }
});

test("idle or running Session without GUI remains live with unknown conversation availability", () => {
  for (const state of ["idle", "running", "failed", "waiting_user"]) {
    const session = source({ state });
    assert.equal(projectSessionRuntime(session, ref, "source-a").execution, state);
    assert.equal(projectSessionRuntime(session, ref, "source-a").presence, "live");
    assert.deepEqual(project(session), {
      componentId: "conversation-a", sessionComponentId: "source-a", surface: "unbound",
      bindingKind: "unbound", availability: "unknown", capabilities: { activate: true, resume: true },
    });
  }
});

test("managed launch availability follows actual launch and window evidence, not execution", () => {
  const session = source({ launchId: "launch-a", windowHint: { boundBy: "managed-launch", titleToken: "[AMO:a]" } });
  for (const state of ["created", "spawning", "waiting_hook", "claimed", "connected"]) {
    assert.equal(project({ ...session, launchState: state }).availability, "unknown");
  }
  const connected = { ...session, launchState: "connected", windowHint: { ...session.windowHint, hwnd: 123 } };
  assert.equal(project(connected).availability, "online");
  for (const launchState of ["offline", "failed"]) {
    const conversation = project({ ...connected, state: "running", launchState });
    assert.equal(conversation.availability, "offline");
    assert.deepEqual(conversation.capabilities, { activate: false, resume: true });
  }
});

test("explicit GUI binding wins stale managed CLI state and never permits CLI resume", () => {
  for (const launchState of ["offline", "connected"]) {
    const session = source({ launchId: "stale", launchState, availability: "online", windowHint: { hwnd: 123, boundBy: "managed-launch" }, targetBinding: { type: "codex-app-thread", threadId: "gui-thread" } });
    assert.equal(project(session).surface, "app");
    assert.equal(project(session).bindingKind, "codex-app-thread");
    assert.equal(project(session).availability, "unknown");
    assert.deepEqual(project(session).capabilities, { activate: true, resume: false });
    assert.equal(projectSessionRuntime(session, ref, "source-a").presence, "live");
    const archived = { ...session, archivedAt: "2026-09-11T01:00:00Z" };
    assert.equal(projectSessionRuntime(archived, ref, "source-a").presence, "archived");
    assert.equal(project(archived).surface, "app");
    assert.equal(project(archived).availability, "unknown");
    assert.deepEqual(project(archived).capabilities, { activate: false, resume: false });
  }
});

test("App tool cannot become resumable CLI through absence or inconsistency of target binding", () => {
  for (const targetBinding of [null, { type: "codex-cli-session", sessionId: ref.sessionId }, { type: "window", hwnd: 42 }]) {
    const result = project(source({ tool: "codex-app", targetBinding }));
    assert.equal(result.surface, "app");
    assert.equal(result.capabilities.resume, false);
  }
});

test("explicit window route is independent from stale managed launch availability", () => {
  const result = project(source({ launchId: "old", launchState: "offline", windowHint: { hwnd: 1, boundBy: "managed-launch" }, targetBinding: { type: "window", hwnd: 456, boundBy: "overlay-target-menu" } }));
  assert.equal(result.bindingKind, "window");
  assert.equal(result.availability, "unknown");
  assert.deepEqual(result.capabilities, { activate: true, resume: true });
});

test("attached child owner hints do not activate another session; resume still uses its own source", () => {
  const result = project(source({ launchRelation: "attached-child", routeOwnerSessionId: "parent", windowHint: { boundBy: "managed-launch", hwnd: 456, titleToken: "[parent]" } }));
  assert.equal(result.surface, "unbound");
  assert.deepEqual(result.capabilities, { activate: false, resume: true });
  const mismatchedTarget = project(source({ targetBinding: { type: "codex-cli-session", sessionId: "another" } }));
  assert.deepEqual(mismatchedTarget.capabilities, { activate: false, resume: false });
});

test("unknown frameworks and bindings stay read-only even with valid native-looking metadata", () => {
  const unknown = project(source({ tool: "future-provider", launchId: "launch", launchState: "connected", targetBinding: { type: "window", hwnd: 10 } }), { ...ref, frameworkId: "unknown" });
  assert.deepEqual(unknown.capabilities, { activate: false, resume: false });
  const binding = project(source({ targetBinding: { type: "future-route", hwnd: 10 } }));
  assert.deepEqual(binding.capabilities, { activate: false, resume: false });
});

test("distinct components can reference different sessions without mixing runtime projections", () => {
  const cli = projectConversationRuntime(source({ launchId: "a", launchState: "offline" }), ref, "conversation-cli", "source-cli");
  const appRef = { frameworkId: "codex", sessionId: "session-b" };
  const app = projectConversationRuntime(source({ sessionId: "session-b", targetBinding: { type: "codex-app-thread", threadId: "b" } }), appRef, "conversation-app", "source-app");
  assert.equal(cli.sessionComponentId, "source-cli");
  assert.equal(cli.availability, "offline");
  assert.equal(app.sessionComponentId, "source-app");
  assert.equal(app.surface, "app");
  assert.equal(app.capabilities.resume, false);
});

test("CLI resume requires a workspace and archived sources never expose commands", () => {
  for (const tool of ["codex-cli", "claude-code", "grok-build"]) {
    const sessionRef = { ...ref, frameworkId: { "codex-cli": "codex", "claude-code": "claude", "grok-build": "grok" }[tool] };
    assert.equal(project(source({ tool, cwd: "" }), sessionRef).capabilities.resume, false);
    assert.equal(project(source({ tool }), sessionRef).capabilities.resume, true);
    assert.deepEqual(project(source({ tool, archivedAt: "2026-09-11T01:00:00Z" }), sessionRef).capabilities, { activate: false, resume: false });
  }
});
