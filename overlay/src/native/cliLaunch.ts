export type CliShellPreference = "windows-powershell" | "powershell7";

const CLI_SHELL_STORAGE_KEY = "amo.cli.shell";

export function loadCliShellPreference(): CliShellPreference {
  try {
    return localStorage.getItem(CLI_SHELL_STORAGE_KEY) === "powershell7"
      ? "powershell7"
      : "windows-powershell";
  } catch {
    return "windows-powershell";
  }
}

export function saveCliShellPreference(preference: CliShellPreference) {
  try {
    localStorage.setItem(CLI_SHELL_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory setting usable when WebView storage is unavailable.
  }
}

export function cliLaunchPreferencePayload() {
  return { shellPreference: loadCliShellPreference() };
}
