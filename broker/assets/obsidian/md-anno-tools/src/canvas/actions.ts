import { Notice } from "obsidian";
import {
  AMO_CANVAS_PANEL_ACTION_CLASS,
  AMO_CANVAS_SEND_ACTION_CLASS,
  AMO_CANVAS_TITLE_ACTION_CLASS,
} from "../core/constants";
import { normalizeVaultFilePath } from "../core/paths";
import { describeElement } from "../core/ui-utils";
import { CanvasNoteTargetModal } from "../ui/modals";
import {
  canvasFilePathFromEventTarget,
  canvasNodeFilePath,
  collectCanvasNodes,
  collectCanvasSelectedNodes,
} from "./target";

export function syncCanvasViewActions(plugin) {
  for (const leaf of plugin.app.workspace.getLeavesOfType("canvas")) {
    const view: any = leaf.view;
    if (!view || !view.containerEl || typeof view.addAction !== "function") continue;
    ensureCanvasTargetTracking(plugin, view);
    plugin.syncCanvasOpenNoteToolbarButtons(view);

    if (!view.containerEl.querySelector("." + AMO_CANVAS_SEND_ACTION_CLASS)) {
      const sendAction = view.addAction("send", "Send selected note annotations to AMO", () => {
        void sendAnnotationsFromCanvas(plugin, view);
      });
      sendAction.addClass(AMO_CANVAS_SEND_ACTION_CLASS);
      plugin.debugLog("canvas.action.added", {
        action: "send",
        canvasPath: view.file && view.file.path,
      });
    }

    if (!view.containerEl.querySelector("." + AMO_CANVAS_PANEL_ACTION_CLASS)) {
      const panelAction = view.addAction("panel-right", "Open AMO panel", () => {
        void openPanelFromCanvas(plugin, view);
      });
      panelAction.addClass(AMO_CANVAS_PANEL_ACTION_CLASS);
      plugin.debugLog("canvas.action.added", {
        action: "panel",
        canvasPath: view.file && view.file.path,
      });
    }

    if (!view.containerEl.querySelector("." + AMO_CANVAS_TITLE_ACTION_CLASS)) {
      const titleAction = view.addAction("pencil", "Edit selected note title", () => {
        void editTitleFromCanvas(plugin, view);
      });
      titleAction.addClass(AMO_CANVAS_TITLE_ACTION_CLASS);
      plugin.debugLog("canvas.action.added", {
        action: "title",
        canvasPath: view.file && view.file.path,
      });
    }
  }
}

export async function editTitleFromCanvas(plugin, view) {
  const rememberedBefore = getRememberedCanvasMarkdownFileTarget(plugin, view);
  const selectedCount = collectCanvasSelectedNodes(view && view.canvas).length;
  const file = getCanvasMarkdownFileForAction(plugin, view);
  plugin.debugLog("canvas.title.clicked", {
    canvasPath: view && view.file && view.file.path,
    targetPath: file && file.path,
    rememberedPathBefore: rememberedBefore && rememberedBefore.file && rememberedBefore.file.path,
    selectedCount,
  });
  if (file) {
    await plugin.editAmoNoteTitle(file);
    return;
  }

  await chooseCanvasMarkdownFile(plugin, view, "Edit title", async (selectedFile) => {
    rememberCanvasMarkdownFile(plugin, view, selectedFile.path);
    await plugin.editAmoNoteTitle(selectedFile);
  });
}

export async function sendAnnotationsFromCanvas(plugin, view) {
  const rememberedBefore = getRememberedCanvasMarkdownFileTarget(plugin, view);
  const selectedCount = collectCanvasSelectedNodes(view && view.canvas).length;
  const file = getCanvasMarkdownFileForAction(plugin, view);
  plugin.debugLog("canvas.send.clicked", {
    canvasPath: view && view.file && view.file.path,
    targetPath: file && file.path,
    targetSource: file ? plugin.lastMarkdownTargetSource : null,
    rememberedPathBefore: rememberedBefore && rememberedBefore.file && rememberedBefore.file.path,
    selectedCount,
  });
  if (file) {
    await plugin.sendAnnotationsFromFile(file);
    return;
  }

  plugin.debugLog("canvas.send.choose_target", {
    canvasPath: view && view.file && view.file.path,
  });
  await chooseCanvasMarkdownFile(plugin, view, "Send", async (selectedFile) => {
    await plugin.sendAnnotationsFromFile(selectedFile);
  });
}

