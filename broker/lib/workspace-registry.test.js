const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createWorkspaceRegistry, normalizeWorkspaceLabel } = require("./workspace-registry");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-workspace-registry-"));
  const workspacePath = path.join(root, "project-dev");
  const workspaceFile = path.join(workspacePath, ".amo", "workspace.json");
  const dataFile = path.join(root, "data", "workspaces.json");
  fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
  fs.writeFileSync(workspaceFile, `${JSON.stringify({ workspaceId: "workspace-1", workspacePath }, null, 2)}\n`, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspacePath, workspaceFile, dataFile };
}

test("workspace label persists in project metadata and the central registry", (t) => {
  const fixture = createFixture(t);
  const registry = createWorkspaceRegistry({ dataFile: fixture.dataFile });
  registry.registerInspection({
    existingEnrollment: true,
    workspaceId: "workspace-1",
    workspacePath: fixture.workspacePath,
    projectName: "project-dev",
    workspaceLabel: null,
    supportedAdapters: [],
  });

  const updated = registry.updateLabel("workspace-1", "  dev1  ");

  assert.equal(updated.workspaceLabel, "dev1");
  assert.equal(JSON.parse(fs.readFileSync(fixture.workspaceFile, "utf8")).workspaceLabel, "dev1");
  assert.equal(createWorkspaceRegistry({ dataFile: fixture.dataFile }).list()[0].workspaceLabel, "dev1");
});

test("workspace label can be cleared and rejects unsafe values", (t) => {
  const fixture = createFixture(t);
  const registry = createWorkspaceRegistry({ dataFile: fixture.dataFile });
  registry.registerInspection({
    existingEnrollment: true,
    workspaceId: "workspace-1",
    workspacePath: fixture.workspacePath,
    projectName: "project-dev",
    workspaceLabel: "dev1",
    supportedAdapters: [],
  });

  assert.throws(() => registry.updateLabel("workspace-1", "dev/one"), (error) => error.code === "invalid_workspace_label");
  assert.throws(() => normalizeWorkspaceLabel("x".repeat(33), { strict: true }), (error) => error.code === "workspace_label_too_long");
  assert.equal(registry.updateLabel("workspace-1", "").workspaceLabel, null);
  assert.equal(JSON.parse(fs.readFileSync(fixture.workspaceFile, "utf8")).workspaceLabel, null);
});

test("workspace label update refuses mismatched project metadata", (t) => {
  const fixture = createFixture(t);
  const registry = createWorkspaceRegistry({ dataFile: fixture.dataFile });
  registry.registerInspection({
    existingEnrollment: true,
    workspaceId: "workspace-1",
    workspacePath: fixture.workspacePath,
    projectName: "project-dev",
    supportedAdapters: [],
  });
  fs.writeFileSync(fixture.workspaceFile, `${JSON.stringify({ workspaceId: "different-workspace" }, null, 2)}\n`, "utf8");

  assert.throws(
    () => registry.updateLabel("workspace-1", "dev1"),
    (error) => error.code === "workspace_identity_mismatch",
  );
});
