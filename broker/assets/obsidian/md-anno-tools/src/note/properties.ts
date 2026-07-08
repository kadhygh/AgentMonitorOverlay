import { MarkdownView, Notice } from "obsidian";
import { parseAmoMetadata } from "../core/metadata";
import { amoNoteSourceTitleHeader, isAmoMetadata, syncAmoNoteDisplayTitleView } from "./title";

export async function syncAmoNotePropertyViews(plugin) {
  const leaves = plugin.app.workspace.getLeavesOfType("markdown");
  for (const leaf of leaves) {
    if (!(leaf.view instanceof MarkdownView)) continue;
    const view = leaf.view;
    await syncAmoNotePropertyView(plugin, view);
  }
}

export async function syncAmoNotePropertyView(plugin, view) {
  if (!(view instanceof MarkdownView) || !view.file || !view.containerEl) return;

  const filePath = view.file.path;
  const amo = await readAmoMetadataForFile(plugin, view.file);
  const isAmoNote = isAmoMetadata(amo);
  if (!view.file || view.file.path !== filePath || !view.containerEl) return;

  view.containerEl.classList.toggle("amo-note-view", isAmoNote);
  const shouldHide =
    isAmoNote &&
    Boolean(plugin.settings.hideAmoNoteProperties) &&
    !plugin.amoNotePropertiesExpandedPaths.has(filePath);
  view.containerEl.classList.toggle("amo-hide-note-properties", shouldHide);
  view.containerEl.classList.toggle("amo-show-note-properties", isAmoNote && !shouldHide);
  syncAmoNoteDisplayTitleView(view, isAmoNote ? amo : {});
}

export async function isAmoMarkdownFile(plugin, file) {
  if (!file || typeof file.path !== "string") return false;

  const amo = await readAmoMetadataForFile(plugin, file);
  return isAmoMetadata(amo);
}

export async function readAmoMetadataForFile(plugin, file) {
  if (!file || typeof file.path !== "string") return {};

  try {
    const markdown = await plugin.app.vault.cachedRead(file as any);
    return parseAmoMetadata(markdown);
  } catch {
    return {};
  }
}

export async function toggleAmoNotePropertiesForView(plugin, view) {
  if (!(view instanceof MarkdownView) || !view.file) {
    new Notice("No active Markdown note.");
    return;
  }

  const isAmoNote = await isAmoMarkdownFile(plugin, view.file);
  if (!isAmoNote) {
    new Notice("Current note is not an AMO note.");
    return;
  }

  const filePath = view.file.path;
  if (plugin.amoNotePropertiesExpandedPaths.has(filePath)) {
    plugin.amoNotePropertiesExpandedPaths.delete(filePath);
    new Notice("AMO note properties hidden.");
  } else {
    plugin.amoNotePropertiesExpandedPaths.add(filePath);
    new Notice("AMO note properties shown.");
  }

  await syncAmoNotePropertyViews(plugin);
}

export function clearAmoNotePropertyViewClasses(plugin) {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    const view: any = leaf.view;
    if (!view || !view.containerEl) continue;
    view.containerEl.classList.remove(
      "amo-note-view",
      "amo-hide-note-properties",
      "amo-show-note-properties",
      "amo-note-has-display-title"
    );
    const sourceHeader = amoNoteSourceTitleHeader(view);
    if (sourceHeader) sourceHeader.remove();
  }
}
