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
 *
 * cmd's line is written out verbatim: Node's own quoting escapes inner quotes as `\"`, which cmd does not know, so a
 * title with spaces split into a title and a program (`AMO Studio 维护` → "Windows 找不到文件 'Studio'"). The PowerShell
 * command travels in the window's environment ({@link TERMINAL_COMMAND_ENV}), out of reach of cmd's `&`, `%` and quotes;
 * the fixed line on the command line takes it out of the environment (so the programs it starts do not inherit it) and
 * runs it.
 *
 * 10-28: it went base64-encoded on the command line before; an antivirus took encoded PowerShell in Studio for a trojan,
 * so no encoded command any more. Not a temporary .ps1 either: running a script file needs the execution policy to allow
 * it (Windows' default does not, and overriding it looks just as suspect), and stdin cannot carry the command: the window
 * reads the person's typing from it.
 */
export class WindowsTerminalLauncher implements TerminalLauncher {
  launch({ command, cwd, env, title, envMode = "merge", track = false }: TerminalLaunch): TerminalHandle | undefined {
    if (process.platform !== "win32") throw new Error("terminal launch is only implemented on Windows");
    const child = spawn("cmd.exe", [windowsStartLine({ cwd, title, track })], {
      env: { ...(envMode === "replace" ? env : { ...process.env, ...env }), [TERMINAL_COMMAND_ENV]: command },
      detached: true,
      stdio: "ignore",
      windowsHide: track,
      windowsVerbatimArguments: true,
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

/** The environment variable that hands the terminal's PowerShell its command. */
export const TERMINAL_COMMAND_ENV = "AMO_STUDIO_TERMINAL_COMMAND";

/** cmd.exe's arguments for {@link WindowsTerminalLauncher}, as one verbatim line; the command itself is in {@link TERMINAL_COMMAND_ENV}. */
export function windowsStartLine({ cwd, title, track }: Pick<TerminalLaunch, "cwd" | "title"> & { track: boolean }): string {
  // Inside quotes cmd still ends the string at `"` and expands `%VAR%`.
  const safeTitle = title.replace(/["%\r\n]/g, "").trim() || "AMO Studio";
  // No `"`, `%`, `&` or `^` inside: cmd passes it on as it is, and PowerShell gets it as one argument.
  const run = `$c = $env:${TERMINAL_COMMAND_ENV}; Remove-Item Env:${TERMINAL_COMMAND_ENV}; Invoke-Expression $c`;
  const shellArgs = [...(track ? [] : ["-NoExit"]), "-NoLogo", "-Command", `"${run}"`];
  return ["/d", "/c", "start", `"${safeTitle}"`, ...(track ? ["/WAIT"] : []), "/D", `"${cwd}"`, "powershell.exe", ...shellArgs].join(" ");
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
