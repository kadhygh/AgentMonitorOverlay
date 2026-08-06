import { Notice } from "obsidian";
import { joinUrl, postJson } from "../core/api";
import { PLUGIN_VERSION } from "../core/constants";
import {
  normalizeOpenKind,
  normalizeVaultFilePath,
  protocolPathBelongsToVault,
  toVaultRelativeProtocolPath,
} from "../core/paths";
import { getVaultRoot, messageFromError } from "../core/ui-utils";

export async function handleAmoOpenProtocol(plugin: any, params) {
  const startedAt = performance.now();
  const vaultRoot = getVaultRoot(plugin.app);
  const openRequestId = String(params?.openRequestId || params?.open_request_id || "").trim() || null;
  const requestedVaultId = params?.vault || null;
  const details: any = { reusedLeaf: false, lookupMs: 0, openFileMs: 0, revealMs: 0, focusFollowupMs: 0 };
  const logContext = { openRequestId, requestedVaultId, vaultRoot };

  if (!protocolPathBelongsToVault(params?.path, vaultRoot)) {
    const message = "AMO open request targets a different vault.";
    plugin.debugLog?.("protocol.open.ignored_foreign_vault", {
      ...logContext,
      path: params?.path,
      relativePath: params?.relativePath || params?.relative_path,
    });
    await acknowledgeOpen(plugin, {
      openRequestId,
      status: "rejected",
      vaultRoot,
      vaultId: requestedVaultId,
      targetPath: null,
      kind: params?.kind || null,
      message,
      timings: withTotal(details, startedAt),
    });
    return;
  }

  const targetPath = resolveProtocolTargetPath(plugin, params);
  const kind = normalizeOpenKind(params?.kind || params?.target, targetPath);
  if (!targetPath) {
    const message = "AMO open URL is missing a vault-relative path.";
    new Notice(message);
    await acknowledgeOpen(plugin, {
      openRequestId,
      status: "rejected",
      vaultRoot,
      vaultId: requestedVaultId,
      targetPath: null,
      kind,
      message,
      timings: withTotal(details, startedAt),
    });
    return;
  }

  plugin.debugLog?.("protocol.open.accepted", { ...logContext, targetPath, kind });
  try {
    const opened = await openVaultPath(plugin, targetPath, kind, details);
    if (!opened) {
      await acknowledgeOpen(plugin, {
        openRequestId,
        status: details.status || "not_found",
        vaultRoot,
        vaultId: requestedVaultId,
        targetPath,
        kind,
        message: details.message || `AMO target not found: ${targetPath}`,
        reusedLeaf: details.reusedLeaf,
        timings: withTotal(details, startedAt),
      });
      return;
    }

    const focusNotePath = resolveProtocolFocusNotePath(plugin, params);
    if (kind === "canvas" && focusNotePath) {
      const focusStartedAt = performance.now();
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      try {
        await plugin.refreshCanvasForExplicitOpen(targetPath);
        await plugin.focusCanvasNoteNode(targetPath, focusNotePath);
      } catch (error) {
        plugin.debugLog?.("protocol.open.focus_followup_error", {
          ...logContext,
          targetPath,
          focusNotePath,
          message: messageFromError(error),
        });
      }
      details.focusFollowupMs = Math.round(performance.now() - focusStartedAt);
    }

    const status = details.reusedLeaf ? "focused" : "opened";
    const timings = withTotal(details, startedAt);
    plugin.debugLog?.("protocol.open.completed", {
      ...logContext,
      targetPath,
      kind,
      status,
      reusedLeaf: details.reusedLeaf,
      timings,
    });
    await acknowledgeOpen(plugin, {
      openRequestId,
      status,
      vaultRoot,
      vaultId: requestedVaultId,
      targetPath,
      kind,
      reusedLeaf: details.reusedLeaf,
      message: details.reusedLeaf ? "Focused existing Obsidian tab." : "Opened Obsidian tab.",
      timings,
    });
  } catch (error) {
    const message = messageFromError(error);
    const timings = withTotal(details, startedAt);
    plugin.debugLog?.("protocol.open.error", { ...logContext, targetPath, kind, message, timings });
    new Notice(`AMO could not open ${targetPath}: ${message}`);
    await acknowledgeOpen(plugin, {
      openRequestId,
      status: "error",
      vaultRoot,
      vaultId: requestedVaultId,
      targetPath,
      kind,
      reusedLeaf: details.reusedLeaf,
      message,
      timings,
    });
  }
}

async function acknowledgeOpen(plugin: any, payload) {
  if (!payload.openRequestId) return;
  try {
    await postJson(joinUrl(plugin.settings.bridgeUrl, "/api/obsidian/open-results"), {
      ...payload,
      pluginVersion: PLUGIN_VERSION,
      completedAt: new Date().toISOString(),
    });
    plugin.debugLog?.("protocol.open.ack_sent", {
      openRequestId: payload.openRequestId,
      status: payload.status,
      targetPath: payload.targetPath,
    });
  } catch (error) {
    plugin.debugLog?.("protocol.open.ack_error", {
      openRequestId: payload.openRequestId,
      status: payload.status,
      message: messageFromError(error),
    });
  }
}

function withTotal(details, startedAt) {
  return {
    lookupMs: details.lookupMs || 0,
    openFileMs: details.openFileMs || 0,
    revealMs: details.revealMs || 0,
    focusFollowupMs: details.focusFollowupMs || 0,
    totalMs: Math.round(performance.now() - startedAt),
  };
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

export async function openVaultPath(plugin: any, filePath, kind, details: any = {}) {
  const targetPath = normalizeVaultFilePath(filePath);
  if (!targetPath) {
    details.status = "rejected";
    details.message = "AMO target path is empty.";
    new Notice(details.message);
    return false;
  }

  const lookupStartedAt = performance.now();
  const file = plugin.app.vault.getAbstractFileByPath(targetPath);
  details.lookupMs = Math.round(performance.now() - lookupStartedAt);
  if (!file || typeof file.path !== "string") {
    details.status = "not_found";
    details.message = "AMO target not found: " + targetPath;
    plugin.setOperationStatus(details.message, "error");
    new Notice(details.message);
    return false;
  }

  const existingLeaf = findLeafForFilePath(plugin.app, file.path, kind);
  if (existingLeaf) {
    details.reusedLeaf = true;
    const revealStartedAt = performance.now();
    plugin.app.workspace.revealLeaf(existingLeaf);
    plugin.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
    details.revealMs = Math.round(performance.now() - revealStartedAt);
    plugin.rememberMarkdownLeaf(existingLeaf);
    plugin.setOperationStatus("Focused open " + kind + ": " + file.path + ".", "success");
    return true;
  }

  const leaf = createTabLeaf(plugin.app);
  const openFileStartedAt = performance.now();
  await leaf.openFile(file as any, { active: true });
  details.openFileMs = Math.round(performance.now() - openFileStartedAt);
  const revealStartedAt = performance.now();
  plugin.app.workspace.revealLeaf(leaf);
  details.revealMs = Math.round(performance.now() - revealStartedAt);
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
    if (view && view.file && view.file.path === filePath) return leaf;
  }
  return null;
}