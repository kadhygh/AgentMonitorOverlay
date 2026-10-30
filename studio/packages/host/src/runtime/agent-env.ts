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
