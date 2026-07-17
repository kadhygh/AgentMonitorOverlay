const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectCliEnvironments,
  resolveCliLaunchEnvironment,
} = require("./cli-environments");
const {
  buildPowerShellCommandLine,
  launchProcessEnvironment,
} = require("./terminal-launch");

const executablePaths = {
  "powershell.exe": "C:\\Windows\\powershell.exe",
  "pwsh.exe": "C:\\PowerShell\\pwsh.exe",
  "alacritty.exe": "C:\\Alacritty\\alacritty.exe",
};

function findAvailable(command) {
  return executablePaths[command] || null;
}

test("managed CLI uses Windows PowerShell by default", () => {
  const result = resolveCliLaunchEnvironment("windows-powershell", { findExecutable: findAvailable });
  assert.equal(result.id, "windows-powershell");
  assert.equal(result.terminal, "windows-terminal");
  assert.equal(result.shellExecutable, executablePaths["powershell.exe"]);
  assert.equal(result.fallback, false);
});

test("managed CLI uses PowerShell 7 when requested and available", () => {
  const result = resolveCliLaunchEnvironment("powershell7", { findExecutable: findAvailable });
  assert.equal(result.id, "powershell7");
  assert.equal(result.terminal, "windows-terminal");
  assert.equal(result.shellExecutable, executablePaths["pwsh.exe"]);
  assert.equal(result.fallback, false);
});

test("managed CLI uses isolated Alacritty with PowerShell 7", () => {
  const result = resolveCliLaunchEnvironment("alacritty-powershell7", { findExecutable: findAvailable });
  assert.equal(result.id, "alacritty-powershell7");
  assert.equal(result.terminal, "alacritty");
  assert.equal(result.terminalExecutable, executablePaths["alacritty.exe"]);
  assert.equal(result.shellExecutable, executablePaths["pwsh.exe"]);
  assert.equal(result.fallback, false);
});

test("managed CLI falls back when its requested environment is unavailable", () => {
  const result = resolveCliLaunchEnvironment("alacritty-powershell7", {
    findExecutable: (command) => command === "powershell.exe" ? executablePaths[command] : null,
  });
  assert.equal(result.id, "windows-powershell");
  assert.equal(result.shellExecutable, executablePaths["powershell.exe"]);
  assert.equal(result.fallback, true);
});

test("CLI environment detection reports missing dependencies independently", () => {
  const result = detectCliEnvironments({
    findExecutable: (command) => command === "powershell.exe" ? executablePaths[command] : null,
    readPowerShellVersion: () => "5.1",
    readAlacrittyVersion: () => null,
  });
  assert.equal(result.defaultId, "windows-powershell");
  assert.equal(result.environments[0].available, true);
  assert.equal(result.environments[1].reason, "pwsh.exe was not found");
  assert.equal(result.environments[2].reason, "alacritty.exe was not found");
});

test("managed launch values are passed through the child process environment", () => {
  const environment = launchProcessEnvironment({
    AMO_LAUNCH_ID: "launch-test",
    "NOT VALID": "ignored",
    EMPTY: "",
  });
  assert.equal(environment.AMO_LAUNCH_ID, "launch-test");
  assert.equal(environment["NOT VALID"], undefined);
  assert.equal(environment.EMPTY, undefined);
});

test("Claude launch settings are removed when the CLI exits", () => {
  const commandLine = buildPowerShellCommandLine({
    workspacePath: "G:/PROJECT/demo",
    title: "[AMO:claude:test] Claude CLI",
    command: "claude",
    args: [
      "--settings",
      "C:/Users/Test User/AppData/Local/AgentMonitorOverlay/runtime/claude-launches/launch-test.settings.json",
      "--model",
      "glm-5.2[1m]",
    ],
    cleanupPaths: [
      "C:/Users/Test User/AppData/Local/AgentMonitorOverlay/runtime/claude-launches/launch-test.settings.json",
    ],
  });

  assert.match(commandLine, /try \{ & claude/);
  assert.match(commandLine, /'--settings' 'C:\/Users\/Test User\/AppData/);
  assert.match(commandLine, /'--model' 'glm-5\.2\[1m\]'/);
  assert.match(commandLine, /finally \{ Remove-Item -LiteralPath/);
  assert.match(commandLine, /-Force -ErrorAction SilentlyContinue/);
});
