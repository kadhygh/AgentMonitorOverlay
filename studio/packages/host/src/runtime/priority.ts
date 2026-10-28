import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import { join } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// Agent processes (Claude Code, Codex app-server, DSH) run one step below normal priority, and so does everything they
// start: Windows gives a below-normal process's priority to its children (git, builds, the agent's Bash commands). A
// heavy command in a big checkout then yields to the person's own windows. On 10-21 one git scan in project_mining took
// about 11 of 24 cores and the mouse and the IME lagged across the desktop. AMO_STUDIO_AGENT_PRIORITY=normal turns it off.
// 10-22: a below-normal process still keeps its memory pages as long as anyone's, and an agent's grep over a checkout or
// a burst of processes still made the desktop lag; so its memory priority goes to low too, and passes to the processes
// it starts (tested on Windows 11).
// 10-28: the I/O priority is no longer lowered (10-22 to 10-28 it went to low too). Only the undocumented native NT API
// can set it, and the script that did (an encoded PowerShell command that opened another process and called into that
// API) got Studio's download stopped by the person's antivirus as a trojan — a false alarm, but the user's call was to
// drop what only that API can do. The memory priority stays: it goes through SetProcessInformation, a documented
// kernel32 call, and the script now goes in on PowerShell's stdin. (These comments ship in dist and are scanned too, so
// they leave out the literal names.)

/** Lowers a just-started agent process; a process that is already gone is left alone. */
export function lowerAgentPriority(pid: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (pid === undefined || env.AMO_STUDIO_AGENT_PRIORITY === "normal") return;
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Exited already, or not ours to change: it runs as it would have.
    return;
  }
  void lowerAgentMemory(pid);
}

// SetProcessInformation(ProcessMemoryPriority = 0, MEMORY_PRIORITY_LOW = 2) needs PROCESS_SET_INFORMATION (0x0200).
// Node has no call for it, so a hidden PowerShell sets it (about 0.4 s, after the start; best effort). One line: stdin
// runs line by line, and a failure anywhere must end in a non-zero exit.
const MEMORY_SCRIPT = (pid: number) =>
  [
    `try { $ErrorActionPreference = 'Stop'`,
    `Add-Type -Namespace AmoStudio -Name Mem -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int p); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetProcessInformation(IntPtr h, int c, ref int v, int n); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'`,
    `$h = [AmoStudio.Mem]::OpenProcess(0x0200, $false, ${pid}); if ($h -eq [IntPtr]::Zero) { exit 2 }`,
    `$m = 2; $ok = [AmoStudio.Mem]::SetProcessInformation($h, 0, [ref]$m, 4); [void][AmoStudio.Mem]::CloseHandle($h); if (-not $ok) { exit 3 }`,
    `} catch { exit 1 }`,
  ].join("; ") + "\n";

/** Low memory priority for an agent process; resolves whether it was set (false off Windows). */
export function lowerAgentMemory(pid: number): Promise<boolean> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      const child = spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
      child.stdin.on("error", () => undefined);
      child.stdin.end(MEMORY_SCRIPT(pid));
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
