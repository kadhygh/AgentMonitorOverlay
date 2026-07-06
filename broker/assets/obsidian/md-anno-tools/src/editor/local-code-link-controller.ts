import { Notice } from "obsidian";
import { describeElement, messageFromError } from "../core/ui-utils";
import {
  findLocalCodeLinkTargetInLine,
  formatLocalCodeLinkUrl,
  formatZedCodeLinkTarget,
  looksLikeLocalCodeLinkCandidate,
  normalizeLocalCodeLinkEditor,
  normalizeLocalCodeLinkHref,
  openExternalCodeUrl,
  openZedCodeLink,
  parseLocalCodeLink,
} from "./local-code-links";

export function handleLocalCodeLinkClick(plugin: any, event: MouseEvent) {
  if (event.button !== 0 || plugin.settings.interceptLocalCodeLinks === false) return;

  const target = event.target instanceof Element ? event.target : null;
  const anchor = target && target.closest("a[href], a[data-href], a[data-amo-code-link]");
  if (!(anchor instanceof HTMLElement)) return;

  const rawHref =
    anchor.getAttribute("data-amo-code-link") ||
    anchor.getAttribute("data-href") ||
    anchor.getAttribute("href") ||
    (anchor instanceof HTMLAnchorElement ? anchor.href : "") ||
    "";
  const absoluteHref = anchor instanceof HTMLAnchorElement ? anchor.href : rawHref;
  const link = parseLocalCodeLink(rawHref, absoluteHref);
  if (suppressLocalCodeLinkFollowup(plugin, rawHref, event, "document-click")) return;
  if (!link || !link.line) {
    if (looksLikeLocalCodeLinkCandidate(rawHref)) {
      plugin.debugLog("code_link.parse_miss", {
        rawHref,
        absoluteHref,
      });
    }
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  markLocalCodeLinkHandled(plugin, rawHref);
  void openLocalCodeLink(plugin, link, rawHref);
}

export function handleEditorLocalCodeLinkEvent(plugin: any, event: MouseEvent, view: any, phase: string) {
  if (event.button !== 0 || plugin.settings.interceptLocalCodeLinks === false) return false;

  const linkTarget = localCodeLinkTargetFromEditorEvent(event, view);
  if (!linkTarget) return false;
  if (suppressLocalCodeLinkFollowup(plugin, linkTarget, event, phase)) return true;

  const link = parseLocalCodeLink(linkTarget, linkTarget);
  if (!link || !link.line) {
    plugin.debugLog("code_link.editor_parse_miss", {
      phase,
      linkTarget,
      target: event.target instanceof Element ? describeElement(event.target) : "",
    });
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  markLocalCodeLinkHandled(plugin, linkTarget);
  void openLocalCodeLink(plugin, link, linkTarget);
  return true;
}

function markLocalCodeLinkHandled(plugin: any, linkTarget: string) {
  plugin.codeLinkSuppressUntilMs = Date.now() + 1500;
  plugin.codeLinkSuppressTarget = normalizeLocalCodeLinkHref(linkTarget || "");
}

function suppressLocalCodeLinkFollowup(plugin: any, linkTarget: string, event: MouseEvent, phase: string) {
  if (!plugin.codeLinkSuppressUntilMs || Date.now() > plugin.codeLinkSuppressUntilMs) return false;

  const normalized = normalizeLocalCodeLinkHref(linkTarget || "");
  if (plugin.codeLinkSuppressTarget && normalized && normalized !== plugin.codeLinkSuppressTarget) return false;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  plugin.debugLog("code_link.followup_suppressed", {
    phase,
    linkTarget,
  });
  return true;
}

function localCodeLinkTargetFromEditorEvent(event: MouseEvent, view: any) {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target && target.closest("a[href], a[data-href], a[data-amo-code-link]");
  if (anchor instanceof HTMLElement) {
    const rawHref =
      anchor.getAttribute("data-amo-code-link") ||
      anchor.getAttribute("data-href") ||
      anchor.getAttribute("href") ||
      (anchor instanceof HTMLAnchorElement ? anchor.href : "") ||
      "";
    if (looksLikeLocalCodeLinkCandidate(rawHref)) return rawHref;
  }

  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return "";

  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  return findLocalCodeLinkTargetInLine(line.text, offset);
}

async function openLocalCodeLink(plugin: any, link, rawHref: string) {
  await refreshCodeLinkSettingsFromDisk(plugin);
  const editor = normalizeLocalCodeLinkEditor(plugin.settings.localCodeLinkEditor);
  const target = editor === "zed" ? formatZedCodeLinkTarget(link) : formatLocalCodeLinkUrl(link, plugin.settings.localCodeLinkUrlTemplate);
  plugin.debugLog("code_link.open", {
    rawHref,
    editor,
    filePath: link.filePath,
    line: link.line,
    column: link.column,
    target,
  });

  try {
    if (editor === "zed") {
      await openZedCodeLink(link, plugin.settings.zedCommand);
    } else {
      await openExternalCodeUrl(target);
    }
    plugin.setOperationStatus("Opened code link: " + link.filePath + ":" + link.line, "success");
  } catch (error) {
    console.error("Failed to open code link:", error);
    plugin.debugLog("code_link.open_error", {
      rawHref,
      editor,
      filePath: link.filePath,
      line: link.line,
      column: link.column,
      target,
      message: messageFromError(error),
    });
    new Notice("Could not open code link: " + messageFromError(error));
  }
}

async function refreshCodeLinkSettingsFromDisk(plugin: any) {
  try {
    const data = (await plugin.loadData()) || {};
    if (!data || typeof data !== "object") return;
    if (typeof data.interceptLocalCodeLinks === "boolean") plugin.settings.interceptLocalCodeLinks = data.interceptLocalCodeLinks;
    if (typeof data.localCodeLinkEditor === "string") plugin.settings.localCodeLinkEditor = data.localCodeLinkEditor;
    if (typeof data.localCodeLinkUrlTemplate === "string") plugin.settings.localCodeLinkUrlTemplate = data.localCodeLinkUrlTemplate;
    if (typeof data.zedCommand === "string") plugin.settings.zedCommand = data.zedCommand;
  } catch (error) {
    plugin.debugLog("code_link.settings_reload_error", {
      message: messageFromError(error),
    });
  }
}
