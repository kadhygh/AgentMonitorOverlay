"use strict";

const fs = require("fs");
const path = require("path");
const core = require("../../prototypes/obsidian-sync-back-plugin/syncBackCore");

const repoRoot = path.resolve(__dirname, "..", "..");
const sampleNotePath = path.join(
  repoRoot,
  "examples",
  "obsidian",
  "test-vault-seed",
  "Notes",
  "codex-task-h-test.md"
);

const sampleNote = fs.readFileSync(sampleNotePath, "utf8");
const annotations = core.extractAnnotations(sampleNote);

if (annotations.length !== 4) {
  throw new Error(`Expected 4 annotations, got ${annotations.length}.`);
}

const binding = {
  targetSessionId: "codex-agent-monitor-overlay-task-h",
  expectedTool: "codex",
  cwd: "D:\\Projects\\CommonProject\\AgentMonitorOverlay",
  project: "AgentMonitorOverlay",
  windowHint: {
    titleToken: "[AMO:codex:agent-monitor-overlay:task-h]",
    process: "WindowsTerminal.exe",
    titleContains: ["Codex", "AgentMonitorOverlay"],
  },
};

const previewPath = core.defaultPreviewPath(
  "Notes/codex-task-h-test.md",
  "AMO/SyncBackPreviews"
);

const summary = core.buildSummary({
  generatedAt: "2026-05-11T00:00:00.000Z",
  sourceNotePath: "Notes/codex-task-h-test.md",
  previewNotePath: previewPath,
  binding,
  annotations,
});

if (!summary.includes("Total annotations: 4")) {
  throw new Error("Summary missing total annotation count.");
}

if (!summary.includes("question: 1") || !summary.includes("risk: 1")) {
  throw new Error("Summary missing expected kind counts.");
}

const request = core.buildSyncBackRequest({
  generatedAt: "2026-05-11T00:00:00.000Z",
  vaultName: "obsidian-sync-back-vault",
  sourceNotePath: "Notes/codex-task-h-test.md",
  previewNotePath: previewPath,
  binding,
  annotations,
  summary,
});

if (request.requestedAction !== "copy_focus_manual_send") {
  throw new Error("Request did not use the expected manual-send action.");
}

if (request.payload.annotationCount !== 4) {
  throw new Error("Request annotation count is incorrect.");
}

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      annotations: annotations.length,
      previewPath,
      requestKind: request.kind,
      requestedAction: request.requestedAction,
    },
    null,
    2
  ) + "\n"
);
