import { MarkdownRenderChild, MarkdownRenderer } from "obsidian";
import { ANNO_TAG_PREFIX, ANNO_TAG_SUFFIX, ANNOTATION_DEFAULT_LABEL, EMPTY_ANNO_TEXT } from "../core/constants";
import { messageFromError } from "../core/ui-utils";
import { normalizeAnnotationContent } from "./syntax";

export class LegacyAnnotationBlockRenderChild extends MarkdownRenderChild {
  plugin: any;
  content: string;
  sourcePath: string;

  constructor(containerEl: HTMLElement, plugin: any, content: string, sourcePath?: string) {
    super(containerEl);
    this.plugin = plugin;
    this.content = content;
    this.sourcePath = sourcePath || "";
  }

  onload() {
    this.containerEl.empty();
    this.containerEl.addClass("amo-legacy-annotation-section");

    const wrapper = createAnnotationRichShell();
    const body = wrapper.querySelector(".anno-token-content") as HTMLElement | null;
    this.containerEl.appendChild(wrapper);

    if (!body) return;
    if (normalizeAnnotationContent(this.content).length === 0) {
      body.textContent = EMPTY_ANNO_TEXT;
      return;
    }

    void renderNestedMarkdown(this.plugin.app, this.content, body, this.sourcePath, this).catch((error) => {
      body.textContent = normalizeAnnotationContent(this.content) || EMPTY_ANNO_TEXT;
      this.plugin.debugLog("render.legacy_render_error", {
        sourcePath: this.sourcePath,
        message: messageFromError(error),
      });
    });
  }

  onunload() {
    this.containerEl.removeClass("amo-legacy-annotation-section");
  }
}

export class LegacyAnnotationHiddenSectionRenderChild extends MarkdownRenderChild {
  onload() {
    this.containerEl.empty();
    this.containerEl.addClass("amo-legacy-annotation-hidden-section");
  }

  onunload() {
    this.containerEl.removeClass("amo-legacy-annotation-hidden-section");
  }
}

export function createAnnotationRichShell(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.classList.add("anno-token", "anno-token-block", "anno-token-rich");
  wrapper.setAttribute("data-amo-annotation", "rich");

  const badge = document.createElement("span");
  badge.classList.add("anno-token-badge");
  badge.textContent = ANNOTATION_DEFAULT_LABEL;
  wrapper.appendChild(badge);

  const body = document.createElement("div");
  body.classList.add("anno-token-content");
  wrapper.appendChild(body);

  return wrapper;
}

export function parseLegacyAnnotationBlocks(markdown: string) {
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] || "";
    const startIndex = line.indexOf(ANNO_TAG_PREFIX);
    if (startIndex < 0 || line.slice(0, startIndex).trim().length > 0) {
      lineIndex += 1;
      continue;
    }

    const contentLines = [];
    const afterStart = line.slice(startIndex + ANNO_TAG_PREFIX.length);
    const sameLineEnd = afterStart.indexOf(ANNO_TAG_SUFFIX);
    if (sameLineEnd >= 0) {
      if (afterStart.slice(sameLineEnd + ANNO_TAG_SUFFIX.length).trim().length > 0) {
        lineIndex += 1;
        continue;
      }
      contentLines.push(afterStart.slice(0, sameLineEnd));
      blocks.push({
        startLine: lineIndex,
        endLine: lineIndex,
        ownerLine: lineIndex,
        content: normalizeLegacyAnnotationBody(contentLines),
      });
      lineIndex += 1;
      continue;
    }

    contentLines.push(afterStart);
    let endLine = -1;
    for (let cursor = lineIndex + 1; cursor < lines.length; cursor += 1) {
      const endIndex = lines[cursor].indexOf(ANNO_TAG_SUFFIX);
      if (endIndex < 0) {
        contentLines.push(lines[cursor]);
        continue;
      }

      if (lines[cursor].slice(endIndex + ANNO_TAG_SUFFIX.length).trim().length > 0) {
        break;
      }
      contentLines.push(lines[cursor].slice(0, endIndex));
      endLine = cursor;
      break;
    }

    if (endLine >= 0) {
      blocks.push({
        startLine: lineIndex,
        endLine,
        ownerLine: findLegacyAnnotationOwnerLine(lines, lineIndex, endLine, afterStart),
        content: normalizeLegacyAnnotationBody(contentLines),
      });
      lineIndex = endLine + 1;
      continue;
    }

    lineIndex += 1;
  }

  return blocks;
}

export function normalizeLegacyAnnotationBody(lines: string[]) {
  return String(Array.isArray(lines) ? lines.join("\n") : lines || "")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "");
}

export function findLegacyAnnotationOwnerLine(lines: string[], startLine: number, endLine: number, afterStart: string) {
  if (normalizeAnnotationContent(afterStart).length > 0) return startLine;

  for (let lineIndex = startLine + 1; lineIndex <= endLine; lineIndex += 1) {
    const rawLine = String(lines[lineIndex] || "");
    const suffixIndex = rawLine.indexOf(ANNO_TAG_SUFFIX);
    const content = suffixIndex >= 0 ? rawLine.slice(0, suffixIndex) : rawLine;
    if (normalizeAnnotationContent(content).length > 0) return lineIndex;
  }

  return startLine;
}

export function findLegacyAnnotationBlockForSection(blocks: any[], section: any) {
  const lineStart = Number(section && section.lineStart);
  const lineEnd = Number(section && section.lineEnd);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return null;

  for (const block of blocks || []) {
    if (!lineRangesOverlap(lineStart, lineEnd, block.startLine, block.endLine)) continue;
    return Object.assign(
      {
        role: lineRangesOverlap(lineStart, lineEnd, block.ownerLine, block.ownerLine) ? "start" : "hidden",
      },
      block
    );
  }

  return null;
}

export function lineRangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart <= bEnd && bStart <= aEnd;
}

export async function renderNestedMarkdown(app: any, markdown: string, element: HTMLElement, sourcePath: string, component: any) {
  if (MarkdownRenderer && typeof MarkdownRenderer.render === "function") {
    await MarkdownRenderer.render(app, markdown, element, sourcePath, component);
    return;
  }

  if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === "function") {
    await MarkdownRenderer.renderMarkdown(markdown, element, sourcePath, component);
    return;
  }

  element.textContent = normalizeAnnotationContent(markdown) || EMPTY_ANNO_TEXT;
}
