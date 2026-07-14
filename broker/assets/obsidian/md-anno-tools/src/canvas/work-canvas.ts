import { Notice } from "obsidian";
import { normalizeVaultFilePath } from "../core/paths";
import { displayNameForFile } from "../note/title";
import { WorkCanvasNavigationModal, WorkCanvasPickerModal } from "../ui/modals";

export async function openAddNoteToWorkCanvasModal(plugin, file) {
  if (!file || typeof file.path !== "string") {
    new Notice("No active Markdown note.");
    return;
  }

  const folderPath = workCanvasFolderPath(plugin);
  const folderExists = await vaultPathExists(plugin, folderPath);
  const canvases = folderExists ? await listWorkCanvasTargets(plugin, file) : [];
  new WorkCanvasPickerModal(plugin.app, {
    folderPath,
    folderExists,
    canvases,
    notePath: file.path,
    onCreateFolder: async (folderName) => {
      await createWorkCanvasFolder(plugin, folderName);
    },
    onCreateCanvas: async (canvasName) => {
      const canvasFile = await createWorkCanvas(plugin, canvasName);
      await addNoteToWorkCanvas(plugin, file, canvasFile.path);
    },
    onSelectCanvas: async (canvasPath) => {
      await addNoteToWorkCanvas(plugin, file, canvasPath);
    },
    onOpenCanvas: async (canvasPath) => {
      const target = canvases.find((canvas) => canvas.path === canvasPath);
      if (target) await openWorkCanvasTarget(plugin, file, target);
    },
  }).open();
}

export function workCanvasFolderPath(plugin) {
  return normalizeVaultFilePath(plugin.settings.workCanvasFolder || "Canvases/work") || "Canvases/work";
}

export async function listWorkCanvasTargets(plugin, noteFile) {
  const folderPath = workCanvasFolderPath(plugin).replace(/\/+$/u, "");
  const prefix = folderPath + "/";
  const normalizedPrefix = prefix.toLowerCase();
  const files = plugin.app.vault
    .getFiles()
    .filter((file) => file.path.toLowerCase().startsWith(normalizedPrefix) && file.path.toLowerCase().endsWith(".canvas"))
    .sort((a, b) => a.path.localeCompare(b.path));

  const notePath = normalizeVaultFilePath(noteFile && noteFile.path);
  const targets = [];
  for (const file of files) {
    const matchingNodeIds = await canvasNoteNodeIds(plugin, file, notePath);
    targets.push({
      path: file.path,
      displayName: displayNameForFile(file),
      containsNote: matchingNodeIds.length > 0,
      matchingNodeIds,
      occurrenceCount: matchingNodeIds.length,
    });
  }
  return targets;
}

export async function canvasContainsNote(plugin, canvasFile, notePath) {
  return (await canvasNoteNodeIds(plugin, canvasFile, notePath)).length > 0;
}

