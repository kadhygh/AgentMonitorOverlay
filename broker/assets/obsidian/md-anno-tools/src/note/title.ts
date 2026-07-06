import { MarkdownView } from "obsidian";
import { normalizeMarkdownTitle } from "../core/metadata";

export function isAmoMetadata(amo) {
  return Boolean(amo && (amo.schemaVersion || amo.sessionId || amo.turnId || amo.noteId || amo.kind || amo.role));
}

export function displayNameForFile(file) {
  const name = String((file && file.path) || "").split(/[\\/]/u).pop() || "";
  return name.replace(/\.md$/iu, "");
}

export function syncAmoNoteDisplayTitleView(view, amo: any = {}) {
  if (!(view instanceof MarkdownView) || !view.file || !view.containerEl) return;

  const displayTitle = normalizeMarkdownTitle(amo.displayTitle);
  const hasDisplayTitle = Boolean(displayTitle);
  view.containerEl.classList.toggle("amo-note-has-display-title", hasDisplayTitle);

  const sourceHeader = amoNoteSourceTitleHeader(view);
  const mode = markdownViewMode(view);
  const shouldRenderSourceHeader = hasDisplayTitle && mode === "source";
  if (!shouldRenderSourceHeader) {
    if (sourceHeader) sourceHeader.remove();
    return;
  }

  const host = amoNoteSourceTitleHost(view);
  if (!host) {
    if (sourceHeader) sourceHeader.remove();
    return;
  }

  const header = sourceHeader || document.createElement("div");
  header.className = "amo-note-source-title-header";
  header.setAttribute("data-amo-note-source-title", "true");

  let title = header.querySelector(".amo-note-source-title");
  if (!(title instanceof HTMLElement)) {
    header.empty();
    title = header.createDiv({ cls: "amo-note-source-title" });
    header.createDiv({ cls: "amo-note-source-subtitle" });
  }
  title.setText(displayTitle);

  const subtitle = header.querySelector(".amo-note-source-subtitle");
  if (subtitle instanceof HTMLElement) {
    const originalName = normalizeMarkdownTitle(amo.displayName) || displayNameForFile(view.file);
    subtitle.setText(originalName);
    subtitle.hidden = !originalName;
  }

  if (header.parentElement !== host) {
    host.insertBefore(header, host.firstChild);
  } else if (host.firstChild !== header) {
    host.insertBefore(header, host.firstChild);
  }
}

export function markdownViewMode(view) {
  if (view && typeof (view as any).getMode === "function") {
    try {
      return (view as any).getMode();
    } catch {
      return "";
    }
  }
  if (view && view.containerEl && view.containerEl.querySelector(".markdown-source-view")) return "source";
  if (view && view.containerEl && view.containerEl.querySelector(".markdown-reading-view")) return "preview";
  return "";
}

export function amoNoteSourceTitleHost(view) {
  if (!view || !view.containerEl) return null;
  for (const selector of [".markdown-source-view", ".markdown-source-view.mod-cm6"]) {
    const host = view.containerEl.querySelector(selector);
    if (host instanceof HTMLElement) return host;
  }
  const content = (view as any).contentEl;
  if (content instanceof HTMLElement) return content;
  const fallback = view.containerEl.querySelector(".view-content");
  return fallback instanceof HTMLElement ? fallback : null;
}

export function amoNoteSourceTitleHeader(view) {
  if (!view || !view.containerEl) return null;
  const header = view.containerEl.querySelector(".amo-note-source-title-header");
  return header instanceof HTMLElement ? header : null;
}

export function firstAmoNoteContentLine(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  if (lines[index] === "---") {
    index += 1;
    while (index < lines.length && lines[index] !== "---") index += 1;
    if (index < lines.length) index += 1;
  }

  while (index < lines.length) {
    const trimmed = String(lines[index] || "").trim();
    if (!trimmed || /^<!--\s*amo:\s*\{[\s\S]*\}\s*-->$/u.test(trimmed)) {
      index += 1;
      continue;
    }
    return index;
  }

  return -1;
}
