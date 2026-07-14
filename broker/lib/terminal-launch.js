const { spawn, spawnSync } = require("child_process");

async function launchCliInTerminal({
  workspacePath,
  title,
  command,
  args = [],
  environment = {},
  shellPreference = "windows-powershell",
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
    const { shell, shellFallback } = resolvePowerShell(shellPreference);
    if (shellFallback && typeof recordDebugLog === "function") {
      recordDebugLog("broker", "workspace.launch.pwsh_unavailable", {
        workspacePath,
        title,
        fallback: shell,
      });
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
      shell,
      ...powershellArgs,
    ];
    try {
      const result = await spawnDetached("wt.exe", wtArgs, workspacePath);
      return { ...result, shell, shellFallback };
    } catch (error) {
      if (typeof recordDebugLog === "function") {
        recordDebugLog("broker", "workspace.launch.wt_failed", {
          workspacePath,
          title,
          message: error.message || String(error),
        });
      }
    }

    const result = await spawnDetached(shell, powershellArgs, workspacePath);
    return { ...result, shell, shellFallback };
  }

  const result = await spawnDetached(command, [], workspacePath);
  return { ...result, shell: null, shellFallback: false };
}

function executableAvailable(command) {
  const result = spawnSync("where.exe", [command], {
    windowsHide: true,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function resolvePowerShell(shellPreference, isAvailable = executableAvailable) {
  const requestedPowerShell7 = shellPreference === "powershell7";
  const powerShell7Available = requestedPowerShell7 && isAvailable("pwsh.exe");
  return {
    shell: powerShell7Available ? "pwsh.exe" : "powershell.exe",
    shellFallback: requestedPowerShell7 && !powerShell7Available,
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
  resolvePowerShell,
  spawnDetached,
};
