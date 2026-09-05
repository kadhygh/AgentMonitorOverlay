const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createSessionStore } = require("../../broker/lib/session-store");
const { querySessions } = require("../../broker/lib/session-query");
const { createLaunchStore } = require("../../broker/lib/launch-store");

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amo-session-scale-"));
  const results = [];
  for (const activeCount of [100, 300, 1000]) {
    const store = createSessionStore({ dataFile: path.join(fixtureRoot, `sessions-${activeCount}.json`), refreshTitle: (session) => session });
    for (let index = 0; index < activeCount + 5000; index += 1) {
      const sessionId = `fixture-${index}`;
      store.sessions.set(sessionId, {
        sessionId, tool: "codex", title: `Task ${index}`, state: "running",
        createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z",
        displayOrder: index, archivedAt: index >= activeCount ? "2026-09-05T00:00:00Z" : null,
      });
    }
    const samples = [];
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const start = performance.now();
      const page = store.querySessions ? store.querySessions(new URLSearchParams()) : querySessions(store.listSessions());
      JSON.stringify(page);
      if (iteration >= 10) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    results.push({ probe: "active-query-with-5000-archived", activeCount,
      medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.floor(samples.length * .95)] });
  }

  for (const launchCount of [100, 300]) {
    const dataFile = path.join(fixtureRoot, `launches-${launchCount}.json`);
    const launches = Array.from({ length: launchCount }, (_, index) => ({
      launchId: `launch_fixture-${index}`, adapterId: "codex-cli", workspaceId: "fixture-workspace", workspacePath: fixtureRoot,
      mode: "new", state: "connected", titleToken: `[AMO:codex:fixture-${index}]`,
      claimedSessionId: `fixture-${index}`, currentSessionId: `fixture-${index}`,
      firstClaimedSessionId: `fixture-${index}`, ownerSessionId: `fixture-${index}`, bindingRevision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cliHostPid: 123,
    }));
    fs.writeFileSync(dataFile, JSON.stringify({ launches }));
    const store = createLaunchStore({ dataFile });
    const originalWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = function (file, ...args) {
      if (String(file).startsWith(dataFile)) writes += 1;
      return originalWrite.call(this, file, ...args);
    };
    const start = performance.now();
    try {
      for (let index = 0; index < 100; index += 1) {
        store.claim({ launchId: `launch_fixture-${index % launchCount}`, sessionId: `fixture-${index % launchCount}`,
          workspaceId: "fixture-workspace", cwd: fixtureRoot, tool: "codex", event: "PostToolUse", hookParentPid: 123 });
      }
    } finally {
      fs.writeFileSync = originalWrite;
    }
    results.push({ probe: "100-steady-owner-hooks", launchCount, elapsedMs: performance.now() - start, synchronousWrites: writes });
  }
  console.log(JSON.stringify({ node: process.version, fixtureRoot, results }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
