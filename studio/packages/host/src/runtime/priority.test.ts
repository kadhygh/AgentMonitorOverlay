import { spawn, spawnSync } from "node:child_process";
import { constants, getPriority } from "node:os";
import { describe, expect, it } from "vitest";
import { lowerAgentMemory, lowerAgentPriority, spawnClaudeProcess } from "./priority.js";

// Agent processes run below normal priority, and what they start inherits it (10-21, the desktop-wide lag).

const BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL;

function idleNode() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
}

describe("agent priority", () => {
  it("lowers a process one step, unless AMO_STUDIO_AGENT_PRIORITY=normal", () => {
    const lowered = idleNode();
    const kept = idleNode();
    try {
      lowerAgentPriority(lowered.pid, {});
      lowerAgentPriority(kept.pid, { AMO_STUDIO_AGENT_PRIORITY: "normal" });
      expect(getPriority(lowered.pid)).toBe(BELOW_NORMAL);
      // Left as it starts: at this process's own priority (a test run may itself be lowered).
      expect(getPriority(kept.pid)).toBe(getPriority());
    } finally {
      lowered.kill();
      kept.kill();
    }
  });

  it("leaves a process that is already gone alone", () => {
    expect(() => lowerAgentPriority(999_999_999, {})).not.toThrow();
  });

  it("starts Claude Code lowered, its children too, and logs the end of stderr when it fails", async () => {
    const lines: string[] = [];
    // The child reports the priority it was started with, as git under claude.exe would get it.
    const script = [
      "const { execFileSync } = require('node:child_process');",
      "const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(require(\"node:os\").getPriority()))']);",
      "process.stdout.write(String(out));",
      "process.stderr.write('boom');",
      "process.exit(3);",
    ].join("\n");
    const child = spawnClaudeProcess((l) => lines.push(l))({ command: process.execPath, args: ["-e", script], env: { ...process.env }, signal: new AbortController().signal });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(Number(out)).toBe(BELOW_NORMAL);
    expect(lines).toEqual(["Claude Code exited with code 3: boom"]);
  });
});

/** A process's memory priority (5 normal, 2 low), read through GetProcessInformation (kernel32, documented). */
function memoryPriority(pid: number): number {
  const script = [
    `try { $ErrorActionPreference = 'Stop'`,
    `Add-Type -Namespace AmoTest -Name Q -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int p); [DllImport("kernel32.dll")] public static extern bool GetProcessInformation(IntPtr h, int c, ref int v, int n); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'`,
    `$h = [AmoTest.Q]::OpenProcess(0x1000, $false, ${pid}); $m = -1; [void][AmoTest.Q]::GetProcessInformation($h, 0, [ref]$m, 4); [void][AmoTest.Q]::CloseHandle($h)`,
    `Write-Output $m } catch { exit 1 }`,
  ].join("; ");
  return Number(spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { input: `${script}
`, encoding: "utf8", windowsHide: true }).stdout.trim());
}

describe.runIf(process.platform === "win32")("agent memory priority (10-22; the I/O priority is no longer lowered, 10-28)", () => {
  it("goes low for the agent and for what it starts afterwards", async () => {
    // The parent starts its child once told to (after its own priority changed), and prints the child's pid.
    const parent = spawn(process.execPath, ["-e", "process.stdin.once('data', () => { const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); setTimeout(() => {}, 30000); });"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let childPid = 0;
    try {
      expect(memoryPriority(parent.pid!)).toBe(5);
      expect(await lowerAgentMemory(parent.pid!)).toBe(true);
      expect(memoryPriority(parent.pid!)).toBe(2);
      const printed = new Promise<string>((resolve) => parent.stdout!.once("data", (d: Buffer) => resolve(d.toString())));
      parent.stdin!.write("go\n");
      childPid = Number(await printed);
      expect(memoryPriority(childPid)).toBe(2);
    } finally {
      if (childPid) process.kill(childPid);
      parent.kill();
    }
  }, 30_000);

  it("answers false for a process that is gone", async () => {
    expect(await lowerAgentMemory(999_999_999)).toBe(false);
  });
});
