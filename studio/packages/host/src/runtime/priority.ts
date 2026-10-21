import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// Agent processes (Claude Code, Codex app-server, DSH) run one step below normal priority, and so does everything they
// start: Windows gives a below-normal process's priority to its children (git, builds, the agent's Bash commands). A
// heavy command in a big checkout then yields to the person's own windows. On 10-21 one git scan in project_mining took
// about 11 of 24 cores and the mouse and the IME lagged across the desktop. AMO_STUDIO_AGENT_PRIORITY=normal turns it off.

/** Lowers a just-started agent process; a process that is already gone is left alone. */
export function lowerAgentPriority(pid: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (pid === undefined || env.AMO_STUDIO_AGENT_PRIORITY === "normal") return;
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Exited already, or not ours to change: it runs as it would have.
  }
}

const STDERR_TAIL = 4000;

/**
 * The SDK's own spawn (same command, pipes and abort signal) plus the lower priority. The SDK reads stderr only from
 * its own spawn, so the end of it goes to `log` when the process exits with an error.
 */
export function spawnClaudeProcess(log: (line: string) => void): (options: SpawnOptions) => SpawnedProcess {
  return ({ command, args, cwd, env, signal }) => {
    const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    lowerAgentPriority(child.pid, env);
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => {
      tail = (tail + s).slice(-STDERR_TAIL);
    });
    child.once("exit", (code) => {
      if (code && tail.trim()) log(`Claude Code exited with code ${code}: ${tail.trim()}`);
    });
    return child;
  };
}