export async function openPanelFromCanvas(plugin, view) {
  const rememberedBefore = getRememberedCanvasMarkdownFileTarget(plugin, view);
  const selectedCount = collectCanvasSelectedNodes(view && view.canvas).length;
  const file = getCanvasMarkdownFileForAction(plugin, view);
  plugin.debugLog("canvas.panel.clicked", {
    canvasPath: view && view.file && view.file.path,
    targetPath: file && file.path,
    targetSource: file ? plugin.lastMarkdownTargetSource : null,
    rememberedPathBefore: rememberedBefore && rememberedBefore.file && rememberedBefore.file.path,
    selectedCount,
  });
  if (file) {
    rememberCanvasMarkdownFile(plugin, view, file.path);
    await plugin.activatePanel();
    return;
  }

  await chooseCanvasMarkdownFile(plugin, view, "Use", async (selectedFile) => {
    rememberCanvasMarkdownFile(plugin, view, selectedFile.path);
    await plugin.activatePanel();
  });
}

export function ensureCanvasTargetTracking(plugin, view) {
  if (plugin.canvasViewsWithTargetTracking.has(view)) return;
  plugin.canvasViewsWithTargetTracking.add(view);

  plugin.registerDomEvent(view.containerEl, "pointerdown", (event) => {
    rememberCanvasTargetFromEvent(plugin, view, event);
    scheduleCanvasToolbarSync(plugin, view);
  });
}

export function scheduleCanvasToolbarSync(plugin, view) {
  window.setTimeout(() => plugin.syncCanvasOpenNoteToolbarButtons(view), 0);
  window.setTimeout(() => plugin.syncCanvasOpenNoteToolbarButtons(view), 120);
}

export function rememberCanvasTargetFromEvent(plugin, view, event) {
  const target = event && event.target;
  const element = target instanceof Element ? target : null;
  if (element && element.closest(".view-action, .clickable-icon, button")) {
    plugin.debugLog("canvas.pointer.ignored_action", {
      canvasPath: view && view.file && view.file.path,
      target: describeElement(element),
    });
    return;
  }

  plugin.canvasTargetFilePathByView.delete(view);

  const filePath = canvasFilePathFromEventTarget(view.canvas, target);
  if (filePath && filePath.toLowerCase().endsWith(".md")) {
    const file = plugin.app.vault.getAbstractFileByPath(normalizeVaultFilePath(filePath));
    if (file && typeof file.path === "string") {
      rememberCanvasMarkdownFile(plugin, view, file.path);
      plugin.debugLog("canvas.pointer.remembered", {
        canvasPath: view && view.file && view.file.path,
        notePath: file.path,
        target: element ? describeElement(element) : null,
      });
    }
    return;
  }

  plugin.debugLog("canvas.pointer.cleared", {
    canvasPath: view && view.file && view.file.path,
    target: element ? describeElement(element) : null,
  });
}

export function getSelectedCanvasMarkdownFile(plugin, view) {
  const target = getSelectedCanvasMarkdownFileTarget(plugin, view);
  return target ? target.file : null;
}

export function getCanvasMarkdownFileForAction(plugin, view) {
  const target =
    getSelectedCanvasMarkdownFileTarget(plugin, view, { allowRemembered: false }) ||
    getRememberedCanvasMarkdownFileTarget(plugin, view);
  return target ? target.file : null;
}

export function getSelectedCanvasMarkdownFileTarget(plugin, view = null, options = null) {
  const canvasView = view || getActiveCanvasView(plugin);
  if (!canvasView) return null;

  const allowRemembered = !options || options.allowRemembered !== false;
  if (allowRemembered) {
    const rememberedCanvasTarget = getRememberedCanvasMarkdownFileTarget(plugin, canvasView);
    if (rememberedCanvasTarget) return rememberedCanvasTarget;
  }

  const selectedNodes = collectCanvasSelectedNodes(canvasView.canvas);
  for (const node of selectedNodes) {
    const filePath = canvasNodeFilePath(canvasView.canvas, node);
    if (!filePath || !filePath.toLowerCase().endsWith(".md")) continue;
    const file = plugin.app.vault.getAbstractFileByPath(normalizeVaultFilePath(filePath));
    if (file && typeof file.path === "string") {
      const changed = rememberCanvasMarkdownFile(plugin, canvasView, file.path, {
        refreshPanels: options ? options.refreshPanels : undefined,
      });
      if (changed) {
        plugin.debugLog("canvas.selection.remembered", {
          canvasPath: canvasView.file && canvasView.file.path,
          notePath: file.path,
          selectedCount: selectedNodes.length,
        });
      }
      return {
        file,
        source: "canvas-selection",
      };
    }
  }

  return null;
}

