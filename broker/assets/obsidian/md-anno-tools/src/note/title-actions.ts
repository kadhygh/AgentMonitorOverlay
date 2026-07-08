import { Notice } from "obsidian";
import { joinUrl, postJson } from "../core/api";
import { normalizeMarkdownTitle, parseAmoMetadata, removeAmoDisplayHeading, upsertAmoMarker } from "../core/metadata";
import { normalizeVaultFilePath } from "../core/paths";
import { getVaultRoot, messageFromError } from "../core/ui-utils";
import { NoteTitleModal } from "../ui/modals";
import { displayNameForFile, firstAmoNoteContentLine } from "./title";

export async function updateAmoNoteTitle(plugin, file, rawTitle) {
  if (!file) {
    new Notice("No active Markdown note.");
    return false;
  }

  const displayTitle = normalizeMarkdownTitle(rawTitle);

  const markdown = await plugin.app.vault.cachedRead(file as any);
  const amo = parseAmoMetadata(markdown);
  if (!amo.schemaVersion && !amo.sessionId && !amo.noteId && !amo.kind) {
    new Notice("Current note is not an AMO note.");
    return false;
  }

  const metadata = {
    ...amo,
    schemaVersion: amo.schemaVersion || 1,
    displayTitle,
  };
  const withMarker = upsertAmoMarker(markdown, metadata);
  const nextMarkdown = removeAmoDisplayHeading(withMarker, amo.displayTitle, amo.displayName || displayNameForFile(file));
  await plugin.app.vault.modify(file, nextMarkdown);

  try {
    await postJson(joinUrl(plugin.settings.bridgeUrl, "/api/obsidian/note-title"), {
      schemaVersion: 1,
      source: "obsidian-md-anno-tools",
      vaultRoot: getVaultRoot(plugin.app),
      notePath: file.path,
      noteId: amo.noteId || null,
      displayTitle,
    });
  } catch (error) {
    plugin.debugLog("note.title.sync_error", {
      notePath: file.path,
      message: messageFromError(error),
    });
  }

  plugin.setOperationStatus(displayTitle ? "Updated note title: " + displayTitle : "Cleared AMO note title.", "success");
  new Notice(displayTitle ? "AMO note title updated." : "AMO note title cleared.");
  void plugin.syncAmoNotePropertyViews();
  void plugin.syncAmoCanvasRendering();
  plugin.refreshPanels();
  return true;
}

export async function editAmoNoteTitle(plugin, file) {
  if (!file) {
    new Notice("No active Markdown note.");
    return;
  }

  let markdown = "";
  try {
    markdown = await plugin.app.vault.cachedRead(file as any);
  } catch (error) {
    new Notice("Could not read note: " + messageFromError(error));
    return;
  }

  const amo = parseAmoMetadata(markdown);
  const currentTitle = amo.displayTitle || "";
  new NoteTitleModal(plugin.app, currentTitle, file.path, async (value) => {
    await updateAmoNoteTitle(plugin, file, value);
  }).open();
}

export async function renderAmoNoteDisplayHeader(plugin, root, context) {
  if (!(root instanceof HTMLElement) || !context || typeof context.getSectionInfo !== "function") return false;
  if (root.querySelector(".amo-note-display-header")) return true;

  const section = context.getSectionInfo(root);
  if (!section || typeof section.text !== "string") return false;

  const file = context.sourcePath ? plugin.app.vault.getAbstractFileByPath(normalizeVaultFilePath(context.sourcePath)) : null;
  if (!file || typeof file.path !== "string") return false;

  let markdown = "";
  try {
    markdown = await plugin.app.vault.cachedRead(file as any);
  } catch {
    return false;
  }

  const amo = parseAmoMetadata(markdown);
  const displayTitle = normalizeMarkdownTitle(amo.displayTitle);
  if (!displayTitle) return false;

  const firstContentLine = firstAmoNoteContentLine(markdown);
  if (firstContentLine < 0) return false;

  const lineStart = Number(section.lineStart);
  const lineEnd = Number(section.lineEnd);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return false;
  if (!(lineStart <= firstContentLine && firstContentLine <= lineEnd)) return false;

  const header = document.createElement("div");
  header.classList.add("amo-note-display-header");
  header.setAttribute("data-amo-note-title", "true");

  const title = header.createDiv({ cls: "amo-note-display-title" });
  title.setText(displayTitle);

  const originalName = amo.displayName || displayNameForFile(file);
  if (originalName) {
    const subtitle = header.createDiv({ cls: "amo-note-display-subtitle" });
    subtitle.setText(originalName);
  }

  root.prepend(header);
  return true;
}
