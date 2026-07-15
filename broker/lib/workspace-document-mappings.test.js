const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  inspectWorkspaceDocumentMappings,
  updateWorkspaceDocumentMapping,
} = require("./workspace-document-mappings");

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-document-mapping-"));
  const workspacePath = path.join(root, "project");
  const vaultRoot = path.join(workspacePath, ".amo", "AMO - project");
  fs.mkdirSync(path.join(workspacePath, "AIWork"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "Docs"), { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "AIWork", "README.md"), "# Active work\n", "utf8");
  fs.writeFileSync(
    path.join(workspacePath, ".amo", "workspace.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      workspaceId: "ws_test",
      workspacePath,
      projectName: "project",
      vaultRoot,
    }, null, 2)}\n`,
    "utf8",
  );
  return { root, workspacePath, vaultRoot };
}

test("project document mapping creates a live vault junction and removes only the link", () => {
  const fixture = createWorkspace();
  try {
    const added = updateWorkspaceDocumentMapping({
      workspacePath: fixture.workspacePath,
      sourcePath: path.join(fixture.workspacePath, "AIWork"),
      action: "add",
    });
    const targetPath = path.join(fixture.vaultRoot, "Project", "AIWork");

    assert.equal(added.changed, true);
    assert.equal(fs.lstatSync(targetPath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(targetPath, "README.md"), "utf8"), "# Active work\n");
    assert.equal(added.documentMappings.entries.find((entry) => entry.label === "AIWork")?.status, "mapped");

    const repeated = updateWorkspaceDocumentMapping({
      workspacePath: fixture.workspacePath,
      sourcePath: path.join(fixture.workspacePath, "AIWork"),
      action: "add",
    });
    assert.equal(repeated.changed, false);

    const removed = updateWorkspaceDocumentMapping({
      workspacePath: fixture.workspacePath,
      sourcePath: "AIWork",
      action: "remove",
    });
    assert.equal(removed.changed, true);
    assert.equal(fs.existsSync(targetPath), false);
    assert.equal(fs.existsSync(path.join(fixture.workspacePath, "AIWork", "README.md")), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("inspection does not infer document mappings from workspace folder names", () => {
  const fixture = createWorkspace();
  try {
    const status = inspectWorkspaceDocumentMappings(fixture.workspacePath, fixture.vaultRoot, {
      vaultRoot: fixture.vaultRoot,
      documentMappings: [],
    });

    assert.equal(status.available, true);
    assert.deepEqual(status.entries, []);
    assert.equal(status.mappedCount, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mapping rejects the workspace root and normal-directory target conflicts", () => {
  const fixture = createWorkspace();
  try {
    assert.throws(
      () =>
        updateWorkspaceDocumentMapping({
          workspacePath: fixture.workspacePath,
          sourcePath: fixture.workspacePath,
          action: "add",
        }),
      (error) => error?.code === "document_mapping_outside_workspace",
    );

    fs.mkdirSync(path.join(fixture.vaultRoot, "Project", "AIWork"), { recursive: true });
    assert.throws(
      () =>
        updateWorkspaceDocumentMapping({
          workspacePath: fixture.workspacePath,
          sourcePath: path.join(fixture.workspacePath, "AIWork"),
          action: "add",
        }),
      (error) => error?.code === "document_mapping_conflict",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
