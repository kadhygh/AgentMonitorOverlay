import { MarkdownRenderChild, MarkdownRenderer } from "obsidian";
import { ANNO_REGEX, ANNO_TAG_PREFIX, ANNO_TAG_SUFFIX, ANNOTATION_DEFAULT_LABEL, EMPTY_ANNO_TEXT, SKIPPED_TAGS } from "../core/constants";
import { messageFromError } from "../core/ui-utils";
import {
  LOCAL_CODE_LINK_TEXT_REGEX,
  createLocalCodeLinkElement,
  parseLocalCodeLink,
} from "../editor/local-code-links";
import { createAnnotationElement, normalizeAnnotationContent } from "./syntax";

export class LegacyAnnotationBlockRenderChild extends MarkdownRenderChild {
  plugin: any;
  block: any;
  content: string;
  sourcePath: string;

  constructor(containerEl: HTMLElement, plugin: any, block: any, sourcePath?: string) {
    super(containerEl);
    this.plugin = plugin;
    this.block = block || {};
    this.content = this.block.content || "";
    this.sourcePath = sourcePath || "";
  }

  onload() {
    this.containerEl.empty();
    this.containerEl.addClass("amo-legacy-annotation-section");

    const wrapper = createAnnotationRichShell(() => {
      void this.plugin.deleteRenderedAnnotation(this.sourcePath, this.block);
    });
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

export function createAnnotationRichShell(onDelete?: () => void): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.classList.add("anno-token", "anno-token-block", "anno-token-rich");
  wrapper.setAttribute("data-amo-annotation", "rich");

  if (onDelete) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.classList.add("anno-token-delete");
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", "Delete annotation");
    deleteButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDelete();
    });
    wrapper.appendChild(deleteButton);
  }

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

export function replaceInlineAnnotations(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!(node instanceof Text)) return NodeFilter.FILTER_REJECT;
      if (!shouldProcessAnnotationTextNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const textNode of targets) replaceAnnotationsInTextNode(textNode);
}

export function linkifyLocalCodeLinks(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!(node instanceof Text)) return NodeFilter.FILTER_REJECT;
      if (!shouldProcessLocalCodeLinkTextNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const textNode of targets) replaceLocalCodeLinksInTextNode(textNode);
}

function shouldProcessAnnotationTextNode(textNode) {
  const text = textNode.nodeValue || "";
  if (!text.includes(ANNO_TAG_PREFIX) || !text.includes(ANNO_TAG_SUFFIX)) return false;
  const parent = textNode.parentElement;
  if (!parent || parent.closest(".anno-token")) return false;

  for (let current = parent; current; current = current.parentElement) {
    if (SKIPPED_TAGS.has(current.tagName)) return false;
  }
  return true;
}

function shouldProcessLocalCodeLinkTextNode(textNode) {
  const text = textNode.nodeValue || "";
  LOCAL_CODE_LINK_TEXT_REGEX.lastIndex = 0;
  const hasLink = LOCAL_CODE_LINK_TEXT_REGEX.test(text);
  LOCAL_CODE_LINK_TEXT_REGEX.lastIndex = 0;
  if (!hasLink) return false;
  const parent = textNode.parentElement;
  if (!parent || parent.closest(".amo-local-code-link")) return false;

  for (let current = parent; current; current = current.parentElement) {
    if (SKIPPED_TAGS.has(current.tagName)) return false;
  }
  return true;
}

function replaceAnnotationsInTextNode(textNode) {
  const source = textNode.nodeValue || "";
  const matches = Array.from(source.matchAll(ANNO_REGEX)) as RegExpMatchArray[];
  if (matches.length === 0) return;

  const fragment = document.createDocumentFragment();
  let currentIndex = 0;
  const firstMatch = matches[0];
  const isStandalone = matches.length === 1 && firstMatch && source.trim() === firstMatch[0].trim();

  for (const match of matches) {
    const fullMatch = match[0];
    const content = normalizeAnnotationContent(match[1] || "");
    const matchIndex = match.index || 0;

    if (matchIndex > currentIndex) fragment.append(source.slice(currentIndex, matchIndex));
    fragment.append(createAnnotationElement(content, isStandalone));
    currentIndex = matchIndex + fullMatch.length;
  }

  if (currentIndex < source.length) fragment.append(source.slice(currentIndex));
  textNode.replaceWith(fragment);
}

function replaceLocalCodeLinksInTextNode(textNode) {
  const source = textNode.nodeValue || "";
  const matches = Array.from(source.matchAll(LOCAL_CODE_LINK_TEXT_REGEX)) as RegExpMatchArray[];
  if (matches.length === 0) return;

  const fragment = document.createDocumentFragment();
  let currentIndex = 0;
  for (const match of matches) {
    const rawTarget = match[0] || "";
    const matchIndex = match.index || 0;
    const parsed = parseLocalCodeLink(rawTarget, rawTarget);
    if (!parsed || !parsed.line) continue;

    if (matchIndex > currentIndex) fragment.append(source.slice(currentIndex, matchIndex));
    fragment.append(createLocalCodeLinkElement(rawTarget));
    currentIndex = matchIndex + rawTarget.length;
  }

  if (currentIndex === 0) return;
  if (currentIndex < source.length) fragment.append(source.slice(currentIndex));
  textNode.replaceWith(fragment);
}
