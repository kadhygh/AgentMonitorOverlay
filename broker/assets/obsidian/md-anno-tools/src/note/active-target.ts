import { MarkdownView } from "obsidian";
import { AMO_PANEL_VIEW_TYPE } from "../core/constants";

export function rememberCurrentMarkdownView(plugin) {
  rememberMarkdownLeaf(plugin, plugin.app.workspace.activeLeaf);

  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (view) {
    rememberMarkdownView(plugin, view, findLeafForView(plugin, view));
  }
}

export function rememberMarkdownLeaf(plugin, leaf) {
  if (!leaf || !(leaf.view instanceof MarkdownView)) return;
  rememberMarkdownView(plugin, leaf.view, leaf);
}

export function rememberMarkdownView(plugin, view, leaf = null) {
  if (!view || !(view instanceof MarkdownView) || !view.file) return;
  plugin.lastMarkdownView = view;
  plugin.lastMarkdownLeaf = leaf || findLeafForView(plugin, view);
  plugin.lastMarkdownFilePath = view.file.path;
  plugin.lastMarkdownTargetSource = "last-note";
}

export function findLeafForView(plugin, view) {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view === view) return leaf;
  }
  return null;
}

export function findMarkdownLeafForFilePath(plugin, filePath) {
  if (!filePath) return null;
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view instanceof MarkdownView && leaf.view.file && leaf.view.file.path === filePath) {
      return leaf;
    }
  }
  return null;
}

export function getActiveMarkdownView(plugin) {
  const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView && activeView.file) {
    rememberMarkdownView(plugin, activeView, findLeafForView(plugin, activeView));
    return activeView;
  }

  if (plugin.lastMarkdownView && plugin.lastMarkdownView.file) {
    return plugin.lastMarkdownView;
  }

  const rememberedLeaf = findMarkdownLeafForFilePath(plugin, plugin.lastMarkdownFilePath);
  if (rememberedLeaf && rememberedLeaf.view instanceof MarkdownView) {
    rememberMarkdownLeaf(plugin, rememberedLeaf);
    return rememberedLeaf.view;
  }

  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view instanceof MarkdownView && leaf.view.file) {
      rememberMarkdownLeaf(plugin, leaf);
      return leaf.view;
    }
  }

  return null;
}

export function getActiveMarkdownFile(plugin) {
  const target = getActiveMarkdownFileTarget(plugin);
  return target ? target.file : null;
}

export function getActiveMarkdownFileTarget(plugin) {
  const activeLeafIsAmoPanel = isActiveLeafAmoPanel(plugin);
  const shouldPreferCanvasTarget =
    plugin.isActiveLeafCanvas() ||
    plugin.lastMarkdownTargetSource === "canvas-selection";
  if (shouldPreferCanvasTarget) {
    const canvasView = plugin.getActiveCanvasView() || plugin.lastCanvasView;
    const selectedCanvasTarget = plugin.getSelectedCanvasMarkdownFileTarget(canvasView, {
      allowRemembered: false,
      refreshPanels: false,
    });
    if (selectedCanvasTarget) return selectedCanvasTarget;

    const rememberedCanvasTarget = canvasView ? plugin.getRememberedCanvasMarkdownFileTarget(canvasView) : null;
    if (rememberedCanvasTarget) return rememberedCanvasTarget;

    if (plugin.isActiveLeafCanvas()) {
      return null;
    }
  }

  const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView && activeView.file) {
    rememberMarkdownView(plugin, activeView, findLeafForView(plugin, activeView));
    return {
      file: activeView.file,
      source: "active-note",
    };
  }

  if (!activeLeafIsAmoPanel) {
    const selectedCanvasTarget = plugin.getSelectedCanvasMarkdownFileTarget();
    if (selectedCanvasTarget) return selectedCanvasTarget;
  }

  if (plugin.isActiveLeafCanvas()) {
    return null;
  }

  if (plugin.lastMarkdownTargetSource === "canvas-selection") {
    const rememberedCanvasTarget = getRememberedMarkdownFileTarget(plugin);
    if (rememberedCanvasTarget) return rememberedCanvasTarget;
  }

  const view = getActiveMarkdownView(plugin);
  if (view && view.file) {
    return {
      file: view.file,
      source: plugin.lastMarkdownTargetSource || "last-note",
    };
  }

  const rememberedTarget = getRememberedMarkdownFileTarget(plugin);
  if (rememberedTarget) return rememberedTarget;

  return null;
}

export function getRememberedMarkdownFileTarget(plugin) {
  if (!plugin.lastMarkdownFilePath) return null;
  const file = plugin.app.vault.getAbstractFileByPath(plugin.lastMarkdownFilePath);
  if (!file || typeof file.path !== "string") return null;
  return {
    file,
    source: plugin.lastMarkdownTargetSource || "last-note",
  };
}

export function isActiveLeafAmoPanel(plugin) {
  const leaf = plugin.app.workspace.activeLeaf;
  if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return false;
  return leaf.view.getViewType() === AMO_PANEL_VIEW_TYPE;
}

export function activeLeafType(plugin) {
  const leaf = plugin.app.workspace.activeLeaf;
  if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return "none";
  return leaf.view.getViewType();
}
