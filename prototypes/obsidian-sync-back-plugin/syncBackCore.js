"use strict";

const BEGIN_PREFIX = "<!-- AMO:ANNOTATION:BEGIN";
const END_MARKER = "<!-- AMO:ANNOTATION:END -->";

function createAnnotationId(now = new Date()) {
  const parts = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ];
  return `ann-${parts.join("")}`;
}

function createAnnotationBlock(options = {}) {
  const metadata = {
    id: options.id || createAnnotationId(),
    kind: options.kind || "note",
    priority: options.priority || "normal",
  };
  const body = `${options.body || "Fill in annotation text here."}`.trim();
  return `${BEGIN_PREFIX} ${JSON.stringify(metadata)} -->\n${body}\n${END_MARKER}`;
}

function extractAnnotations(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("Annotation source must be a string.");
  }

  const annotations = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const beginIndex = markdown.indexOf(BEGIN_PREFIX, cursor);
    if (beginIndex === -1) {
      break;
    }

    const beginEndIndex = markdown.indexOf("-->", beginIndex);
    if (beginEndIndex === -1) {
      throw new Error(`Annotation block at line ${lineNumberAt(markdown, beginIndex)} is missing '-->'.`);
    }

    const beginMarker = markdown.slice(beginIndex, beginEndIndex + 3);
    const endIndex = markdown.indexOf(END_MARKER, beginEndIndex + 3);
    if (endIndex === -1) {
      throw new Error(`Annotation block at line ${lineNumberAt(markdown, beginIndex)} is missing END marker.`);
    }

    const metadataText = beginMarker
      .slice(BEGIN_PREFIX.length, beginMarker.length - 3)
      .trim();
    let metadata = {};
    if (metadataText.length > 0) {
      try {
        metadata = JSON.parse(metadataText);
      } catch (error) {
        throw new Error(
          `Annotation metadata at line ${lineNumberAt(markdown, beginIndex)} is not valid JSON: ${error.message}`
        );
      }
    }

    const body = markdown.slice(beginEndIndex + 3, endIndex).trim();
    annotations.push({
      id: `${metadata.id || createAnnotationId()}`,
      kind: `${metadata.kind || "note"}`.trim() || "note",
      priority: `${metadata.priority || "normal"}`.trim() || "normal",
      body,
      metadata,
      line: lineNumberAt(markdown, beginIndex),
      beginIndex,
      endIndex: endIndex + END_MARKER.length,
    });

    cursor = endIndex + END_MARKER.length;
  }

  return annotations;
}

function buildSummary(options) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const sourceNotePath = options.sourceNotePath || "unknown-note.md";
  const previewNotePath = options.previewNotePath || null;
  const binding = options.binding || {};
  const annotations = Array.isArray(options.annotations) ? options.annotations : [];
  const kindCounts = countBy(annotations, (item) => item.kind || "note");
  const priorityCounts = countBy(annotations, (item) => item.priority || "normal");

  const lines = [];
  lines.push("# AMO Annotation Summary");
  lines.push("");
  lines.push(`Generated at: ${generatedAt}`);
  lines.push(`Source note: ${sourceNotePath}`);
  if (previewNotePath) {
    lines.push(`Preview note: ${previewNotePath}`);
  }
  if (binding.targetSessionId) {
    lines.push(`Target session: ${binding.targetSessionId}`);
  }
  if (binding.expectedTool) {
    lines.push(`Expected tool: ${binding.expectedTool}`);
  }
  if (binding.project) {
    lines.push(`Project: ${binding.project}`);
  }
  if (binding.cwd) {
    lines.push(`CWD: ${binding.cwd}`);
  }
  lines.push("");
  lines.push("## Stats");
  lines.push("");
  lines.push(`- Total annotations: ${annotations.length}`);
  lines.push("- By kind:");
  for (const [kind, count] of Object.entries(kindCounts)) {
    lines.push(`  - ${kind}: ${count}`);
  }
  lines.push("- By priority:");
  for (const [priority, count] of Object.entries(priorityCounts)) {
    lines.push(`  - ${priority}: ${count}`);
  }
  lines.push("");
  lines.push("## Items");
  lines.push("");

  if (annotations.length === 0) {
    lines.push("_No annotation blocks were found._");
    lines.push("");
  } else {
    for (const annotation of annotations) {
      lines.push(`### ${annotation.id} · ${annotation.kind} · ${annotation.priority}`);
      lines.push("");
      lines.push(annotation.body || "_Empty annotation body._");
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function buildSyncBackRequest(options) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const binding = options.binding || {};
  const annotations = Array.isArray(options.annotations) ? options.annotations : [];
  const summary = options.summary || "";

  return {
    kind: "amo.syncBack.request",
    version: 1,
    requestId: options.requestId || `sync-back-${Date.now()}`,
    requestedAt: generatedAt,
    source: {
      app: "obsidian",
      vault: options.vaultName || null,
      notePath: options.sourceNotePath || null,
      subpath: options.subpath || null,
      annotationIds: annotations.map((item) => item.id),
    },
    target: {
      sessionId: binding.targetSessionId || null,
      expectedTool: binding.expectedTool || null,
      cwd: binding.cwd || null,
      project: binding.project || null,
      windowHint: binding.windowHint || null,
    },
    payload: {
      format: "markdown",
      summary,
      annotationCount: annotations.length,
      previewNotePath: options.previewNotePath || null,
    },
    requestedAction: "copy_focus_manual_send",
    safety: {
      requiresUserConfirmation: true,
      manualSendRequired: true,
      allowAutoSend: false,
    },
  };
}

function safeFileSegment(value) {
  return `${value || "unknown"}`
    .trim()
    .replace(/[:*?"<>|#[\]]/g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function defaultPreviewPath(sourceNotePath, previewRoot) {
  const baseName = safeFileSegment(stripExtension(lastPathSegment(sourceNotePath || "note")));
  return `${previewRoot}/${baseName}-sync-back.md`;
}

function lastPathSegment(value) {
  return `${value || ""}`.split(/[\\/]/).filter(Boolean).pop() || "note.md";
}

function stripExtension(value) {
  return `${value || ""}`.replace(/\.[^.]+$/, "");
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = `${getKey(item) || "unknown"}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  BEGIN_PREFIX,
  END_MARKER,
  createAnnotationId,
  createAnnotationBlock,
  extractAnnotations,
  buildSummary,
  buildSyncBackRequest,
  safeFileSegment,
  defaultPreviewPath,
};
