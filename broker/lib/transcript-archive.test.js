const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const test = require("node:test");
const { createSessionStore } = require("./session-store");
const { createTranscriptMonitor } = require("./transcript-monitor");
const { createPermissionGate } = require("./permission-gate");
const { handleSessionRoutes } = require("../routes/sessions");
const { handleObsidianRoutes } = require("../routes/obsidian");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-transcript-archive-"));
  const transcriptPath = path.join(root, "session.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const store = createSessionStore({ dataFile: path.join(root, "sessions.json"), refreshTitle: (session) => session });
  const observed = [];
  const monitor = createTranscriptMonitor({ pollIntervalMs: 60_000, onTurnAborted: (event) => observed.push(event) });
  const gate = createPermissionGate({ sessions: store.sessions, upsertSessionFromEvent: store.upsertSessionFromEvent });
  t.after(() => {
    gate.dispose();
    monitor.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const session = store.upsertSessionFromEvent({
    tool: "codex", sessionId: "one", transcriptPath, state: "running", turnId: "turn-one", hookEventName: "UserPromptSubmit",
  });
  const context = {
    ...store, transcriptMonitor: monitor, permissionGate: gate,
    launchStore: { claim: () => null }, persistSnapshot: async () => {},
    scheduleSnapshotPersist() {}, publishSessionChanged() {},
  };
  return { store, monitor, observed, session, transcriptPath, context };
}

async function post(route, url, context, payload = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = "POST";
  let response;
  assert.equal(await route(req, {
    writeHead(code) { assert.equal(code, 200); }, end(body) { response = JSON.parse(body); },
  }, new URL(url, "http://localhost"), context), true);
  return response;
}

function appendAbort(transcriptPath, turnId) {
  fs.appendFileSync(transcriptPath, `${JSON.stringify({
    timestamp: "2026-09-10T00:00:00.000Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId },
  })}\n`);
}

test("snapshot startup excludes archived transcripts without touching their files", (t) => {
  const { store, monitor, session } = fixture(t);
  store.sessions.set("archived", { ...session, sessionId: "archived", archivedAt: "2026-09-10" });
  const stat = t.mock.method(fs, "statSync");
  for (const saved of store.sessions.values()) monitor.track({}, saved);
  assert.equal(monitor.status().tracked, 1);
  assert.equal(stat.mock.callCount(), 1, "only the active transcript is inspected");
});

test("archive stops polling before persistence completes; new activity resumes at EOF", async (t) => {
  const { store, monitor, observed, session, transcriptPath, context } = fixture(t);
  monitor.track({}, session);
  let finishPersist;
  let startedPersist;
  const started = new Promise((resolve) => { startedPersist = resolve; });
  context.persistSnapshot = () => new Promise((resolve) => { finishPersist = resolve; startedPersist(); });
  const request = post(handleSessionRoutes, "/api/sessions/one/archive", context);
  await started;
  try {
    assert.equal(monitor.status().tracked, 0);
    assert.equal(monitor.track({ tool: "codex", sessionId: "one", transcriptPath }, store.sessions.get("one")), false);
    appendAbort(transcriptPath, "archived-turn");
    const stat = t.mock.method(fs.promises, "stat");
    await monitor.pollNow();
    assert.equal(stat.mock.callCount(), 0, "archived sessions perform no polling I/O");
    await post(handleObsidianRoutes, "/api/events", context, {
      tool: "codex", sessionId: "one", hookEventName: "UserPromptSubmit", state: "running", turnId: "new-turn",
    });
    assert.equal(store.sessions.get("one").archivedAt, null);
    assert.equal(monitor.status().tracked, 1, "existing transcript path is reused on revival");
    await monitor.pollNow();
    assert.equal(observed.length, 0, "rows written while archived are not replayed");
    appendAbort(transcriptPath, "new-turn");
    await monitor.pollNow();
    assert.equal(observed[0].turnId, "new-turn");
  } finally {
    finishPersist();
    await request;
  }
});

for (const action of ["one/dismiss", "dismiss-archived", "dismiss-all"]) {
  test(`${action} releases transcript tracking`, async (t) => {
    const { store, monitor, session, context } = fixture(t);
    monitor.track({}, session);
    if (action === "dismiss-archived") store.archiveSession("one");
    await post(handleSessionRoutes, `/api/sessions/${action}`, context);
    assert.equal(store.sessions.size, 0);
    assert.equal(monitor.status().tracked, 0);
  });
}

test("a cancelled in-flight poll cannot deliver events after the same session is tracked again", async (t) => {
  const { monitor, observed, session, transcriptPath } = fixture(t);
  monitor.track({}, session);
  appendAbort(transcriptPath, "old-turn");
  let releaseStat;
  const stat = fs.statSync(transcriptPath);
  t.mock.method(fs.promises, "stat", () => new Promise((resolve) => { releaseStat = () => resolve(stat); }), { times: 1 });
  const polling = monitor.pollNow();
  monitor.untrack("one");
  monitor.track({}, session);
  releaseStat();
  await polling;
  assert.equal(observed.length, 0);
  assert.equal(monitor.status().tracked, 1);
});

test("untracking during a chunk stops subsequent abort callbacks", async (t) => {
  const { session, transcriptPath } = fixture(t);
  let observed = 0;
  const monitor = createTranscriptMonitor({ pollIntervalMs: 60_000, onTurnAborted() {
    observed += 1;
    monitor.untrack("one");
  } });
  t.after(() => monitor.dispose());
  monitor.track({}, session);
  appendAbort(transcriptPath, "first");
  appendAbort(transcriptPath, "second");
  await monitor.pollNow();
  assert.equal(observed, 1);
});

test("Broker health reflects archive, heartbeat revival and cleanup after snapshot recovery", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-archive-http-"));
  const transcriptPath = path.join(root, "session.jsonl");
  fs.writeFileSync(transcriptPath, "");
  fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify({ sessions: [
    { sessionId: "active", tool: "codex", state: "running", transcriptPath },
    { sessionId: "archived", tool: "codex", state: "idle", transcriptPath, archivedAt: "2026-09-10",
      sessionNaming: { status: "pending", requestedName: "Recovered title" } },
  ] }));
  let child;
  let exited;
  t.after(async () => {
    if (child) {
      child.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(__dirname, "../server.js")], {
    windowsHide: true,
    env: { ...process.env, AGENT_MONITOR_HOST: "127.0.0.1", AGENT_MONITOR_PORT: String(port),
      AGENT_MONITOR_DATA_FILE: path.join(root, "sessions.json"),
      AGENT_MONITOR_WORKSPACE_DATA_FILE: path.join(root, "workspaces.json"),
      AGENT_MONITOR_LAUNCH_DATA_FILE: path.join(root, "launches.json"),
      AGENT_MONITOR_TASK_CANVAS_DATA_FILE: path.join(root, "canvas.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = once(child, "exit");
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Broker exited before startup: ${output}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("agent-monitor-broker listening")) resolve();
    });
    t.signal.addEventListener("abort", () => reject(new Error("Broker startup timed out")), { once: true });
  });
  async function request(url, payload) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      signal: t.signal,
      ...(payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  let health = await request("/api/health");
  assert.deepEqual(health.sessionCounts, { active: 1, archived: 1, total: 2 });
  assert.equal(health.transcriptMonitor.tracked, 1);
  await request("/api/sessions/active/archive", {});
  assert.equal((await request("/api/health")).transcriptMonitor.tracked, 0);
  await request("/api/sessions/archived/heartbeat", { state: "running", event: "UserPromptSubmit" });
  health = await request("/api/health");
  assert.equal(health.transcriptMonitor.tracked, 1, "publication restores tracking outside the hook routes too");
  assert.deepEqual(health.sessionCounts, { active: 1, archived: 1, total: 2 });
  await request("/api/sessions/dismiss-all", {});
  assert.equal((await request("/api/health")).transcriptMonitor.tracked, 0);
});
