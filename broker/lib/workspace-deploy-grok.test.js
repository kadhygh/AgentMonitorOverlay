const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { enrollWorkspace } = require("./workspace-deploy");
const { inspectWorkspace } = require("./workspace-inspect");

test("workspace enrollment deploys a launchable Grok Build adapter", (t) => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "amo-grok-workspace-"));
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspacePath, "package.json"), "{}\n", "utf8");

  const enrollment = enrollWorkspace(
    { workspacePath, adapters: ["grok-build"] },
    { baseUrl: "http://127.0.0.1:17654" },
  );

  assert.deepEqual(enrollment.installedAdapters, ["grok-build"]);
  assert.equal(fs.existsSync(path.join(workspacePath, ".amo", "adapters", "grok-build.json")), true);
  assert.equal(fs.existsSync(path.join(workspacePath, ".amo", "hooks", "grok-message.mjs")), true);
  assert.equal(fs.existsSync(path.join(workspacePath, ".grok", "hooks", "amo.json")), true);

  const inspection = inspectWorkspace({ workspacePath });
  const grok = inspection.supportedAdapters.find((adapter) => adapter.id === "grok-build");
  assert.equal(grok?.deploymentStatus, "deployed");
  assert.deepEqual(grok?.deploymentIssues, []);
});
