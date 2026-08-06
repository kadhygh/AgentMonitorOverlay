const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSnapshotWriter } = require("./snapshot-writer");

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-snapshot-writer-"));
  const dataFile = path.join(root, "sessions.json");
  let revision = 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writer = createSnapshotWriter({
    dataFile,
    debounceMs: options.debounceMs ?? 15,
    maxWaitMs: options.maxWaitMs ?? 80,
    createSnapshot: () => ({ schemaVersion: 1, revision, sessions: [{ sessionId: `s-${revision}` }] }),
    fileSystem: options.fileSystem,
  });
  return {
    dataFile,
    writer,
    setRevision(value) {
      revision = value;
    },
  };
}

test("burst scheduling coalesces writes and persists the latest state", async (t) => {
  const fixture = createFixture(t);
  for (let revision = 1; revision <= 20; revision += 1) {
    fixture.setRevision(revision);
    fixture.writer.schedule("test-burst");
  }

  await fixture.writer.flush("test");
  const snapshot = JSON.parse(fs.readFileSync(fixture.dataFile, "utf8"));
  assert.equal(snapshot.revision, 20);
  assert.equal(snapshot.sessions[0].sessionId, "s-20");
  assert.equal(fixture.writer.status().completedWrites, 1);
  assert.equal(fixture.writer.status().dirty, false);
});

test("a mutation arriving during a write receives a follow-up flush", async (t) => {
  let releaseFirstWrite;
  let writes = 0;
  const fileSystem = {
    ...fs.promises,
    async writeFile(...args) {
      writes += 1;
      if (writes === 1) {
        await new Promise((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return fs.promises.writeFile(...args);
    },
  };
  const fixture = createFixture(t, { fileSystem });
  fixture.setRevision(1);
  fixture.writer.schedule("first");
  const flush = fixture.writer.flush("first-flush");
  while (!releaseFirstWrite) await new Promise((resolve) => setTimeout(resolve, 1));
  fixture.setRevision(2);
  fixture.writer.schedule("second");
  releaseFirstWrite();
  await flush;
  await fixture.writer.flush("final");

  const snapshot = JSON.parse(fs.readFileSync(fixture.dataFile, "utf8"));
  assert.equal(snapshot.revision, 2);
  assert.equal(writes, 2);
  assert.equal(fixture.writer.status().dirty, false);
});

test("write failure preserves dirty state for an explicit retry", async (t) => {
  let fail = true;
  const fileSystem = {
    ...fs.promises,
    async writeFile(...args) {
      if (fail) {
        const error = new Error("simulated write failure");
        error.code = "EIO";
        throw error;
      }
      return fs.promises.writeFile(...args);
    },
  };
  const fixture = createFixture(t, { fileSystem });
  fixture.setRevision(7);
  fixture.writer.schedule("failure");
  await assert.rejects(() => fixture.writer.flush("failure"), /simulated write failure/u);
  assert.equal(fixture.writer.status().dirty, true);

  fail = false;
  await fixture.writer.flush("retry");
  assert.equal(JSON.parse(fs.readFileSync(fixture.dataFile, "utf8")).revision, 7);
  assert.equal(fixture.writer.status().dirty, false);
});
