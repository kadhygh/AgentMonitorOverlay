import { normalizeVaultFilePath } from "../core/paths";
import { describeElement, previewText, rootContainsAnnotationMarkers } from "../core/ui-utils";
import {
  findLegacyAnnotationBlockForSection as findLegacyAnnotationBlockForSectionFromBlocks,
  linkifyLocalCodeLinks,
  parseLegacyAnnotationBlocks,
  replaceInlineAnnotations,
  LegacyAnnotationBlockRenderChild,
  LegacyAnnotationHiddenSectionRenderChild,
} from "./render";

export async function renderAnnotations(plugin, root, context) {
  await plugin.renderAmoNoteDisplayHeader(root, context);

  if (await renderLegacyAnnotationSection(plugin, root, context)) return;

  if (rootContainsAnnotationMarkers(root)) {
    plugin.debugLog("render.postprocessor", {
      root: describeElement(root),
      preview: previewText(root.textContent || ""),
    });
  }

  replaceInlineAnnotations(root);
  if (plugin.settings.interceptLocalCodeLinks !== false) linkifyLocalCodeLinks(root);
}

export async function renderLegacyAnnotationSection(plugin, root, context) {
  if (!(root instanceof HTMLElement) || !context || typeof context.getSectionInfo !== "function") return false;

  const section = context.getSectionInfo(root);
  if (!section || typeof section.text !== "string") return false;

  const block = await findLegacyAnnotationBlockForSection(plugin, context.sourcePath, section);
  if (!block) return false;
  if (!root.isConnected) return true;

  if (block.role === "start") {
    plugin.debugLog("render.legacy_section", {
      role: "start",
      sourcePath: context.sourcePath,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
      annotationStart: block.startLine,
      annotationEnd: block.endLine,
      ownerLine: block.ownerLine,
      preview: previewText(block.content),
    });
    context.addChild(new LegacyAnnotationBlockRenderChild(root, plugin, block, context.sourcePath));
    return true;
  }

  plugin.debugLog("render.legacy_section", {
    role: "hidden",
    sourcePath: context.sourcePath,
    lineStart: section.lineStart,
    lineEnd: section.lineEnd,
    annotationStart: block.startLine,
    annotationEnd: block.endLine,
    ownerLine: block.ownerLine,
  });
  context.addChild(new LegacyAnnotationHiddenSectionRenderChild(root));
  return true;
}

export async function findLegacyAnnotationBlockForSection(plugin, sourcePath, section) {
  const file = sourcePath ? plugin.app.vault.getAbstractFileByPath(normalizeVaultFilePath(sourcePath)) : null;
  if (!file || typeof file.path !== "string") return null;

  let markdown = "";
  try {
    markdown = await plugin.app.vault.cachedRead(file as any);
  } catch {
    return null;
  }

  return findLegacyAnnotationBlockForSectionFromBlocks(parseLegacyAnnotationBlocks(markdown), section);
}
