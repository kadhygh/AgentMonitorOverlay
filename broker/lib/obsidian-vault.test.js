const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { registerObsidianVault } = require("./obsidian-vault");

function createFixture({ loaded = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-obsidian-vault-"));
  const vaultRoot = path.join(root, "vault");
  const registryPath = path.join(root, "obsidian", "obsidian.json");
  fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  if (loaded) {
    fs.writeFileSync(path.join(vaultRoot, ".obsidian", "workspace.json"), "{}\n", "utf8");
  }
  return { root, vaultRoot, registryPath };
}

test("registering an already loaded vault skips the expensive process scan", () => {
  const fixture = createFixture({ loaded: true });
  let processScans = 0;
  try {
    const result = registerObsidianVault(fixture.vaultRoot, {
      registryPath: fixture.registryPath,
      countObsidianProcesses: () => {
        processScans += 1;
        return 2;
      },
    });

    assert.equal(result.runtimeConfigExists, true);
    assert.equal(result.obsidianProcessCount, null);
    assert.equal(processScans, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("registering an unloaded vault still scans for a running Obsidian process", () => {
  const fixture = createFixture();
  let processScans = 0;
  try {
    const result = registerObsidianVault(fixture.vaultRoot, {
      registryPath: fixture.registryPath,
      countObsidianProcesses: () => {
        processScans += 1;
        return 2;
      },
    });

    assert.equal(result.runtimeConfigExists, false);
    assert.equal(result.obsidianProcessCount, 2);
    assert.equal(processScans, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
