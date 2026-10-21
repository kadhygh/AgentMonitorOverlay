import { spawn } from "node:child_process";
import { constants, getPriority } from "node:os";
import { describe, expect, it } from "vitest";
import { lowerAgentPriority, spawnClaudeProcess } from "./priority.js";

// Agent processes run below normal priority, and what they start inherits it (10-21, the desktop-wide lag).

const BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL;
const NORMAL = constants.priority.PRIORITY_NORMAL;

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
      expect(getPriority(kept.pid)).toBe(NORMAL);
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
