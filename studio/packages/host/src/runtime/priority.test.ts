import { spawn, spawnSync } from "node:child_process";
import { constants, getPriority } from "node:os";
import { describe, expect, it } from "vitest";
import { lowerAgentIo, lowerAgentPriority, spawnClaudeProcess } from "./priority.js";

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

/** A process's I/O priority (2 normal, 1 low) and memory priority (5 normal, 2 low), read through ntdll. */
function ioAndPage(pid: number): [number, number] {
  const script = [
    `Add-Type -Namespace AmoTest -Name Q -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int c, ref int v, int n, out int r); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int p);'`,
    `$h = [AmoTest.Q]::OpenProcess(0x1000, $false, ${pid}); $io = -1; $pg = -1; $r = 0`,
    `[void][AmoTest.Q]::NtQueryInformationProcess($h, 33, [ref]$io, 4, [ref]$r); [void][AmoTest.Q]::NtQueryInformationProcess($h, 39, [ref]$pg, 4, [ref]$r)`,
    `Write-Output "$io,$pg"`,
  ].join("\n");
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true }).stdout.trim();
  const [io, page] = out.split(",").map(Number);
  return [io!, page!];
}

describe.runIf(process.platform === "win32")("agent I/O and memory priority (10-22)", () => {
  it("goes low for the agent and for what it starts afterwards", async () => {
    // The parent starts its child once told to (after its own priority changed), and prints the child's pid.
    const parent = spawn(process.execPath, ["-e", "process.stdin.once('data', () => { const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); setTimeout(() => {}, 30000); });"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let childPid = 0;
    try {
      expect(await lowerAgentIo(parent.pid!)).toBe(true);
      expect(ioAndPage(parent.pid!)).toEqual([1, 2]);
      const printed = new Promise<string>((resolve) => parent.stdout!.once("data", (d: Buffer) => resolve(d.toString())));
      parent.stdin!.write("go\n");
      childPid = Number(await printed);
      expect(ioAndPage(childPid)).toEqual([1, 2]);
    } finally {
      if (childPid) process.kill(childPid);
      parent.kill();
    }
  }, 30_000);

  it("answers false for a process that is gone", async () => {
    expect(await lowerAgentIo(999_999_999)).toBe(false);
  });
});
