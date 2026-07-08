import { MarkdownView, Notice } from "obsidian";
import { ANNO_TAG_PREFIX, ANNO_TAG_SUFFIX } from "../core/constants";
import { normalizeVaultFilePath } from "../core/paths";
import { getWindowSelectionText, previewText } from "../core/ui-utils";
import {
  buildAnnotationMarkup,
  buildReferencedAnnotationMarkup,
  extractAnnotationItems,
  findAnnotationItemAtOffset,
  insertReferencedAnnotation,
  normalizeAnnotationContent,
  removeAnnotationByIndex,
} from "./syntax";
import {
  editorOffsetToPosition,
  editorPositionToOffset,
  endOfLineOffset,
  findUnannotatedMarkdownRange,
} from "./source-ranges";

export function canInsertAnnotationAtActiveEditor(plugin) {
  const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView && activeView.editor) return true;
  return Boolean(!plugin.isActiveLeafCanvas() && plugin.lastMarkdownView && plugin.lastMarkdownView.editor);
}

export function canInsertAnnotationAtFileEditor(plugin, file) {
  const view = getMarkdownViewForFile(plugin, file);
  return Boolean(view && view.editor);
}

export function getMarkdownViewForFile(plugin, fileOrPath) {
  const filePath = typeof fileOrPath === "string" ? fileOrPath : fileOrPath && fileOrPath.path;
  const leaf = plugin.findMarkdownLeafForFilePath(filePath);
  return leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
}

