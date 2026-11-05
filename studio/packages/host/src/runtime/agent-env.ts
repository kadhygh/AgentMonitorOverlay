// What the Host's own environment carries for itself and must not reach the models' processes, nor the commands they
// run (2026-10-30, the user iterating AMO from the installed AMO): the installed Studio starts its Host with
// ELECTRON_RUN_AS_NODE=1 — an agent's e2e run, `electron` or dev Studio then starts as plain Node ("bad option:
// --remote-debugging-port") — and AMO_STUDIO_* (DATA_DIR, UI_DIR, VERSION…) — a dev Studio an agent starts would open
// the installed one's data folder and UI. A runtime that needs one of them (Codex's codex.js under Electron's Node, the
// MCP token) sets it again on top. The maintenance terminal drops these and more (features/maintenance).
const HOST_ONLY = /^(ELECTRON_RUN_AS_NODE|AMO_STUDIO_.*)$/i;

export const hostOnlyEnv = (key: string): boolean => HOST_ONLY.test(key);

export function withoutHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !HOST_ONLY.test(k)));
}

/**
 * 设置 → 功能 → 命令行适配 (2026-11-06, the user: Studio does it for every agent instead of each person's own config; a
 * switch to turn it off). A look over this machine's transcripts (Claude 42,770 Bash and 4,501 PowerShell commands, Codex
 * 184,870): the commonest Windows-only failure was garbled Chinese — Python printing in GBK to a shell reading UTF-8
 * (Claude's Git Bash, 469 times; 31 sessions set PYTHONIOENCODING by hand after the fact), and Windows PowerShell 5.1
 * reading UTF-8 files without -Encoding (Codex, 6,700 times in May–June, gone once pwsh and a UTF-8 profile came in).
 * These go under the agent's environment, so the commands it runs inherit them; a value the person set wins.
 */
export const SHELL_HELP_KEY = "settings:agent-shell-help";
export const SHELL_HELP_ENV: Readonly<Record<string, string>> = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

/** On unless the person turned it off. */
export function readShellHelp(kv: { getKv(key: string): { value: string } | undefined }): boolean {
  return kv.getKv(SHELL_HELP_KEY)?.value !== "0";
}

/** The variables to put under an agent's environment (spread first, so the inherited ones win). */
export function shellHelpEnv(kv: { getKv(key: string): { value: string } | undefined }): Record<string, string> {
  return readShellHelp(kv) ? { ...SHELL_HELP_ENV } : {};
}
