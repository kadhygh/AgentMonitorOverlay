import { Notice } from "obsidian";
import { normalizeOpenKind, normalizeVaultFilePath, toVaultRelativeProtocolPath } from "../core/paths";
import { getVaultRoot } from "../core/ui-utils";

export async function handleAmoOpenProtocol(plugin: any, params) {
  const targetPath = resolveProtocolTargetPath(plugin, params);
  if (!targetPath) {
    new Notice("AMO open URL is missing a vault-relative path.");
    return;
  }

  const kind = normalizeOpenKind(params && (params.kind || params.target), targetPath);
  const focusNotePath = resolveProtocolFocusNotePath(plugin, params);
  const opened = await openVaultPath(plugin, targetPath, kind);
  if (opened && kind === "canvas" && focusNotePath) {
    window.setTimeout(() => {
      void plugin.refreshCanvasForExplicitOpen(targetPath).finally(() => {
        void plugin.focusCanvasNoteNode(targetPath, focusNotePath);
      });
    }, 120);
  }
}

export function resolveProtocolTargetPath(plugin: any, params) {
  const rawPath =
    params &&
    (params.relativePath ||
      params.relative_path ||
      params.file ||
      params.notePath ||
      params.note_path ||
      params.canvasPath ||
      params.canvas_path ||
      params.path);
  return normalizeVaultFilePath(toVaultRelativeProtocolPath(rawPath, getVaultRoot(plugin.app)));
}

export function resolveProtocolFocusNotePath(plugin: any, params) {
  const rawPath =
    params &&
    (params.focusNotePath ||
      params.focus_note_path ||
      params.latestNotePath ||
      params.latest_note_path ||
      params.selectedNotePath ||
      params.selected_note_path);
  return normalizeVaultFilePath(toVaultRelativeProtocolPath(rawPath, getVaultRoot(plugin.app)));
}

export async function openVaultPath(plugin: any, filePath, kind) {
  const targetPath = normalizeVaultFilePath(filePath);
  if (!targetPath) {
    new Notice("AMO target path is empty.");
    return false;
  }

  const file = plugin.app.vault.getAbstractFileByPath(targetPath);
  if (!file || typeof file.path !== "string") {
    const message = "AMO target not found: " + targetPath;
    plugin.setOperationStatus(message, "error");
    new Notice(message);
    return false;
  }

  const existingLeaf = findLeafForFilePath(plugin.app, file.path, kind);
  if (existingLeaf) {
    plugin.app.workspace.revealLeaf(existingLeaf);
    plugin.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
    plugin.rememberMarkdownLeaf(existingLeaf);
    plugin.setOperationStatus("Focused open " + kind + ": " + file.path + ".", "success");
    return true;
  }

  const leaf = createTabLeaf(plugin.app);
  await leaf.openFile(file as any, { active: true });
  plugin.app.workspace.revealLeaf(leaf);
  plugin.rememberMarkdownLeaf(leaf);
  plugin.setOperationStatus("Opened " + kind + ": " + file.path + ".", "success");
  return true;
}

export function createTabLeaf(app: any) {
  try {
    return app.workspace.getLeaf("tab");
  } catch {
    return app.workspace.getLeaf(true);
  }
}

export function findLeafForFilePath(app: any, filePath, kind) {
  const primaryTypes = kind === "canvas" ? ["canvas"] : ["markdown"];
  for (const viewType of primaryTypes) {
    const leaf = findLeafForFilePathInViewType(app, filePath, viewType);
    if (leaf) return leaf;
  }

  for (const viewType of ["markdown", "canvas"]) {
    if (primaryTypes.includes(viewType)) continue;
    const leaf = findLeafForFilePathInViewType(app, filePath, viewType);
    if (leaf) return leaf;
  }

  return null;
}

export function findLeafForFilePathInViewType(app: any, filePath, viewType) {
  for (const leaf of app.workspace.getLeavesOfType(viewType)) {
    const view: any = leaf.view;
    if (view && view.file && view.file.path === filePath) {
      return leaf;
    }
  }
  return null;
}
