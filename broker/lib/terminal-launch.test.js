const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePowerShell } = require("./terminal-launch");

test("managed CLI uses Windows PowerShell by default", () => {
  assert.deepEqual(resolvePowerShell("windows-powershell", () => true), {
    shell: "powershell.exe",
    shellFallback: false,
  });
});

test("managed CLI uses PowerShell 7 when requested and available", () => {
  assert.deepEqual(resolvePowerShell("powershell7", (command) => command === "pwsh.exe"), {
    shell: "pwsh.exe",
    shellFallback: false,
  });
});

test("managed CLI falls back when PowerShell 7 is unavailable", () => {
  assert.deepEqual(resolvePowerShell("powershell7", () => false), {
    shell: "powershell.exe",
    shellFallback: true,
  });
});
