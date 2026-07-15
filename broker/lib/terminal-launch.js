const { spawn } = require("child_process");
const {
  WINDOWS_POWERSHELL,
  resolveCliLaunchEnvironment,
} = require("./cli-environments");

async function launchCliInTerminal({
  workspacePath,
  title,
  command,
  args = [],
  environment = {},
  launchEnvironment = WINDOWS_POWERSHELL,
  recordDebugLog = null,
}) {
  const cliArgs = args.map(powershellSingleQuoted).join(" ");
  const environmentAssignments = Object.entries(environment)
    .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
    .map(([name, value]) => `$env:${name} = ${powershellSingleQuoted(value)}`)
    .join("; ");
  const commandLine = `${environmentAssignments ? `${environmentAssignments}; ` : ""}$Host.UI.RawUI.WindowTitle = ${powershellSingleQuoted(title)}; Set-Location -LiteralPath ${powershellSingleQuoted(workspacePath)}; & ${command}${cliArgs ? ` ${cliArgs}` : ""}`;
  const powershellArgs = powershellNoExitEncodedArgs(commandLine);
  if (process.platform === "win32") {
    let selected = resolveCliLaunchEnvironment(launchEnvironment);
    if (selected.fallback && typeof recordDebugLog === "function") {
      recordDebugLog("broker", "workspace.launch.environment_fallback", {
        workspacePath,
        title,
        requestedEnvironment: selected.requestedId,
        fallbackEnvironment: selected.id,
      });
    }

    if (selected.terminal === "alacritty") {
      const alacrittyArgs = [
        "--title",
        title,
        "--working-directory",
        workspacePath,
        "-e",
        selected.shellExecutable,
        ...powershellArgs,
      ];
      try {
        const result = await spawnDetached(selected.terminalExecutable, alacrittyArgs, workspacePath);
        return decorateLaunchResult(result, selected);
      } catch (error) {
        if (typeof recordDebugLog === "function") {
          recordDebugLog("broker", "workspace.launch.alacritty_failed", {
            workspacePath,
            title,
            executable: selected.terminalExecutable,
            message: error.message || String(error),
          });
        }
        const requestedId = selected.requestedId;
        selected = resolveCliLaunchEnvironment(WINDOWS_POWERSHELL);
        selected.requestedId = requestedId;
        selected.fallback = true;
      }
    }

    const wtArgs = [
      "-w",
      "new",
      "new-tab",
      "--title",
      title,
      "--suppressApplicationTitle",
      "-d",
      workspacePath,
      selected.shellExecutable,
      ...powershellArgs,
    ];
    try {
      const result = await spawnDetached("wt.exe", wtArgs, workspacePath);
      return decorateLaunchResult(result, selected);
    } catch (error) {
      if (typeof recordDebugLog === "function") {
        recordDebugLog("broker", "workspace.launch.wt_failed", {
          workspacePath,
          title,
          message: error.message || String(error),
        });
      }
    }

    const result = await spawnDetached(selected.shellExecutable, powershellArgs, workspacePath);
    return decorateLaunchResult(result, selected);
  }

  const result = await spawnDetached(command, [], workspacePath);
  return {
    ...result,
    shell: null,
    shellFallback: false,
    launchEnvironment: null,
    requestedLaunchEnvironment: null,
    environmentFallback: false,
  };
}

function decorateLaunchResult(result, selected) {
  return {
    ...result,
    terminal: selected.terminal,
    terminalExecutable: selected.terminalExecutable,
    shell: selected.shellExecutable,
    shellFallback: selected.fallback,
    launchEnvironment: selected.id,
    requestedLaunchEnvironment: selected.requestedId,
    environmentFallback: selected.fallback,
  };
}

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powershellNoExitEncodedArgs(commandLine) {
  return [
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(commandLine, "utf16le").toString("base64"),
  ];
}

function spawnDetached(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: options.windowsHide ?? false,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    child.once("error", (error) => {
      finish(reject, error);
    });
    child.once("spawn", () => {
      child.unref();
      finish(resolve, {
        pid: child.pid || null,
        command,
        args,
      });
    });
  });
}

module.exports = {
  launchCliInTerminal,
  spawnDetached,
};
