const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLaunchStore } = require("./launch-store");

function createTestStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amo-launch-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, "launches.json");
  return { dataFile, store: createLaunchStore({ dataFile }) };
}

function matchingPayload(launch, sessionId) {
  return {
    launchId: launch.launchId,
    sessionId,
    workspaceId: launch.workspaceId,
    workspacePath: launch.workspacePath,
    tool: launch.adapterId === "claude-cli" ? "claude" : "codex",
  };
}

test("waiting launch remains claimable without a time limit", (t) => {
  const { store } = createTestStore(t);
  const sessionId = "session-resume";
  const launch = store.create({
    workspaceId: "workspace-1",
    workspacePath: "C:\\Projects\\demo",
    adapterId: "codex-cli",
    mode: "resume",
    requestedSessionId: sessionId,
  });
  store.update(launch.launchId, {
    state: "waiting_hook",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:02:00.000Z",
  });

  assert.equal(store.findActiveResume(sessionId)?.launchId, launch.launchId);
  const claim = store.claim(matchingPayload(launch, sessionId), { sessions: new Map() });
  assert.equal(claim?.launch.state, "connected");
  assert.equal(claim?.launch.currentSessionId, sessionId);
});

test("an explicit resume retry supersedes every pending launch for that session", (t) => {
  const { store } = createTestStore(t);
  const sessionId = "session-resume";
  const first = store.create({
    workspaceId: "workspace-1",
    workspacePath: "C:\\Projects\\demo",
    adapterId: "codex-cli",
    mode: "resume",
    requestedSessionId: sessionId,
  });
  const second = store.create({
    workspaceId: "workspace-1",
    workspacePath: "C:\\Projects\\demo",
    adapterId: "codex-cli",
    mode: "resume",
    requestedSessionId: sessionId,
  });
  store.update(first.launchId, { state: "waiting_hook" });
  store.update(second.launchId, { state: "spawning" });

  const superseded = store.supersedeActiveResume(sessionId);

  assert.deepEqual(superseded.map((item) => item.launchId), [first.launchId, second.launchId]);
  assert.equal(store.findActiveResume(sessionId), null);
  for (const launch of superseded) {
    assert.equal(launch.state, "offline");
    assert.equal(launch.offlineReason, "resume-retried");
  }
});

test("legacy expired launch migrates back to waiting_hook", (t) => {
  const { dataFile } = createTestStore(t);
  fs.writeFileSync(dataFile, JSON.stringify({
    launches: [{
      launchId: "launch_legacy",
      workspaceId: "workspace-1",
      workspacePath: "C:\\Projects\\demo",
      adapterId: "codex-cli",
      mode: "resume",
      requestedSessionId: "session-resume",
      state: "expired",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:02:00.000Z",
      expiresAt: "2020-01-01T00:02:00.000Z",
    }],
  }));

  const store = createLaunchStore({ dataFile });
  const launch = store.list()[0];
  assert.equal(launch.state, "waiting_hook");
  assert.equal("expiresAt" in launch, false);
  assert.equal(store.findActiveResume("session-resume")?.launchId, "launch_legacy");
});

test("resume launch rejects a different first session", (t) => {
  const { store } = createTestStore(t);
  const launch = store.create({
    workspaceId: "workspace-1",
    workspacePath: "C:\\Projects\\demo",
    adapterId: "claude-cli",
    mode: "resume",
    requestedSessionId: "expected-session",
  });
  store.update(launch.launchId, { state: "waiting_hook" });

  assert.equal(store.claim(matchingPayload(launch, "other-session"), { sessions: new Map() }), null);
  assert.equal(store.list()[0].state, "waiting_hook");
});

test("first managed claim replaces the card's previous explicit target", (t) => {
  const { store } = createTestStore(t);
  const sessionId = "session-resume";
  const launch = store.create({
    workspaceId: "workspace-1",
    workspacePath: "C:\\Projects\\demo",
    adapterId: "codex-cli",
    mode: "resume",
    requestedSessionId: sessionId,
  });
  store.update(launch.launchId, { state: "waiting_hook" });
  const sessions = new Map([[sessionId, {
    sessionId,
    targetBinding: {
      type: "codex-app-thread",
      threadId: sessionId,
      boundBy: "overlay-target-menu",
    },
  }]]);

  store.claim(matchingPayload(launch, sessionId), { sessions });
  assert.equal(sessions.get(sessionId).targetBinding, null);

  sessions.set(sessionId, {
    ...sessions.get(sessionId),
    targetBinding: {
      type: "codex-app-thread",
      threadId: sessionId,
      boundBy: "overlay-target-menu",
    },
  });
  store.claim(matchingPayload(launch, sessionId), { sessions });
  assert.equal(sessions.get(sessionId).targetBinding.type, "codex-app-thread");
});

test("connected launch reconciliation removes redundant managed window targets", (t) => {
  const { store } = createTestStore(t);
  const sessionId = "session-managed";
  const launch = store.create({
    workspaceId: "workspace-1",
    workspacePath: "C:\\Projects\\demo",
    adapterId: "codex-cli",
  });
  store.update(launch.launchId, {
    state: "connected",
    claimedSessionId: sessionId,
    currentSessionId: sessionId,
    bindingRevision: 1,
  });
  const sessions = new Map([[sessionId, {
    sessionId,
    targetBinding: {
      type: "window",
      hwnd: null,
      processId: null,
      boundBy: "managed-launch",
    },
  }]]);

  store.reconcileSessions(sessions);
  assert.equal(sessions.get(sessionId).targetBinding, null);
  assert.equal(sessions.get(sessionId).launchState, "connected");
  assert.equal(sessions.get(sessionId).windowHint.boundBy, "managed-launch");
});

test("active launches survive retention pruning while old terminal launches are removed", (t) => {
  const { dataFile } = createTestStore(t);
  fs.writeFileSync(dataFile, JSON.stringify({
    launches: [
      {
        launchId: "launch_active",
        workspaceId: "workspace-1",
        workspacePath: "C:\\Projects\\demo",
        adapterId: "codex-cli",
        mode: "new",
        state: "waiting_hook",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      },
      {
        launchId: "launch_failed",
        workspaceId: "workspace-1",
        workspacePath: "C:\\Projects\\demo",
        adapterId: "codex-cli",
        mode: "new",
        state: "failed",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      },
    ],
  }));
  const store = createLaunchStore({ dataFile });

  const launches = store.list();
  assert.deepEqual(launches.map((item) => item.launchId), ["launch_active"]);
});
