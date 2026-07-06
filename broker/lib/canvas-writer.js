const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AMO_CANVAS_MANAGER,
  AMO_CANVAS_PATH,
  AMO_CANVAS_TYPE,
  AMO_LAYOUT_VERSION,
  AMO_SCHEMA_VERSION,
  CANVAS_NODE_MARGIN_X,
  CANVAS_NODE_MARGIN_Y,
  OBSIDIAN_PLUGIN_ID,
  REPLY_NODE_GAP_X,
  REPLY_NODE_GAP_Y,
  REPLY_NODE_HEIGHT,
  REPLY_NODE_WIDTH,
} = require("./amo-constants");
const { readJsonFile, readJsonFileStrict, writeJsonFile } = require("./filesystem");
const { normalizeText } = require("./normalize");
const { normalizeCanvasAppendDirection } = require("./obsidian-vault");

function ensureCanvas(canvasPath, metadata = {}) {
  const existingCanvas = fs.existsSync(canvasPath) ? readJsonFile(canvasPath, null) : null;
  const canvas =
    existingCanvas && typeof existingCanvas === "object" && !Array.isArray(existingCanvas)
      ? existingCanvas
      : { nodes: [], edges: [] };

  if (!Array.isArray(canvas.nodes)) canvas.nodes = [];
  if (!Array.isArray(canvas.edges)) canvas.edges = [];
  if (metadata.reset) {
    canvas.nodes = [];
    canvas.edges = [];
  }
  applyAmoCanvasMetadata(canvas, metadata);
  normalizeCanvasEdges(canvas);
  writeJsonFile(canvasPath, canvas);
}

function applyAmoCanvasMetadata(canvas, metadata = {}) {
  const existingAmo = canvas.amo && typeof canvas.amo === "object" && !Array.isArray(canvas.amo) ? canvas.amo : {};
  const existingDisplay =
    existingAmo.display && typeof existingAmo.display === "object" && !Array.isArray(existingAmo.display)
      ? existingAmo.display
      : {};
  const now = new Date().toISOString();

  canvas.amo = {
    ...existingAmo,
    schemaVersion: AMO_SCHEMA_VERSION,
    layoutVersion: AMO_LAYOUT_VERSION,
    canvasType: AMO_CANVAS_TYPE,
    canvasRole: "base-flow",
    managedBy: AMO_CANVAS_MANAGER,
    workspaceId: normalizeText(metadata.workspaceId || existingAmo.workspaceId),
    workspacePath: normalizeText(metadata.workspacePath || existingAmo.workspacePath),
    projectName: normalizeText(metadata.projectName || existingAmo.projectName),
    createdAt: normalizeText(existingAmo.createdAt || metadata.createdAt || now),
    updatedAt: normalizeText(metadata.updatedAt || now),
    display: {
      ...existingDisplay,
      labelMode: "short",
      hidePropertiesByDefault:
        typeof existingDisplay.hidePropertiesByDefault === "boolean" ? existingDisplay.hidePropertiesByDefault : true,
    },
  };
}

function normalizeCanvasEdges(canvas) {
  if (!canvas || !Array.isArray(canvas.edges)) return;

  for (const edge of canvas.edges) {
    if (!edge || typeof edge !== "object") continue;
    if (!edge.fromEnd) edge.fromEnd = "none";
    if (!edge.toEnd) edge.toEnd = "arrow";
  }
}

function updateCanvasNoteDisplayTitle(vaultRoot, { noteId, notePath, displayTitle, updatedAt }) {
  const canvasPath = path.join(vaultRoot, AMO_CANVAS_PATH);
  if (!fs.existsSync(canvasPath)) return false;

  const canvas = readJsonFile(canvasPath, null);
  if (!canvas || !Array.isArray(canvas.nodes)) return false;

  let changed = false;
  for (const node of canvas.nodes) {
    if (!node || node.type !== "file") continue;
    const nodeFile = normalizeText(node.file);
    const nodeNoteId = normalizeText(node.amo && node.amo.noteId);
    if (nodeFile !== notePath && (!noteId || nodeNoteId !== noteId)) continue;
    if (!node.amo || typeof node.amo !== "object" || Array.isArray(node.amo)) node.amo = {};
    node.amo.noteId = noteId || node.amo.noteId || null;
    if (displayTitle) {
      node.amo.displayTitle = displayTitle;
    } else {
      delete node.amo.displayTitle;
    }
    node.amo.updatedAt = updatedAt;
    changed = true;
  }

  if (changed) writeJsonFile(canvasPath, canvas);
  return changed;
}

