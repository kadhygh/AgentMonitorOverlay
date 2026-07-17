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
  cleanupPaths = [],
  environment = {},
  launchEnvironment = WINDOWS_POWERSHELL,
  recordDebugLog = null,
}) {
  const commandLine = buildPowerShellCommandLine({ workspacePath, title, command, args, cleanupPaths });
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
        const result = await spawnDetached(selected.terminalExecutable, alacrittyArgs, workspacePath, { environment });
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
      "--inheritEnvironment",
      "--title",
      title,
      "--suppressApplicationTitle",
      "-d",
      workspacePath,
      selected.shellExecutable,
      ...powershellArgs,
    ];
    try {
      const result = await spawnDetached("wt.exe", wtArgs, workspacePath, { environment });
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

    const result = await spawnDetached(selected.shellExecutable, powershellArgs, workspacePath, { environment });
    return decorateLaunchResult(result, selected);
  }

  const result = await spawnDetached(command, args, workspacePath, { environment });
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

function buildPowerShellCommandLine({
  workspacePath,
  title,
  command,
  args = [],
  cleanupPaths = [],
}) {
  const cliArgs = args.map(powershellSingleQuoted).join(" ");
  const invocation = `& ${command}${cliArgs ? ` ${cliArgs}` : ""}`;
  const prefix = `$Host.UI.RawUI.WindowTitle = ${powershellSingleQuoted(title)}; Set-Location -LiteralPath ${powershellSingleQuoted(workspacePath)};`;
  const cleanupCommands = cleanupPaths
    .filter((filePath) => typeof filePath === "string" && filePath.trim())
    .map((filePath) => `Remove-Item -LiteralPath ${powershellSingleQuoted(filePath)} -Force -ErrorAction SilentlyContinue`);

  return cleanupCommands.length > 0
    ? `${prefix} try { ${invocation} } finally { ${cleanupCommands.join("; ")} }`
    : `${prefix} ${invocation}`;
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
        env: launchProcessEnvironment(options.environment),
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

function launchProcessEnvironment(environment = {}) {
  const additions = Object.fromEntries(
    Object.entries(environment)
      .filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value !== null && value !== undefined && String(value).length > 0)
      .map(([name, value]) => [name, String(value)]),
  );
  return { ...process.env, ...additions };
}

module.exports = {
  buildPowerShellCommandLine,
  launchCliInTerminal,
  launchProcessEnvironment,
  spawnDetached,
};
