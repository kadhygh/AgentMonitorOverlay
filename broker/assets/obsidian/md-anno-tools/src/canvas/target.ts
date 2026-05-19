import { normalizeAnnotationContent } from "../annotations/syntax";
import { normalizeVaultFilePath } from "../core/paths";

export function collectCanvasSelectedNodes(canvas) {
  if (!canvas) return [];

  const selectedItems = [];
  for (const source of [canvas.selectedNodes, canvas.selectedItems, canvas.selected]) {
    selectedItems.push(...selectedCollectionValues(source));
  }

  const selection = canvas.selection;
  selectedItems.push(...selectedCollectionValues(selection));
  if (selection && typeof selection === "object") {
    for (const key of ["selected", "selectedNodes", "selectedItems", "nodes", "items", "_selected"]) {
      selectedItems.push(...selectedCollectionValues(selection[key]));
    }
  }

  const allNodes = collectCanvasNodes(canvas);
  const nodes = [];
  const seen = new Set();

  for (const item of selectedItems) {
    const node = resolveCanvasSelectionItem(canvas, allNodes, item);
    if (!node || seen.has(node)) continue;
    seen.add(node);
    nodes.push(node);
  }

  if (nodes.length > 0) return nodes;

  for (const node of allNodes) {
    if (!node || seen.has(node)) continue;
    if (node.selected || node.isSelected || (node.data && node.data.selected)) {
      seen.add(node);
      nodes.push(node);
    }
  }

  return nodes;
}

export function selectedCollectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.values());
  if (typeof value.values === "function" && typeof value !== "string") {
    try {
      return Array.from(value.values());
    } catch {
      return [];
    }
  }
  return [];
}

export function collectCanvasNodes(canvas) {
  const nodes = [];
  for (const source of [canvas.nodes, canvas.nodeMap, canvas.nodesById]) {
    nodes.push(...collectionValues(source));
  }
  return nodes;
}

export function canvasFilePathFromEventTarget(canvas, target) {
  const element = target instanceof Element ? target : null;
  if (!element) return "";

  const nodeEl = (element.closest(".canvas-node") || element.closest("[data-node-id], [data-path], [data-file]")) as HTMLElement | null;
  if (!nodeEl) return "";

  const datasetPath = firstNonEmpty(
    nodeEl.dataset && nodeEl.dataset.path,
    nodeEl.dataset && nodeEl.dataset.file,
    datasetValueFromDescendant(nodeEl, "path"),
    datasetValueFromDescendant(nodeEl, "file")
  );
  if (datasetPath) return normalizeVaultFilePath(datasetPath);

  const nodeId = firstNonEmpty(
    nodeEl.dataset && nodeEl.dataset.nodeId,
    nodeEl.dataset && nodeEl.dataset.id,
    nodeEl.getAttribute("data-node-id"),
    nodeEl.id
  );
  if (nodeId) {
    const node = collectCanvasNodes(canvas).find((candidate) => {
      return candidate && (candidate.id === nodeId || (candidate.data && candidate.data.id === nodeId));
    });
    const filePath = node ? canvasNodeFilePath(canvas, node) : "";
    if (filePath) return filePath;
  }

  const visibleText = normalizeAnnotationContent(nodeEl.textContent || "");
  if (!visibleText) return "";

  const fileNodes = collectCanvasNodes(canvas)
    .map((node) => canvasNodeFilePath(canvas, node))
    .filter((filePath) => filePath && filePath.toLowerCase().endsWith(".md"));
  const exact = fileNodes.find((filePath) => visibleText.includes(filePath));
  if (exact) return exact;

  return (
    fileNodes.find((filePath) => {
      const basename = filePath.split("/").pop() || "";
      const stem = basename.replace(/\.md$/iu, "");
      return Boolean(stem && visibleText.includes(stem));
    }) || ""
  );
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function datasetValueFromDescendant(root, key) {
  const el = root.querySelector("[data-" + key + "]") as HTMLElement | null;
  return el && el.dataset ? el.dataset[key] : "";
}

export function collectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.values());
  if (typeof value.values === "function" && typeof value !== "string") {
    try {
      return Array.from(value.values());
    } catch {
      return [];
    }
  }
  if (typeof value === "object") return Object.values(value);
  return [];
}

export function resolveCanvasSelectionItem(canvas, allNodes, item) {
  if (!item) return null;
  if (typeof item === "string") {
    return allNodes.find((node) => node && (node.id === item || (node.data && node.data.id === item))) || null;
  }
  if (item.node) return item.node;
  if (item.item) return item.item;
  if (item.value) return item.value;
  if (item.id || item.file || item.filePath || item.path || item.data) return item;
  return null;
}

export function canvasNodeFilePath(canvas, node) {
  const data = safeCall(() => (typeof node.getData === "function" ? node.getData() : null));
  const file = safeCall(() => (typeof node.getFile === "function" ? node.getFile() : null));
  const candidates = [
    file,
    node.file,
    node.filePath,
    node.path,
    node.data && node.data.file,
    node.data && node.data.path,
    data && data.file,
    data && data.path,
  ];

  for (const candidate of candidates) {
    const filePath = normalizeCanvasFilePathCandidate(candidate);
    if (filePath) return filePath;
  }

  const nodeId = node.id || (node.data && node.data.id);
  if (!nodeId) return "";
  const match = collectCanvasNodes(canvas).find((candidate) => candidate && candidate.id === nodeId && candidate !== node);
  return match ? canvasNodeFilePath(canvas, match) : "";
}

export function normalizeCanvasFilePathCandidate(candidate) {
  if (!candidate) return "";
  if (typeof candidate === "string") return normalizeVaultFilePath(candidate);
  if (typeof candidate.path === "string") return normalizeVaultFilePath(candidate.path);
  if (typeof candidate.file === "string") return normalizeVaultFilePath(candidate.file);
  if (candidate.file && typeof candidate.file.path === "string") return normalizeVaultFilePath(candidate.file.path);
  return "";
}

export function safeCall(callback) {
  try {
    return callback();
  } catch {
    return null;
  }
}

export function canvasTargetDisplayName(filePath) {
  const name = String(filePath || "").split(/[\\/]/u).pop() || String(filePath || "");
  return name.replace(/\.md$/iu, "");
}
