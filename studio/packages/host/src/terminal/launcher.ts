import { spawn } from "node:child_process";

// Opens a new terminal window that runs a command. The secret travels only in the child's environment.

export interface TerminalLaunch {
  command: string;
  cwd: string;
  env: Record<string, string>;
  title: string;
}

export interface TerminalLauncher {
  launch(request: TerminalLaunch): void;
}

/** Windows: `start` opens a new console running PowerShell; it inherits the env we pass to cmd. */
export class WindowsTerminalLauncher implements TerminalLauncher {
  launch({ command, cwd, env, title }: TerminalLaunch): void {
    if (process.platform !== "win32") throw new Error("terminal launch is only implemented on Windows");
    const child = spawn("cmd.exe", ["/d", "/c", "start", JSON.stringify(title), "/D", cwd, "powershell.exe", "-NoExit", "-NoLogo", "-Command", command], {
      env: { ...process.env, ...env },
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: false,
    });
    child.unref();
  }
}

/** Test double: records launches instead of opening windows (no focus stealing in tests). */
export class RecordingTerminalLauncher implements TerminalLauncher {
  readonly launches: TerminalLaunch[] = [];
  launch(request: TerminalLaunch): void {
    this.launches.push(request);
  }
}
