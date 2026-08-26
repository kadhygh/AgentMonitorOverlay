const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { grokExecutableCandidates, resolveGrokExecutable } = require("./grok-executable");

test("Windows Grok Build resolution includes the official user install path", () => {
  const environment = { USERPROFILE: "C:\\Users\\Test User" };
  const candidates = grokExecutableCandidates(environment);
  assert.deepEqual(candidates, [path.join(environment.USERPROFILE, ".grok", "bin", "grok.exe")]);

  const resolved = resolveGrokExecutable({
    platform: "win32",
    environment,
    findExecutable: (command, values) => {
      assert.equal(command, "grok.exe");
      assert.deepEqual(values, candidates);
      return candidates[0];
    },
  });
  assert.equal(resolved, candidates[0]);
});

test("Grok Build resolution falls back to the PATH command", () => {
  assert.equal(resolveGrokExecutable({ platform: "linux" }), "grok");
  assert.equal(resolveGrokExecutable({
    platform: "win32",
    environment: {},
    findExecutable: () => null,
  }), "grok");
});