export function insertAnnotationAtFileEditor(plugin, file) {
  const view = getMarkdownViewForFile(plugin, file);
  if (!view || !view.editor || !view.file) {
    new Notice("Open this note in a Markdown tab before inserting an annotation marker.");
    return false;
  }

  const leaf = plugin.findLeafForView(view);
  if (leaf) {
    plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  plugin.rememberMarkdownView(view, leaf);
  wrapSelectionWithAnnotation(plugin, view.editor);
  plugin.setOperationStatus("Inserted annotation marker in " + view.file.path + ".", "success");
  return true;
}

export function insertAnnotationAtActiveEditor(plugin) {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView) || plugin.getActiveMarkdownView();
  if (!view || !view.editor) {
    new Notice("No active Markdown editor.");
    return;
  }

  const leaf = plugin.findLeafForView(view) || plugin.lastMarkdownLeaf;
  if (leaf) {
    plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  wrapSelectionWithAnnotation(plugin, view.editor);
  plugin.setOperationStatus("Inserted annotation marker.", "success");
}

export async function insertAnnotationFromCurrentSelection(plugin) {
  const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const editorSelection = activeView && activeView.editor ? activeView.editor.getSelection() : "";
  if (activeView && activeView.editor && editorSelection.trim().length > 0) {
    wrapSelectionWithAnnotation(plugin, activeView.editor);
    plugin.setOperationStatus("Inserted annotation marker.", "success");
    return;
  }

  const selectedText = getWindowSelectionText();
  const file = plugin.getActiveMarkdownFile();
  if (selectedText && file) {
    await insertReferencedAnnotationNearTextInFile(plugin, file, selectedText);
    return;
  }

  if (activeView && activeView.editor) {
    wrapSelectionWithAnnotation(plugin, activeView.editor);
    plugin.setOperationStatus("Inserted annotation marker.", "success");
    return;
  }

  insertAnnotationAtActiveEditor(plugin);
}

export function wrapSelectionWithAnnotation(plugin, editor) {
  const selection = editor.getSelection();
  if (selection.trim().length > 0) {
    insertReferencedAnnotation(editor, selection);
    return;
  }

  const cursor = editor.getCursor();
  editor.replaceSelection(ANNO_TAG_PREFIX + ANNO_TAG_SUFFIX);
  editor.setCursor({
    line: cursor.line,
    ch: cursor.ch + ANNO_TAG_PREFIX.length,
  });
}

export async function appendReferencedAnnotationToFile(plugin, file, reference) {
  const content = normalizeAnnotationContent(reference);
  if (!content) {
    new Notice("No selected text to quote.");
    return;
  }

  await appendAnnotationBlockToFile(plugin, file, buildReferencedAnnotationMarkup(content));
  plugin.setOperationStatus("Referenced annotation appended to " + file.path + ".", "success");
  new Notice("Referenced annotation appended.");
}

export async function insertReferencedAnnotationNearTextInFile(plugin, file, reference) {
  const content = normalizeAnnotationContent(reference);
  if (!content) {
    new Notice("No selected text to quote.");
    return false;
  }

  const markdown = await plugin.app.vault.cachedRead(file as any);
  const range = findUnannotatedMarkdownRange(markdown, content);
  if (!range) {
    plugin.setOperationStatus(
      "Could not locate the selected text in " + file.path + ". Switch to editing mode and try again.",
      "error"
    );
    new Notice("Could not locate selected text in this note. Switch to editing mode and try again.");
    return false;
  }

  const source = String(markdown || "").replace(/\r\n?/gu, "\n");
  const insertAt = endOfLineOffset(source, range.end);
  const lineStart = source.lastIndexOf("\n", Math.max(0, insertAt - 1)) + 1;
  const lineText = source.slice(lineStart, insertAt);
  const leading = lineText.trim().length > 0 ? "\n\n" : "";
  const block = leading + buildReferencedAnnotationMarkup(content).replace(/\n\n\[\/anno\]$/u, "\n\n\n[/anno]");
  const nextContent = source.slice(0, insertAt) + block + source.slice(insertAt);

  await plugin.app.vault.modify(file, nextContent);
  plugin.setOperationStatus("Inserted referenced annotation near selection in " + file.path + ".", "success");
  new Notice("Referenced annotation inserted.");
  plugin.refreshPanels();
  return true;
}

export async function appendAnnotationToFile(plugin, file, rawContent) {
  const content = normalizeAnnotationContent(rawContent);
  if (!content) {
    new Notice("Annotation content cannot be empty.");
    return;
  }

  if (content.includes(ANNO_TAG_SUFFIX)) {
    new Notice("Annotation content cannot include " + ANNO_TAG_SUFFIX + ".");
    return;
  }

  const block = buildAnnotationMarkup(content);
  await appendAnnotationBlockToFile(plugin, file, block);
  plugin.setOperationStatus("Annotation appended to " + file.path + ".", "success");
  new Notice("Annotation appended.");
}

export async function appendAnnotationBlockToFile(plugin, file, block) {
  const markdown = await plugin.app.vault.cachedRead(file as any);
  const nextContent =
    markdown.trim().length === 0 ? block + "\n" : markdown.replace(/\s*$/u, "") + "\n\n" + block + "\n";

  await plugin.app.vault.modify(file, nextContent);
}

export async function deleteAnnotationFromFile(plugin, file, annotationIndex) {
  if (!file || !Number.isSafeInteger(annotationIndex)) {
    new Notice("No annotation selected.");
    return false;
  }

  const markdown = await plugin.app.vault.cachedRead(file as any);
  const result = removeAnnotationByIndex(markdown, annotationIndex);
  if (!result.removed) {
    new Notice("Annotation not found.");
    return false;
  }

  await plugin.app.vault.modify(file, result.markdown);
  plugin.debugLog("annotations.delete.ok", {
    notePath: file.path,
    annotationIndex,
    annotationPreview: previewText(result.item && result.item.content),
  });
  plugin.setOperationStatus("Deleted annotation " + annotationIndex + " from " + file.path + ".", "success");
  new Notice("Annotation deleted.");
  plugin.refreshPanels();
  return true;
}

export async function deleteRenderedAnnotation(plugin, sourcePath, block) {
  const file = sourcePath ? plugin.app.vault.getAbstractFileByPath(normalizeVaultFilePath(sourcePath)) : null;
  if (!file || typeof file.path !== "string") {
    new Notice("Could not resolve annotation source note.");
    return false;
  }

  const markdown = await plugin.app.vault.cachedRead(file as any);
  const items = extractAnnotationItems(markdown);
  const target =
    items.find((item) => item.startLine === block.startLine && item.endLine === block.endLine) ||
    items.find((item) => normalizeAnnotationContent(item.content) === normalizeAnnotationContent(block.content));
  if (!target) {
    new Notice("Annotation not found.");
    return false;
  }

  return deleteAnnotationFromFile(plugin, file, target.index);
}

export function annotationItemAtEditorCursor(plugin, editor) {
  if (!editor || typeof editor.getValue !== "function" || typeof editor.getCursor !== "function") return null;
  const markdown = editor.getValue();
  const cursor = editor.getCursor();
  const offset = editorPositionToOffset(markdown, cursor);
  return findAnnotationItemAtOffset(markdown, offset);
}

export function deleteAnnotationAtEditor(plugin, editor) {
  const item = annotationItemAtEditorCursor(plugin, editor);
  if (!item) {
    new Notice("Cursor is not inside an AMO annotation.");
    return false;
  }

  const markdown = editor.getValue();
  const result = removeAnnotationByIndex(markdown, item.index);
  if (!result.removed || !result.range) {
    new Notice("Annotation not found.");
    return false;
  }

  editor.replaceRange(
    "",
    editorOffsetToPosition(markdown, result.range.startOffset),
    editorOffsetToPosition(markdown, result.range.endOffset)
  );
  plugin.setOperationStatus("Deleted current annotation.", "success");
  new Notice("Annotation deleted.");
  plugin.refreshPanels();
  return true;
}
