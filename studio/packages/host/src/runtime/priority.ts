import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import { join } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// Agent processes (Claude Code, Codex app-server, DSH) run one step below normal priority, and so does everything they
// start: Windows gives a below-normal process's priority to its children (git, builds, the agent's Bash commands). A
// heavy command in a big checkout then yields to the person's own windows. On 10-21 one git scan in project_mining took
// about 11 of 24 cores and the mouse and the IME lagged across the desktop. AMO_STUDIO_AGENT_PRIORITY=normal turns it off.
// 10-22: a below-normal process still reads and writes the disk at normal I/O priority and keeps its memory pages as
// long as anyone's, and an agent's grep over a checkout or a burst of processes still made the desktop lag; so its I/O
// priority goes to low and its memory priority to low too. Both pass to the processes it starts (tested on Windows 11).

/** Lowers a just-started agent process; a process that is already gone is left alone. */
export function lowerAgentPriority(pid: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (pid === undefined || env.AMO_STUDIO_AGENT_PRIORITY === "normal") return;
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Exited already, or not ours to change: it runs as it would have.
    return;
  }
  void lowerAgentIo(pid);
}

// ProcessIoPriority (33) to IoPriorityLow, ProcessPagePriority (39) to MEMORY_PRIORITY_LOW, through ntdll: Node has no
// call for either, so a hidden PowerShell sets them (about 0.4 s, after the start; best effort).
const IO_SCRIPT = (pid: number) =>
  [
    `Add-Type -Namespace AmoStudio -Name Io -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSetInformationProcess(IntPtr h, int c, ref int v, int n); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int p); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'`,
    `$h = [AmoStudio.Io]::OpenProcess(0x1200, $false, ${pid})`,
    `if ($h -eq [IntPtr]::Zero) { exit 2 }`,
    `$io = 1; $a = [AmoStudio.Io]::NtSetInformationProcess($h, 33, [ref]$io, 4)`,
    `$pg = 2; $b = [AmoStudio.Io]::NtSetInformationProcess($h, 39, [ref]$pg, 4)`,
    `[void][AmoStudio.Io]::CloseHandle($h)`,
    `if ($a -ne 0 -or $b -ne 0) { exit 3 }`,
  ].join("\n");

/** Low I/O and memory priority for an agent process; resolves whether both were set (false off Windows). */
export function lowerAgentIo(pid: number): Promise<boolean> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const encoded = Buffer.from(IO_SCRIPT(pid), "utf16le").toString("base64");
    try {
      const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
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
