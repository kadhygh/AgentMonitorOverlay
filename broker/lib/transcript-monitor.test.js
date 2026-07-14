const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSessionStore } = require("./session-store");
const { createTranscriptMonitor } = require("./transcript-monitor");

test("transcript monitor observes only appended turn_aborted rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-transcript-monitor-"));
  const transcriptPath = path.join(root, "session.jsonl");
  const priorAbort = transcriptRow("turn-old", "2026-07-13T00:00:00.000Z");
  fs.writeFileSync(transcriptPath, `${priorAbort}\n`, "utf8");

  const observed = [];
  const monitor = createTranscriptMonitor({
    pollIntervalMs: 60_000,
    onTurnAborted: (event) => observed.push(event),
  });
  t.after(() => {
    monitor.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(monitor.track({
    tool: "codex",
    sessionId: "session-1",
    turnId: "turn-current",
    transcriptPath,
  }), true);
  await monitor.pollNow();
  assert.equal(observed.length, 0, "tracking starts at EOF and must not replay history");

  fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })}\n`, "utf8");
  const currentAbort = transcriptRow("turn-current", "2026-07-13T00:01:00.000Z");
  const splitAt = Math.floor(currentAbort.length / 2);
  fs.appendFileSync(transcriptPath, currentAbort.slice(0, splitAt), "utf8");
  await monitor.pollNow();
  assert.equal(observed.length, 0, "partial JSONL rows must wait for a newline");

  fs.appendFileSync(transcriptPath, `${currentAbort.slice(splitAt)}\n`, "utf8");
  await monitor.pollNow();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].sessionId, "session-1");
  assert.equal(observed[0].turnId, "turn-current");

  fs.appendFileSync(transcriptPath, `${currentAbort}\n`, "utf8");
  await monitor.pollNow();
  assert.equal(observed.length, 1, "duplicate transcript rows must not emit twice");
});

test("session cancellation requires the active Codex turn and a cancellable state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-session-store-"));
  const store = createSessionStore({ dataFile: path.join(root, "sessions.json") });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  store.upsertSessionFromEvent({
    tool: "codex",
    sessionId: "session-1",
    turnId: "turn-current",
    transcriptPath: path.join(root, "session.jsonl"),
    hookEventName: "UserPromptSubmit",
    state: "running",
  });

  assert.equal(store.markSessionCancelledFromTranscript({
    sessionId: "session-1",
    turnId: "turn-stale",
  }), null);
  assert.equal(store.listSessions()[0].state, "running");

  const cancelled = store.markSessionCancelledFromTranscript({
    sessionId: "session-1",
    turnId: "turn-current",
    observedAt: "2026-07-13T00:02:00.000Z",
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.lastEvent, "TurnAborted");

  assert.equal(store.markSessionCancelledFromTranscript({
    sessionId: "session-1",
    turnId: "turn-current",
  }), null, "a repeated abort must not rewrite an already cancelled session");
});

test("failed turn boundaries require attention", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-failed-session-"));
  const store = createSessionStore({ dataFile: path.join(root, "sessions.json") });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const failed = store.upsertSessionFromEvent({
    tool: "claude",
    sessionId: "claude-failed",
    hookEventName: "StopFailure",
    state: "failed",
    message: "rate_limit",
  });

  assert.equal(failed.state, "failed");
  assert.equal(failed.needsAttention, true);
});

function transcriptRow(turnId, timestamp) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "turn_aborted",
      turn_id: turnId,
      reason: "interrupted",
    },
  });
}
