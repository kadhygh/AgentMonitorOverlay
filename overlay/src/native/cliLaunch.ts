export type CliLaunchEnvironment = "windows-powershell" | "powershell7" | "alacritty-powershell7";

const CLI_ENVIRONMENT_STORAGE_KEY = "amo.cli.launchEnvironment";
const LEGACY_CLI_SHELL_STORAGE_KEY = "amo.cli.shell";

export function loadCliLaunchEnvironment(): CliLaunchEnvironment {
  try {
    const value = localStorage.getItem(CLI_ENVIRONMENT_STORAGE_KEY) || localStorage.getItem(LEGACY_CLI_SHELL_STORAGE_KEY);
    return value === "powershell7" || value === "alacritty-powershell7" ? value : "windows-powershell";
  } catch {
    return "windows-powershell";
  }
}

export function saveCliLaunchEnvironment(environment: CliLaunchEnvironment) {
  try {
    localStorage.setItem(CLI_ENVIRONMENT_STORAGE_KEY, environment);
    localStorage.removeItem(LEGACY_CLI_SHELL_STORAGE_KEY);
  } catch {
    // Keep the in-memory setting usable when WebView storage is unavailable.
  }
}

export function cliLaunchPreferencePayload() {
  return { launchEnvironment: loadCliLaunchEnvironment() };
}