function appendConversationNoteToCanvas(amoRoot, vaultRoot, record, note) {
  const canvasPath = AMO_CANVAS_PATH;
  const canvasAbsolutePath = path.join(vaultRoot, canvasPath);
  const bindingsPath = path.join(amoRoot, "state", "bindings.json");
  const appendDirection = readCanvasAppendDirection(vaultRoot);
  const canvas = fs.existsSync(canvasAbsolutePath)
    ? readJsonFileStrict(canvasAbsolutePath)
    : { nodes: [], edges: [] };
  if (!Array.isArray(canvas.nodes)) canvas.nodes = [];
  if (!Array.isArray(canvas.edges)) canvas.edges = [];
  applyAmoCanvasMetadata(canvas, {
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath || record.cwd,
    updatedAt: record.capturedAt,
  });
  normalizeCanvasEdges(canvas);

  const bindings = readJsonFile(bindingsPath, { schemaVersion: AMO_SCHEMA_VERSION, sessions: {} });
  if (!bindings.sessions || typeof bindings.sessions !== "object" || Array.isArray(bindings.sessions)) {
    bindings.sessions = {};
  }

  const existingBinding = bindings.sessions[record.sessionId] || {};
  const sessionNodes = canvas.nodes.filter((node) => {
    return node && node.amo && normalizeText(node.amo.sessionId) === record.sessionId;
  });
  const canvasSessionIds = new Set(
    canvas.nodes
      .map((node) => normalizeText(node && node.amo && node.amo.sessionId))
      .filter(Boolean)
  );
  const sessionIndex =
    Number.isSafeInteger(existingBinding.sessionIndex) && sessionNodes.length > 0
      ? existingBinding.sessionIndex
      : canvasSessionIds.size;
  let canvasNodeId = `amo-${crypto
    .createHash("sha1")
    .update(`${record.sessionId}:${record.turnId}:${record.capturedAt}`)
    .digest("hex")
    .slice(0, 12)}`;
  let suffix = 1;
  while (canvas.nodes.some((node) => node.id === canvasNodeId)) {
    suffix += 1;
    canvasNodeId = `${canvasNodeId}-${suffix}`;
  }

  const boundPreviousNode = existingBinding.lastCanvasNodeId
    ? canvas.nodes.find((node) => {
        return (
          node &&
          node.id === existingBinding.lastCanvasNodeId &&
          node.amo &&
          normalizeText(node.amo.sessionId) === record.sessionId
        );
      })
    : null;
  const previousNode = boundPreviousNode || sessionNodes[sessionNodes.length - 1] || null;
  const nodeCount = previousNode
    ? boundPreviousNode && Number.isSafeInteger(existingBinding.nodeCount)
      ? existingBinding.nodeCount
      : sessionNodes.length
    : sessionNodes.length;
  const nodePosition = nextConversationCanvasNodePosition({
    previousNode,
    direction: appendDirection,
    nodeCount,
    sessionIndex,
  });

  canvas.nodes.push({
    id: canvasNodeId,
    type: "file",
    file: note.notePath,
    x: nodePosition.x,
    y: nodePosition.y,
    width: REPLY_NODE_WIDTH,
    height: REPLY_NODE_HEIGHT,
    amo: {
      schemaVersion: AMO_SCHEMA_VERSION,
      noteId: note.noteId || null,
      kind: note.kind || (record.source === "obsidian-annotations" ? "prompt" : "reply"),
      role: note.role || null,
      sequence: Number.isSafeInteger(note.sequence) ? note.sequence : null,
      displayName: note.displayName || null,
      displayTitle: note.displayTitle || null,
      workspaceId: record.workspaceId,
      tool: record.tool,
      sessionId: record.sessionId,
      turnId: record.turnId,
      source: record.source,
      capturedAt: record.capturedAt,
    },
  });

  if (previousNode) {
    const edgeSides = canvasEdgeSidesForDirection(appendDirection);
    canvas.edges.push({
      id: `edge-${previousNode.id}-${canvasNodeId}`,
      fromNode: previousNode.id,
      fromSide: edgeSides.fromSide,
      fromEnd: "none",
      toNode: canvasNodeId,
      toSide: edgeSides.toSide,
      toEnd: "arrow",
    });
  }

  bindings.sessions[record.sessionId] = {
    sessionId: record.sessionId,
    workCanvasId: "base",
    canvasRole: "base-flow",
    canvasPath,
    lastCanvasNodeId: canvasNodeId,
    nodeCount: nodeCount + 1,
    sessionIndex,
    canvasAppendDirection: appendDirection,
    updatedAt: record.capturedAt,
  };

  writeJsonFile(canvasAbsolutePath, canvas);
  writeJsonFile(bindingsPath, bindings);

  return { canvasPath, canvasAbsolutePath, canvasNodeId };
}

function readCanvasAppendDirection(vaultRoot) {
  const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", OBSIDIAN_PLUGIN_ID, "data.json");
  const pluginData = readJsonFile(pluginDataPath, {});
  return normalizeCanvasAppendDirection(pluginData?.canvasAppendDirection);
}

function nextConversationCanvasNodePosition({ previousNode, direction, nodeCount, sessionIndex }) {
  const fallback = initialConversationCanvasNodePosition(direction, nodeCount, sessionIndex);
  if (!previousNode) {
    return fallback;
  }

  const x = finiteCanvasNumber(previousNode.x, fallback.x);
  const y = finiteCanvasNumber(previousNode.y, fallback.y);
  const width = finiteCanvasNumber(previousNode.width, REPLY_NODE_WIDTH);
  const height = finiteCanvasNumber(previousNode.height, REPLY_NODE_HEIGHT);

  if (direction === "right") {
    return {
      x: x + width + CANVAS_NODE_MARGIN_X,
      y,
    };
  }

  return {
    x,
    y: y + height + CANVAS_NODE_MARGIN_Y,
  };
}

function initialConversationCanvasNodePosition(direction, nodeCount, sessionIndex) {
  if (direction === "right") {
    return {
      x: nodeCount * REPLY_NODE_GAP_X,
      y: sessionIndex * REPLY_NODE_GAP_Y,
    };
  }

  return {
    x: sessionIndex * REPLY_NODE_GAP_X,
    y: nodeCount * REPLY_NODE_GAP_Y,
  };
}

function canvasEdgeSidesForDirection(direction) {
  if (direction === "right") {
    return { fromSide: "right", toSide: "left" };
  }

  return { fromSide: "bottom", toSide: "top" };
}

function finiteCanvasNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

module.exports = {
  appendConversationNoteToCanvas,
  ensureCanvas,
  updateCanvasNoteDisplayTitle,
};
