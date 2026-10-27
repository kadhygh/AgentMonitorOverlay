// The relay package's browser-safe parts, used as source (types, the fetch API, the texts for AIs).
export * from "../../relay/src/protocol.js";
export { RelayClient, RelayClientError, normalizeServer } from "../../relay/src/api.js";
export { messageAsText, notesAsText, taskAsText, taskPrompt, threadAsText, usagePrompt } from "../../relay/src/usage.js";
export type { McpHookup, RelayShell, SavedAccount, ShellInfo, UpdateInfo } from "../../relay/src/shell-api.js";
