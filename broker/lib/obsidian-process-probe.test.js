const assert = require("node:assert/strict");
const test = require("node:test");
const { createObsidianProcessProbe } = require("./obsidian-process-probe");

test("process probe parses tasklist output and caches the result", async () => {
  let calls = 0;
  let now = 1_000;
  const probe = createObsidianProcessProbe({
    platform: "win32",
    now: () => now,
    execFile: (_file, _args, _options, callback) => {
      calls += 1;
      callback(null, '"Obsidian.exe","101","Console","1","10,000 K"\n');
    },
  });

  const first = await probe.probe();
  now += 1_000;
  const second = await probe.probe();

  assert.equal(first.state, "running");
  assert.equal(first.count, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("concurrent probes share one child process", async () => {
  let calls = 0;
  let finish;
  const probe = createObsidianProcessProbe({
    platform: "win32",
    execFile: (_file, _args, _options, callback) => {
      calls += 1;
      finish = callback;
    },
  });

  const first = probe.probe();
  const second = probe.probe();
  finish(null, "INFO: No tasks are running which match the specified criteria.\n");
  const [left, right] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(left.count, 0);
  assert.equal(right.count, 0);
});

test("a timed-out probe reports unknown instead of hanging", async () => {
  const probe = createObsidianProcessProbe({
    platform: "win32",
    timeoutMs: 650,
    execFile: (_file, _args, options, callback) => {
      assert.equal(options.timeout, 650);
      const error = Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" });
      callback(error, "");
    },
  });

  const result = await probe.probe();

  assert.equal(result.state, "unknown");
  assert.equal(result.count, null);
  assert.equal(result.timedOut, true);
});
