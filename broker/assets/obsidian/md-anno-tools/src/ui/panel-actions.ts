import { MarkdownView, Notice } from "obsidian";
import { extractAnnotationItems, formatAnnotationsForClipboard } from "../annotations/syntax";
import { writeTextToClipboard } from "../core/api";
import { parseAmoMetadata } from "../core/metadata";
import { normalizeVaultFilePath } from "../core/paths";

export async function getActiveNoteInfo(plugin) {
  const target = plugin.getActiveMarkdownFileTarget();
  if (!target || !target.file) {
    return {
      file: null,
      source: plugin.isActiveLeafCanvas() ? "canvas-selection-missing" : "none",
      annotations: [],
      annotationItems: [],
      amo: {},
      displayTitle: "",
      isAmoNote: false,
      activeLeafType: plugin.activeLeafType(),
    };
  }

  const file = target.file;
  const markdown = await plugin.app.vault.cachedRead(file as any);
  const amo = parseAmoMetadata(markdown);
  const annotationItems = extractAnnotationItems(markdown);
  const isAmoNote = Boolean(amo.schemaVersion || amo.sessionId || amo.noteId || amo.kind);
  return {
    file,
    source: target.source,
    annotations: annotationItems.map((item) => item.content).filter((content) => content.length > 0),
    annotationItems,
    amo,
    displayTitle: amo.displayTitle || "",
    isAmoNote,
    activeLeafType: plugin.activeLeafType(),
  };
}

export function getPanelCanvasFile(plugin) {
  const view = plugin.getActiveCanvasView() || plugin.lastCanvasView;
  return view && view.file && typeof view.file.path === "string" ? view.file : null;
}

export async function revealFileInExplorer(plugin, fileOrPath) {
  const file =
    typeof fileOrPath === "string"
      ? plugin.app.vault.getAbstractFileByPath(normalizeVaultFilePath(fileOrPath))
      : fileOrPath;
  if (!file || typeof file.path !== "string") {
    new Notice("No file to reveal.");
    return false;
  }

  let leaves = plugin.app.workspace.getLeavesOfType("file-explorer");
  const commands = plugin.app.commands;
  if (leaves.length === 0 && commands && typeof commands.executeCommandById === "function") {
    try {
      await commands.executeCommandById("file-explorer:open");
    } catch {
      // The file explorer command may be unavailable in some Obsidian builds.
    }
    leaves = plugin.app.workspace.getLeavesOfType("file-explorer");
  }

  for (const leaf of leaves) {
    const view = leaf && (leaf.view as any);
    if (view && typeof view.revealInFolder === "function") {
      plugin.app.workspace.revealLeaf(leaf);
      await view.revealInFolder(file);
      plugin.setOperationStatus("Revealed file: " + file.path + ".", "success");
      return true;
    }
  }

  plugin.setOperationStatus("Could not reveal file in Obsidian explorer: " + file.path + ".", "error");
  new Notice("Could not reveal file in Obsidian explorer.");
  return false;
}

export async function copyAnnotationItemFromFile(plugin, file, annotationIndex) {
  const markdown = await plugin.app.vault.cachedRead(file as any);
  const item = extractAnnotationItems(markdown).find((candidate) => candidate.index === annotationIndex);
  if (!item) {
    new Notice("Annotation not found.");
    return false;
  }

  await writeTextToClipboard(
    formatAnnotationsForClipboard([item.content], plugin.settings.safeCliPaste !== false)
  );
  plugin.setOperationStatus("Copied annotation " + annotationIndex + " from " + file.path + ".", "success");
  new Notice("Annotation copied.");
  return true;
}

export async function focusAnnotationItemInFile(plugin, file, item) {
  if (!file || !item) {
    new Notice("Annotation not found.");
    return false;
  }

  await plugin.openVaultPath(file.path, "note");
  await plugin.delay(80);
  const leaf = plugin.findMarkdownLeafForFilePath(file.path);
  const view = leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
  if (leaf) {
    plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  if (view && view.editor) {
    const from = { line: Math.max(0, item.startLine || 0), ch: 0 };
    const to = { line: Math.max(0, item.endLine || item.startLine || 0), ch: 0 };
    view.editor.setCursor(from);
    if (typeof view.editor.scrollIntoView === "function") {
      view.editor.scrollIntoView({ from, to }, true);
    }
    plugin.setOperationStatus("Focused annotation " + item.index + " in " + file.path + ".", "success");
    return true;
  }

  plugin.setOperationStatus("Opened note but could not focus annotation " + item.index + ".", "neutral");
  return false;
}
