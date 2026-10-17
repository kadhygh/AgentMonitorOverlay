const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { buildPowerShellCommandLine, launchCliInTerminal } = require("./terminal-launch");

test("encoded oversized task prompt is rejected before any terminal process can start", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(launchCliInTerminal({ workspacePath: os.tmpdir(), title: "length-check", command: "never-execute", args: ["--", "\"".repeat(8000)], exactArguments: true }), (error) => error.spawnOutcome === "not-spawned" && error.message.includes("Windows command-line limit"));
});

test("Windows PowerShell 5.1 exact task argv preserves Unicode, multiline and shell metacharacters", { skip: process.platform !== "win32" || process.env.AMO_TEST_NATIVE_ARGV !== "1" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo argv check "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capture = path.join(root, "capture argv.cjs"); const output = path.join(root, "argv.json");
  fs.writeFileSync(capture, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));", "utf8");
  const expected = ["--", "", "中文 🦘", "line1\nline2", "CR\r\nLF", "quote'\"", "\\\"quote", "tail\\", "$(throw 'injection')", "`backtick`", "-dangerous", "&|<>%!"];
  const command = buildPowerShellCommandLine({ workspacePath: root, title: "isolated argv capture", command: process.execPath, args: [capture, output, ...expected], exactArguments: true });
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output,"utf8")), expected);
});
