import { Notice, setIcon } from "obsidian";
import {
  AMO_CANVAS_MANAGER,
  AMO_CANVAS_OPEN_NOTE_ACTION_CLASS,
  AMO_CANVAS_TYPE,
} from "../core/constants";
import { normalizeMarkdownTitle, parseAmoMetadata } from "../core/metadata";
import { normalizeVaultFilePath } from "../core/paths";
import { messageFromError } from "../core/ui-utils";
import { canvasNodeFilePath, collectCanvasNodes, collectCanvasSelectedNodes } from "./target";
import { canvasNodeElement, markCanvasLatestNote } from "./navigation";

export async function isAmoManagedCanvasView(plugin, view) {
  const file = view && view.file;
  if (!file) return false;

  try {
    const raw = await plugin.app.vault.read(file);
    const parsed = JSON.parse(raw);
    const amo = parsed && typeof parsed === "object" ? parsed.amo : null;
    const managedCanvas = Boolean(amo) && amo.managedBy === AMO_CANVAS_MANAGER && amo.canvasType === AMO_CANVAS_TYPE;
    if (view.containerEl) {
      view.containerEl.classList.toggle("amo-managed-canvas", managedCanvas);
    }
    plugin.debugLog("canvas.amo_marker.checked", {
      canvasPath: file.path,
      managedCanvas,
    });
    return managedCanvas;
  } catch (error) {
    if (view.containerEl) {
      view.containerEl.classList.remove("amo-managed-canvas");
    }
    plugin.debugLog("canvas.amo_marker.error", {
      canvasPath: file.path,
      message: messageFromError(error),
    });
    return false;
  }
}

export async function syncAmoCanvasRendering(plugin) {
  for (const leaf of plugin.app.workspace.getLeavesOfType("canvas")) {
    const view: any = leaf.view;
    if (!view) continue;
    const managedCanvas = await isAmoManagedCanvasView(plugin, view);
    if (!managedCanvas) {
      clearAmoCanvasRendering(plugin, view);
      continue;
    }
    await syncAmoCanvasNodeLabels(plugin, view);
    syncCanvasOpenNoteToolbarButtons(plugin, view);
  }
}

export function clearAmoCanvasRendering(plugin, view) {
  if (!view || !view.containerEl) return;
  view.containerEl.classList.remove("amo-managed-canvas");
  clearAmoCanvasNodeLabels(plugin, view);
  clearCanvasOpenNoteToolbarButtons(view);
}

export async function syncAmoCanvasNodeLabels(plugin, view) {
  if (!view || !view.containerEl || !view.canvas) return;

  const titleByPath = new Map();
  for (const node of collectCanvasNodes(view.canvas)) {
    const nodeFilePath = normalizeVaultFilePath(canvasNodeFilePath(view.canvas, node));
    if (!nodeFilePath || !nodeFilePath.toLowerCase().endsWith(".md")) continue;

    const nodeElement = canvasNodeElement(view, node);
    const labelElement = canvasNodeLabelElement(nodeElement);
    if (!labelElement) continue;

    let displayTitle = titleByPath.get(nodeFilePath);
    if (displayTitle === undefined) {
      displayTitle = await amoDisplayTitleForPath(plugin, nodeFilePath);
      titleByPath.set(nodeFilePath, displayTitle);
    }

    applyCanvasNodeDisplayTitle(labelElement, displayTitle);
  }
}

export async function amoDisplayTitleForPath(plugin, filePath) {
  const normalizedPath = normalizeVaultFilePath(filePath);
  const file = plugin.app.vault.getAbstractFileByPath(normalizedPath);
  if (!file) return "";

  try {
    const markdown = await plugin.app.vault.cachedRead(file as any);
    const amo = parseAmoMetadata(markdown);
    return normalizeMarkdownTitle(amo.displayTitle);
  } catch (error) {
    plugin.debugLog("canvas.label.read_error", {
      notePath: normalizedPath,
      message: messageFromError(error),
    });
    return "";
  }
}

export function canvasNodeLabelElement(nodeElement) {
  if (!(nodeElement instanceof HTMLElement)) return null;

  for (const selector of [
    ":scope > .canvas-node-label",
    ".canvas-node-label",
    ".canvas-node-title",
    "[data-amo-canvas-node-label]",
  ]) {
    const candidate = nodeElement.querySelector(selector);
    if (candidate instanceof HTMLElement) return candidate;
  }

  return null;
}

export function applyCanvasNodeDisplayTitle(labelElement, displayTitle) {
  if (!(labelElement instanceof HTMLElement)) return;
  if (!labelElement.dataset.amoOriginalLabel) {
    labelElement.dataset.amoOriginalLabel = labelElement.textContent || "";
  }

  const normalizedTitle = normalizeMarkdownTitle(displayTitle);
  if (normalizedTitle) {
    labelElement.textContent = normalizedTitle;
    labelElement.title = normalizedTitle;
    labelElement.classList.add("amo-canvas-display-title-label");
    return;
  }

  restoreCanvasNodeLabel(labelElement);
}

