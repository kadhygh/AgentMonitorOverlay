const CLI_LAUNCH_ADAPTERS = Object.freeze({
  "codex-cli": Object.freeze({ label: "Codex CLI", tool: "codex" }),
  "claude-cli": Object.freeze({ label: "Claude CLI", tool: "claude" }),
  "grok-build": Object.freeze({ label: "Grok Build", tool: "grok" }),
});

function launchAdapterInfo(adapterId) {
  return CLI_LAUNCH_ADAPTERS[adapterId] || null;
}

function launchAdapterLabel(adapterId) {
  return launchAdapterInfo(adapterId)?.label || "CLI";
}

function launchAdapterTool(adapterId) {
  return launchAdapterInfo(adapterId)?.tool || null;
}

module.exports = {
  CLI_LAUNCH_ADAPTERS,
  launchAdapterInfo,
  launchAdapterLabel,
  launchAdapterTool,
};
