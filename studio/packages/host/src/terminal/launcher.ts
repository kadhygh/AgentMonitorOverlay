import { spawn } from "node:child_process";

// Opens a new terminal window that runs a command. The secret travels only in the child's environment.

export interface TerminalLaunch {
  command: string;
  cwd: string;
  env: Record<string, string>;
  title: string;
  /** `merge` (default): added to the Host's environment. `replace`: the complete environment of the terminal. */
  envMode?: "merge" | "replace";
  /** Return a handle that reports when the terminal window closes (Claude handoff). */
  track?: boolean;
}

/** A launched terminal the Host keeps an eye on. */
export interface TerminalHandle {
  readonly running: boolean;
  onExit(listener: () => void): void;
  /** Closes the terminal (and what runs in it). */
  kill(): void;
}

export interface TerminalLauncher {
  launch(request: TerminalLaunch): TerminalHandle | undefined;
}

/**
 * Windows: `start` opens a new console running PowerShell; it inherits the env we pass to cmd. With `track`, cmd runs
 * `start /WAIT` without a window of its own, so its exit tells when the terminal window was closed.
 */
export class WindowsTerminalLauncher implements TerminalLauncher {
  launch({ command, cwd, env, title, envMode = "merge", track = false }: TerminalLaunch): TerminalHandle | undefined {
    if (process.platform !== "win32") throw new Error("terminal launch is only implemented on Windows");
    const shellArgs = track ? ["-NoLogo", "-Command", command] : ["-NoExit", "-NoLogo", "-Command", command];
    const child = spawn("cmd.exe", ["/d", "/c", "start", JSON.stringify(title), ...(track ? ["/WAIT"] : []), "/D", cwd, "powershell.exe", ...shellArgs], {
      env: envMode === "replace" ? env : { ...process.env, ...env },
      detached: true,
      stdio: "ignore",
      windowsHide: track,
      windowsVerbatimArguments: false,
    });
    child.unref();
    if (!track) return undefined;
    let running = true;
    const listeners: Array<() => void> = [];
    child.once("exit", () => {
      running = false;
      for (const l of listeners.splice(0)) l();
    });
    return {
      get running() {
        return running;
      },
      onExit: (listener) => {
        if (running) listeners.push(listener);
        else listener();
      },
      kill: () => {
        if (!running || child.pid === undefined) return;
        // The whole tree: the waiting cmd, the PowerShell window and the program in it.
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      },
    };
  }
}

/** Test double for a tracked terminal: tests end it with `exit()`. */
export class FakeTerminalHandle implements TerminalHandle {
  running = true;
  killed = false;
  private readonly listeners: Array<() => void> = [];
  onExit(listener: () => void): void {
    if (this.running) this.listeners.push(listener);
    else listener();
  }
  kill(): void {
    this.killed = true;
    this.exit();
  }
  exit(): void {
    if (!this.running) return;
    this.running = false;
    for (const l of this.listeners.splice(0)) l();
  }
}

/** Test double: records launches instead of opening windows (no focus stealing in tests). */
export class RecordingTerminalLauncher implements TerminalLauncher {
  readonly launches: TerminalLaunch[] = [];
  readonly handles: FakeTerminalHandle[] = [];
  launch(request: TerminalLaunch): TerminalHandle | undefined {
    this.launches.push(request);
    if (!request.track) return undefined;
    const handle = new FakeTerminalHandle();
    this.handles.push(handle);
    return handle;
  }
}