export function clearAmoCanvasNodeLabels(plugin, view) {
  if (!view || !view.containerEl) return;
  for (const labelElement of Array.from(view.containerEl.querySelectorAll("[data-amo-original-label]"))) {
    restoreCanvasNodeLabel(labelElement);
  }
}

export function restoreCanvasNodeLabel(labelElement) {
  if (!(labelElement instanceof HTMLElement)) return;
  const originalLabel = labelElement.dataset.amoOriginalLabel || "";
  if (originalLabel) {
    labelElement.textContent = originalLabel;
  }
  labelElement.removeAttribute("title");
  labelElement.classList.remove("amo-canvas-display-title-label");
  delete labelElement.dataset.amoOriginalLabel;
}

export function syncCanvasOpenNoteToolbarButtons(plugin, view) {
  if (!view || !view.containerEl || !view.canvas) return;

  const notePath = selectedCanvasMarkdownNotePath(plugin, view);
  const toolbars = canvasNodeToolbarElements(view);
  if (!notePath || toolbars.length === 0) {
    clearCanvasOpenNoteToolbarButtons(view);
    return;
  }

  for (const toolbar of toolbars) {
    let button = toolbar.querySelector("." + AMO_CANVAS_OPEN_NOTE_ACTION_CLASS) as HTMLButtonElement | null;
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "clickable-icon " + AMO_CANVAS_OPEN_NOTE_ACTION_CLASS;
      button.setAttribute("aria-label", "Open note");
      button.setAttribute("title", "Open note");
      setIcon(button, "file-text");
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const targetPath = button?.dataset.amoNotePath || "";
        void openCanvasToolbarNote(plugin, view, targetPath);
      });
      toolbar.appendChild(button);
    }

    button.dataset.amoNotePath = notePath;
    button.disabled = false;
  }
}

export function clearCanvasOpenNoteToolbarButtons(view) {
  if (!view || !view.containerEl) return;
  for (const button of Array.from(view.containerEl.querySelectorAll("." + AMO_CANVAS_OPEN_NOTE_ACTION_CLASS))) {
    if (button instanceof HTMLElement) button.remove();
  }
}

export function canvasNodeToolbarElements(view) {
  if (!view || !view.containerEl) return [];
  return Array.from(
    view.containerEl.querySelectorAll(
      ".canvas-node-menu, .canvas-node-toolbar, .canvas-node-controls, .canvas-node-actions"
    )
  ).filter((element) => element instanceof HTMLElement) as HTMLElement[];
}

export function selectedCanvasMarkdownNotePath(plugin, view) {
  if (!view || !view.canvas) return "";
  for (const node of collectCanvasSelectedNodes(view.canvas)) {
    const notePath = normalizeVaultFilePath(canvasNodeFilePath(view.canvas, node));
    if (notePath && notePath.toLowerCase().endsWith(".md")) {
      const file = plugin.app.vault.getAbstractFileByPath(notePath);
      if (file && typeof file.path === "string") return file.path;
    }
  }
  return "";
}

export async function openCanvasToolbarNote(plugin, view, notePath) {
  const normalizedPath = normalizeVaultFilePath(notePath);
  if (!normalizedPath) return;

  const file = plugin.app.vault.getAbstractFileByPath(normalizedPath);
  if (!file || typeof file.path !== "string") {
    new Notice("AMO target not found: " + normalizedPath);
    return;
  }

  plugin.rememberCanvasMarkdownFile(view, file.path);
  plugin.debugLog("canvas.toolbar.open_note.clicked", {
    canvasPath: view && view.file && view.file.path,
    notePath: file.path,
  });
  await plugin.openVaultPath(file.path, "note");
}

export function findCanvasNodeForFilePath(view, notePath) {
  const normalizedNotePath = normalizeVaultFilePath(notePath);
  return (
    collectCanvasNodes(view && view.canvas).find((node) => {
      return normalizeVaultFilePath(canvasNodeFilePath(view.canvas, node)) === normalizedNotePath;
    }) || null
  );
}

export function findCanvasNodeForId(view, nodeId) {
  const targetId = String(nodeId || "");
  if (!targetId) return null;
  return (
    collectCanvasNodes(view && view.canvas).find((node) => {
      return String((node && node.id) || (node && node.data && node.data.id) || "") === targetId;
    }) || null
  );
}

export function selectCanvasNode(plugin, view, node, notePath) {
  const canvas = view && view.canvas;
  const marked = markCanvasLatestNote(view, node);

  plugin.safeCanvasCall(canvas, "requestFrame");
  plugin.debugLog("canvas.focus_note.selected", {
    canvasPath: view && view.file && view.file.path,
    notePath,
    nodeId: node && (node.id || (node.data && node.data.id)),
    marked,
  });
}
