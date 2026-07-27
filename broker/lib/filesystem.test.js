const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeTextFile } = require("./filesystem");

test("writeTextFile retries a transient Windows-style replacement failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-filesystem-retry-"));
  const filePath = path.join(root, "state.json");
  const originalRenameSync = fs.renameSync;
  let renameCalls = 0;

  t.after(() => {
    fs.renameSync = originalRenameSync;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(filePath, "old", "utf8");
  fs.renameSync = (source, destination) => {
    renameCalls += 1;
    if (renameCalls === 1) {
      const error = new Error("temporary file lock");
      error.code = "EPERM";
      throw error;
    }
    return originalRenameSync(source, destination);
  };

  writeTextFile(filePath, "new");

  assert.equal(fs.readFileSync(filePath, "utf8"), "new");
  assert.equal(renameCalls, 2);
});

test("writeTextFile falls back to copy when Windows keeps rejecting rename", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-filesystem-copy-"));
  const filePath = path.join(root, "state.json");
  const originalRenameSync = fs.renameSync;

  t.after(() => {
    fs.renameSync = originalRenameSync;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(filePath, "old", "utf8");
  fs.renameSync = () => {
    const error = new Error("persistent file lock");
    error.code = "EPERM";
    throw error;
  };

  writeTextFile(filePath, "new");

  assert.equal(fs.readFileSync(filePath, "utf8"), "new");
  assert.equal(fs.existsSync(filePath + "." + process.pid + ".tmp"), false);
});