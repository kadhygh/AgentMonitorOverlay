const { spawn } = require("child_process");

async function launchCliInTerminal({ workspacePath, title, command, args = [], recordDebugLog = null }) {
  const cliArgs = args.map(powershellSingleQuoted).join(" ");
  const commandLine = `$Host.UI.RawUI.WindowTitle = ${powershellSingleQuoted(title)}; Set-Location -LiteralPath ${powershellSingleQuoted(workspacePath)}; & ${command}${cliArgs ? ` ${cliArgs}` : ""}`;
  const powershellArgs = powershellNoExitEncodedArgs(commandLine);
  if (process.platform === "win32") {
    const wtArgs = [
      "-w",
      "new",
      "new-tab",
      "--title",
      title,
      "-d",
      workspacePath,
      "powershell.exe",
      ...powershellArgs,
    ];
    try {
      return await spawnDetached("wt.exe", wtArgs, workspacePath);
    } catch (error) {
      if (typeof recordDebugLog === "function") {
        recordDebugLog("broker", "workspace.launch.wt_failed", {
          workspacePath,
          title,
          message: error.message || String(error),
        });
      }
    }

    return spawnDetached("powershell.exe", powershellArgs, workspacePath);
  }

  return spawnDetached(command, [], workspacePath);
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