export function rememberCanvasMarkdownFile(plugin, view, filePath, options = null) {
  const previousPath = plugin.canvasTargetFilePathByView.get(view);
  const changed =
    previousPath !== filePath ||
    plugin.lastMarkdownFilePath !== filePath ||
    plugin.lastMarkdownTargetSource !== "canvas-selection";

  plugin.lastCanvasView = view;
  plugin.canvasTargetFilePathByView.set(view, filePath);
  plugin.lastMarkdownView = null;
  plugin.lastMarkdownLeaf = null;
  plugin.lastMarkdownFilePath = filePath;
  plugin.lastMarkdownTargetSource = "canvas-selection";
  if (changed && (!options || options.refreshPanels !== false)) {
    plugin.schedulePanelRefresh("canvas-target-changed");
  }
  return changed;
}

export function getRememberedCanvasMarkdownFileTarget(plugin, view) {
  const filePath = plugin.canvasTargetFilePathByView.get(view);
  if (!filePath) return null;
  const file = plugin.app.vault.getAbstractFileByPath(filePath);
  if (!file || typeof file.path !== "string") return null;
  return {
    file,
    source: "canvas-selection",
  };
}

export function rememberSelectedCanvasMarkdownFile(plugin, view) {
  return getSelectedCanvasMarkdownFileTarget(plugin, view);
}

export async function chooseCanvasMarkdownFile(plugin, view, actionLabel, onSelect) {
  const targets = await listCanvasMarkdownFileTargets(plugin, view);
  plugin.debugLog("canvas.target_modal.open", {
    actionLabel,
    canvasPath: view && view.file && view.file.path,
    targetCount: targets.length,
    targets: targets.slice(0, 12).map((target) => target.file.path),
  });
  if (targets.length === 0) {
    new Notice("No Markdown note nodes found on this canvas.");
    return;
  }

  new CanvasNoteTargetModal(plugin.app, targets, actionLabel, async (target) => {
    rememberCanvasMarkdownFile(plugin, view, target.file.path);
    plugin.debugLog("canvas.target_modal.selected", {
      actionLabel,
      canvasPath: view && view.file && view.file.path,
      notePath: target.file.path,
    });
    await onSelect(target.file);
  }).open();
}

export async function listCanvasMarkdownFileTargets(plugin, view) {
  const targets = [];
  const seen = new Set();

  for (const node of collectCanvasNodes(view && view.canvas)) {
    const filePath = canvasNodeFilePath(view.canvas, node);
    addCanvasFileTarget(plugin, targets, seen, filePath, node.x || (node.data && node.data.x), node.y || (node.data && node.data.y));
  }

  if (view && view.file) {
    try {
      const raw = await plugin.app.vault.cachedRead(view.file as any);
      const canvas = JSON.parse(raw);
      for (const node of Array.isArray(canvas.nodes) ? canvas.nodes : []) {
        addCanvasFileTarget(plugin, targets, seen, node.file, node.x, node.y);
      }
    } catch {
      // Ignore malformed or unavailable canvas file data; live canvas nodes above may still be enough.
    }
  }

  const sorted = targets.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
  plugin.debugLog("canvas.targets.listed", {
    canvasPath: view && view.file && view.file.path,
    count: sorted.length,
    targets: sorted.slice(0, 12).map((target) => target.file.path),
  });
  return sorted;
}

export function addCanvasFileTarget(plugin, targets, seen, filePath, x, y) {
  const normalizedPath = normalizeVaultFilePath(filePath);
  if (!normalizedPath || !normalizedPath.toLowerCase().endsWith(".md") || seen.has(normalizedPath)) return;

  const file = plugin.app.vault.getAbstractFileByPath(normalizedPath);
  if (!file || typeof file.path !== "string") return;

  seen.add(normalizedPath);
  targets.push({
    file,
    x: Number.isFinite(Number(x)) ? Number(x) : 0,
    y: Number.isFinite(Number(y)) ? Number(y) : 0,
  });
}

export function getActiveCanvasView(plugin) {
  const leaf = plugin.app.workspace.activeLeaf;
  if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return null;
  return leaf.view.getViewType() === "canvas" ? leaf.view : null;
}

export function isActiveLeafCanvas(plugin) {
  return Boolean(getActiveCanvasView(plugin));
}
