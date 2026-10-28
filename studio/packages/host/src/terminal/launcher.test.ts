import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TERMINAL_COMMAND_ENV, windowsStartLine } from "./launcher.js";

// "Windows 找不到文件 'Studio'" (2026-10-20): Node's `\"` quoting split the window title into a title and a program.
// 10-28: the command goes in the environment, no longer as -EncodedCommand (an antivirus took that for a trojan).
describe("windowsStartLine", () => {
  it("quotes the title once for cmd and has PowerShell run the command from its environment", () => {
    const line = windowsStartLine({ cwd: "G:/PROJECT/repo", title: 'AMO Studio 维护 · "Claude" 50%', track: false });
    expect(line).toBe(`/d /c start "AMO Studio 维护 · Claude 50" /D "G:/PROJECT/repo" powershell.exe -NoExit -NoLogo -Command "$c = $env:${TERMINAL_COMMAND_ENV}; Remove-Item Env:${TERMINAL_COMMAND_ENV}; Invoke-Expression $c"`);
    expect(line).not.toMatch(/EncodedCommand|ExecutionPolicy/);
  });

  it("waits on a tracked terminal and keeps no shell open after the command", () => {
    const line = windowsStartLine({ cwd: "C:/w", title: "", track: true });
    expect(line).toMatch(/^\/d \/c start "AMO Studio" \/WAIT \/D "C:\/w" powershell\.exe -NoLogo -Command "[^"%&^]+"$/);
  });

  // The same line minus `start` (no window opens): cmd hands it on intact, and PowerShell runs a command full of what
  // cmd and PowerShell's own argument parsing would mangle, in the folder given, with the variable already gone.
  it.runIf(process.platform === "win32")("runs the command with its quotes, % and & intact, and does not pass the variable on", () => {
    const command = `Write-Output ("100%" + ' & ' + 'it''s' + " ""q"" " + [string](Test-Path Env:${TERMINAL_COMMAND_ENV})); Write-Output (Get-Location).Path`;
    const line = windowsStartLine({ cwd: process.cwd(), title: "t", track: true }).replace(/^\/d \/c start "t" \/WAIT \/D "[^"]*" /, "/d /c ");
    expect(line.startsWith("/d /c powershell.exe -NoLogo -Command ")).toBe(true);
    const run = spawnSync("cmd.exe", [line], { cwd: process.cwd(), env: { ...process.env, [TERMINAL_COMMAND_ENV]: command }, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
    expect(run.stdout.trim().split(/\r?\n/)).toEqual([`100% & it's "q" False`, process.cwd()]);
  }, 30_000);
});
