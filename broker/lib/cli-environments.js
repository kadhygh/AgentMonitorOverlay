const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WINDOWS_POWERSHELL = "windows-powershell";
const POWERSHELL7 = "powershell7";
const ALACRITTY_POWERSHELL7 = "alacritty-powershell7";
const CLI_ENVIRONMENT_IDS = new Set([WINDOWS_POWERSHELL, POWERSHELL7, ALACRITTY_POWERSHELL7]);

function normalizeCliLaunchEnvironment(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CLI_ENVIRONMENT_IDS.has(normalized) ? normalized : WINDOWS_POWERSHELL;
}

function resolveCliLaunchEnvironment(value, options = {}) {
  const requestedId = normalizeCliLaunchEnvironment(value);
  const findExecutable = options.findExecutable || findWindowsExecutable;
  const windowsPowerShell = findExecutable("powershell.exe", windowsPowerShellCandidates()) || "powershell.exe";
  const powerShell7 = findExecutable("pwsh.exe", powerShell7Candidates());
  const alacritty = findExecutable("alacritty.exe", alacrittyCandidates());

  if (requestedId === ALACRITTY_POWERSHELL7 && alacritty && powerShell7) {
    return {
      requestedId,
      id: ALACRITTY_POWERSHELL7,
      terminal: "alacritty",
      terminalExecutable: alacritty,
      shellExecutable: powerShell7,
      fallback: false,
    };
  }

  if (requestedId === POWERSHELL7 && powerShell7) {
    return {
      requestedId,
      id: POWERSHELL7,
      terminal: "windows-terminal",
      terminalExecutable: "wt.exe",
      shellExecutable: powerShell7,
      fallback: false,
    };
  }

  return {
    requestedId,
    id: WINDOWS_POWERSHELL,
    terminal: "windows-terminal",
    terminalExecutable: "wt.exe",
    shellExecutable: windowsPowerShell,
    fallback: requestedId !== WINDOWS_POWERSHELL,
  };
}

function detectCliEnvironments(options = {}) {
  const findExecutable = options.findExecutable || findWindowsExecutable;
  const readPowerShellVersion = options.readPowerShellVersion || powerShellVersion;
  const readAlacrittyVersion = options.readAlacrittyVersion || alacrittyVersion;
  const windowsPowerShell = findExecutable("powershell.exe", windowsPowerShellCandidates()) || "powershell.exe";
  const powerShell7 = findExecutable("pwsh.exe", powerShell7Candidates());
  const alacritty = findExecutable("alacritty.exe", alacrittyCandidates());

  return {
    ok: true,
    defaultId: WINDOWS_POWERSHELL,
    environments: [
      {
        id: WINDOWS_POWERSHELL,
        label: "Windows PowerShell 5.1",
        available: true,
        terminal: "Windows Terminal",
        shell: "Windows PowerShell",
        executablePath: windowsPowerShell,
        version: readPowerShellVersion(windowsPowerShell),
      },
      {
        id: POWERSHELL7,
        label: "PowerShell 7",
        available: Boolean(powerShell7),
        terminal: "Windows Terminal",
        shell: "PowerShell 7",
        executablePath: powerShell7 || null,
        version: powerShell7 ? readPowerShellVersion(powerShell7) : null,
        reason: powerShell7 ? null : "pwsh.exe was not found",
      },
      {
        id: ALACRITTY_POWERSHELL7,
        label: "Alacritty + PowerShell 7",
        available: Boolean(alacritty && powerShell7),
        terminal: "Alacritty",
        shell: "PowerShell 7",
        executablePath: alacritty || null,
        shellPath: powerShell7 || null,
        version: alacritty ? readAlacrittyVersion(alacritty) : null,
        reason: !alacritty
          ? "alacritty.exe was not found"
          : !powerShell7
            ? "pwsh.exe was not found"
            : null,
      },
    ],
  };
}

function findWindowsExecutable(command, candidates = []) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function windowsPowerShellCandidates() {
  return [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
}

function powerShell7Candidates() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
  }
  return candidates;
}

function alacrittyCandidates() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Alacritty", "alacritty.exe"));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "Alacritty", "alacritty.exe"));
  }
  return candidates;
}

function powerShellVersion(executable) {
  return commandVersion(executable, ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
}

function alacrittyVersion(executable) {
  const raw = commandVersion(executable, ["--version"]);
  return raw?.replace(/^alacritty\s+/iu, "") || null;
}

function commandVersion(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim() || null;
}

module.exports = {
  ALACRITTY_POWERSHELL7,
  POWERSHELL7,
  WINDOWS_POWERSHELL,
  detectCliEnvironments,
  findWindowsExecutable,
  normalizeCliLaunchEnvironment,
  resolveCliLaunchEnvironment,
};