export async function canvasNoteNodeIds(plugin, canvasFile, notePath) {
  const normalizedNotePath = normalizeVaultFilePath(notePath);
  if (!canvasFile || !normalizedNotePath) return [];
  const comparableNotePath = normalizedNotePath.toLowerCase();
  try {
    const raw = await plugin.app.vault.cachedRead(canvasFile as any);
    const canvas = JSON.parse(raw);
    return (Array.isArray(canvas.nodes) ? canvas.nodes : [])
      .filter((node) => normalizeVaultFilePath(node && node.file).toLowerCase() === comparableNotePath)
      .map((node) => String(node && node.id ? node.id : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function openWorkCanvasForNote(plugin, noteFile) {
  if (!noteFile || typeof noteFile.path !== "string") {
    new Notice("No active Markdown note.");
    return false;
  }

  const targets = await listWorkCanvasTargets(plugin, noteFile);
  const linkedTargets = targets.filter((target) => target.containsNote);
  if (linkedTargets.length === 1) {
    return openWorkCanvasTarget(plugin, noteFile, linkedTargets[0]);
  }
  if (linkedTargets.length > 1) {
    openWorkCanvasNavigationModal(plugin, noteFile, linkedTargets, true);
    return true;
  }

  if (targets.length === 1) {
    return openWorkCanvasTarget(plugin, noteFile, targets[0]);
  }
  if (targets.length > 1) {
    openWorkCanvasNavigationModal(plugin, noteFile, targets, false);
    return true;
  }

  new Notice("No work canvas exists in " + workCanvasFolderPath(plugin) + ".");
  return false;
}

export function openWorkCanvasNavigationModal(plugin, noteFile, targets, linkedOnly) {
  new WorkCanvasNavigationModal(plugin.app, {
    notePath: noteFile.path,
    targets,
    linkedOnly,
    onSelectCanvas: async (canvasPath) => {
      const target = targets.find((candidate) => candidate.path === canvasPath);
      if (target) await openWorkCanvasTarget(plugin, noteFile, target);
    },
  }).open();
}

export async function openWorkCanvasTarget(plugin, noteFile, target) {
  const canvasPath = normalizeVaultFilePath(target && target.path);
  if (!canvasPath) return false;

  const opened = await plugin.openVaultPath(canvasPath, "canvas");
  if (!opened) return false;

  const matchingNodeIds = Array.isArray(target.matchingNodeIds) ? target.matchingNodeIds : [];
  const nodeId = matchingNodeIds.length > 0 ? matchingNodeIds[matchingNodeIds.length - 1] : null;
  const focused = target.containsNote
    ? await plugin.focusCanvasNoteNode(canvasPath, noteFile.path, nodeId)
    : false;
  plugin.setOperationStatus("Opened work canvas: " + canvasPath + ".", "success");
  plugin.debugLog("work_canvas.opened", {
    canvasPath,
    notePath: noteFile.path,
    containsNote: Boolean(target.containsNote),
    occurrenceCount: Number(target.occurrenceCount) || 0,
    nodeId,
    focused,
  });
  plugin.refreshPanels();
  return true;
}

export async function createWorkCanvasFolder(plugin, rawName) {
  const folderName = safeVaultPathSegment(rawName || "work") || "work";
  const folderPath = "Canvases/" + folderName;
  await ensureVaultFolder(plugin, folderPath);
  plugin.settings.workCanvasFolder = folderPath;
  await plugin.saveData(plugin.settings);
  plugin.setOperationStatus("Created work canvas folder: " + folderPath + ".", "success");
  new Notice("Work canvas folder created: " + folderPath);
  plugin.refreshPanels();
  return folderPath;
}

export async function createWorkCanvas(plugin, rawName) {
  await ensureVaultFolder(plugin, workCanvasFolderPath(plugin));
  const baseName = safeVaultFileName(rawName || "Work canvas") || "Work canvas";
  const path = await nextAvailableVaultPath(plugin, workCanvasFolderPath(plugin) + "/" + baseName + ".canvas");
  const file = await plugin.app.vault.create(path, JSON.stringify({ nodes: [], edges: [] }, null, 2));
  plugin.setOperationStatus("Created work canvas: " + file.path + ".", "success");
  return file;
}

export async function addNoteToWorkCanvas(plugin, noteFile, canvasPath) {
  const canvasFile = plugin.app.vault.getAbstractFileByPath(normalizeVaultFilePath(canvasPath));
  if (!canvasFile || typeof canvasFile.path !== "string") {
    new Notice("Work canvas not found.");
    return false;
  }

  let canvas;
  try {
    canvas = JSON.parse(await plugin.app.vault.cachedRead(canvasFile as any));
  } catch {
    canvas = { nodes: [], edges: [] };
  }
  if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) canvas = { nodes: [], edges: [] };
  if (!Array.isArray(canvas.nodes)) canvas.nodes = [];
  if (!Array.isArray(canvas.edges)) canvas.edges = [];

  const position = nextWorkCanvasNodePosition(canvas.nodes);
  const node = {
    id: uniqueCanvasNodeId(canvas.nodes, "amo-work-note"),
    type: "file",
    file: noteFile.path,
    x: position.x,
    y: position.y,
    width: 420,
    height: 260,
  };
  canvas.nodes.push(node);
  await plugin.app.vault.modify(canvasFile as any, JSON.stringify(canvas, null, 2));

  plugin.setOperationStatus("Added note to work canvas: " + canvasFile.path + ".", "success");
  new Notice("Added note to work canvas.");
  await plugin.openVaultPath(canvasFile.path, "canvas");
  await plugin.refreshCanvasForExplicitOpen(canvasFile.path);
  await plugin.focusCanvasNoteNode(canvasFile.path, noteFile.path, node.id);
  return true;
}

export function nextWorkCanvasNodePosition(nodes) {
  const fileNodes = Array.isArray(nodes) ? nodes : [];
  if (fileNodes.length === 0) return { x: 0, y: 0 };

  const maxRight = fileNodes.reduce((value, node) => {
    const x = Number(node && node.x);
    const width = Number(node && node.width);
    return Math.max(value, (Number.isFinite(x) ? x : 0) + (Number.isFinite(width) ? width : 320));
  }, 0);
  const top = fileNodes.reduce((value, node) => {
    const y = Number(node && node.y);
    return Math.min(value, Number.isFinite(y) ? y : 0);
  }, Number.POSITIVE_INFINITY);
  return {
    x: maxRight + 180,
    y: Number.isFinite(top) ? top : 0,
  };
}

export function uniqueCanvasNodeId(nodes, prefix) {
  const existing = new Set((Array.isArray(nodes) ? nodes : []).map((node) => node && node.id).filter(Boolean));
  let id = "";
  do {
    id = prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  } while (existing.has(id));
  return id;
}

export async function ensureVaultFolder(plugin, folderPath) {
  const normalized = normalizeVaultFilePath(folderPath);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? current + "/" + part : part;
    if (!(await vaultPathExists(plugin, current))) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

export async function vaultPathExists(plugin, path) {
  const normalized = normalizeVaultFilePath(path);
  if (!normalized) return false;
  if (plugin.app.vault.getAbstractFileByPath(normalized)) return true;
  if (plugin.app.vault.adapter && typeof plugin.app.vault.adapter.exists === "function") {
    return plugin.app.vault.adapter.exists(normalized);
  }
  return false;
}

export async function nextAvailableVaultPath(plugin, path) {
  const normalized = normalizeVaultFilePath(path);
  if (!(await vaultPathExists(plugin, normalized))) return normalized;

  const dot = normalized.lastIndexOf(".");
  const stem = dot >= 0 ? normalized.slice(0, dot) : normalized;
  const extension = dot >= 0 ? normalized.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = stem + " " + index + extension;
    if (!(await vaultPathExists(plugin, candidate))) return candidate;
  }
  return stem + " " + Date.now().toString(36) + extension;
}

export function safeVaultPathSegment(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|#^[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function safeVaultFileName(value) {
  return safeVaultPathSegment(value).replace(/\.canvas$/iu, "");
}
