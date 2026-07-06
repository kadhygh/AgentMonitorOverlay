import { collectCanvasNodes } from "./target";

export type SafeCanvasCall = (target: any, method: string, ...args: any[]) => boolean;

export function markCanvasLatestNote(view, node) {
  clearCanvasLatestNoteMarkers(view);
  const element = canvasNodeElement(view, node);
  if (!element) return false;
  element.classList.add("amo-canvas-latest-note");
  element.setAttribute("data-amo-latest-note", "true");
  return true;
}

export function clearCanvasLatestNoteMarkers(view) {
  if (!view || !view.containerEl) return;
  const markedElements = Array.from(view.containerEl.querySelectorAll(".amo-canvas-latest-note")) as HTMLElement[];
  for (const element of markedElements) {
    element.classList.remove("amo-canvas-latest-note");
    element.removeAttribute("data-amo-latest-note");
  }
}

export function clearCanvasSelectionArtifact(view, node, safeCanvasCall: SafeCanvasCall) {
  const canvas = view && view.canvas;
  const nodeId = node && (node.id || (node.data && node.data.id));
  let cleaned = false;

  if (node) {
    if (node.selected || node.isSelected) cleaned = true;
    node.selected = false;
    node.isSelected = false;
  }

  for (const collection of [canvas && canvas.selection, canvas && canvas.selectedNodes, canvas && canvas.selectedItems, canvas && canvas.selected]) {
    if (removeCanvasSelectionValue(collection, node, nodeId, safeCanvasCall)) {
      cleaned = true;
    }
  }

  const element = canvasNodeElement(view, node);
  if (element) {
    for (const className of ["is-selected", "mod-selected", "selected"]) {
      if (element.classList.contains(className)) cleaned = true;
      element.classList.remove(className);
    }
  }

  return cleaned;
}

export function clearCanvasSelection(canvas, safeCanvasCall: SafeCanvasCall) {
  safeCanvasCall(canvas, "deselectAll");
  safeCanvasCall(canvas, "clearSelection");
  for (const collection of [canvas && canvas.selection, canvas && canvas.selectedNodes, canvas && canvas.selectedItems, canvas && canvas.selected]) {
    if (collection && typeof collection.clear === "function") {
      safeCanvasCall(collection, "clear");
    }
  }

  for (const node of collectCanvasNodes(canvas)) {
    if (!node) continue;
    node.selected = false;
    node.isSelected = false;
  }
}

export function removeCanvasSelectionValue(collection, node, nodeId, safeCanvasCall: SafeCanvasCall) {
  if (!collection) return false;
  let removed = false;

  if (Array.isArray(collection)) {
    for (const value of [node, nodeId]) {
      const index = value ? collection.indexOf(value) : -1;
      if (index >= 0) {
        collection.splice(index, 1);
        removed = true;
      }
    }
  }

  if (typeof collection.delete === "function") {
    if (node && collection.delete(node)) removed = true;
    if (nodeId && collection.delete(nodeId)) removed = true;
  }

  if (typeof collection.has === "function" && typeof collection.remove === "function") {
    if (node && collection.has(node)) {
      safeCanvasCall(collection, "remove", node);
      removed = true;
    }
    if (nodeId && collection.has(nodeId)) {
      safeCanvasCall(collection, "remove", nodeId);
      removed = true;
    }
  }

  return removed;
}

export function addCanvasSelectionValue(collection, node, safeCanvasCall: SafeCanvasCall) {
  if (!collection || !node) return;
  if (typeof collection.add === "function") {
    safeCanvasCall(collection, "add", node);
    return;
  }
  if (typeof collection.set === "function") {
    const nodeId = node.id || (node.data && node.data.id);
    safeCanvasCall(collection, "set", nodeId || node, node);
  }
}

export function centerCanvasNode(view, node, safeCanvasCall: SafeCanvasCall) {
  const canvas = view && view.canvas;
  const bounds = canvasNodeBounds(node);
  if (!bounds) return false;

  const bbox = {
    minX: bounds.x,
    minY: bounds.y,
    maxX: bounds.x + bounds.width,
    maxY: bounds.y + bounds.height,
  };

  if (safeCanvasCall(canvas, "zoomToBbox", bbox)) return true;
  if (safeCanvasCall(canvas, "zoomToBBox", bbox)) return true;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  if (safeCanvasCall(canvas, "panTo", centerX, centerY)) return true;
  if (safeCanvasCall(canvas, "setViewport", centerX, centerY, canvasZoom(canvas))) return true;

  const element = canvasNodeElement(view, node);
  if (element && typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    return true;
  }

  return false;
}

export function canvasNodeBounds(node) {
  const data = node && typeof node.getData === "function" ? node.getData() : node && node.data;
  const x = numberValue(node && node.x, data && data.x);
  const y = numberValue(node && node.y, data && data.y);
  const width = numberValue(node && node.width, node && node.w, data && data.width, data && data.w, 520);
  const height = numberValue(node && node.height, node && node.h, data && data.height, data && data.h, 360);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, width, height };
}

export function numberValue(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

export function canvasZoom(canvas) {
  return numberValue(canvas && canvas.zoom, canvas && canvas.scale, canvas && canvas.tZoom, 1) || 1;
}

export function canvasNodeElement(view, node) {
  for (const candidate of [node && node.nodeEl, node && node.el, node && node.containerEl, node && node.contentEl]) {
    if (candidate instanceof HTMLElement) return candidate;
  }

  const nodeId = node && (node.id || (node.data && node.data.id));
  if (!nodeId || !view || !view.containerEl) return null;
  const escaped = String(nodeId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    view.containerEl.querySelector('[data-node-id="' + escaped + '"]') ||
    view.containerEl.querySelector('[data-id="' + escaped + '"]') ||
    view.containerEl.querySelector("#" + String(nodeId).replace(/[^a-zA-Z0-9_-]/g, "\\$&"))
  );
}
