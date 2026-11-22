// The relay package's browser-safe parts, used as source (types, the fetch API, the texts for AIs).
export * from "../../relay/src/protocol.js";
export { RelayClient, RelayClientError, normalizeServer } from "../../relay/src/api.js";
export { carriedNotes, fileNotesText, filesAsText, messageAsText, newRepliesText, notePlaces, notesAsText, sinceLastWord, taskAsText, taskPrompt, threadAsText, usagePointer, usagePrompt } from "../../relay/src/usage.js";
export type { NotedFile, NotePlaces } from "../../relay/src/usage.js";
export type { McpHookup, PickedSend, ReceiveState, RelayShell, SavedAccount, ShellInfo, ShellTransfer, UpdateInfo } from "../../relay/src/shell-api.js";
export * from "../../relay/src/transfer-protocol.js";
export * from "../../relay/src/cowork-protocol.js";
