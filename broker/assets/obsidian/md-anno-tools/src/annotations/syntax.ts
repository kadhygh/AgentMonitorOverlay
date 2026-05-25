import { ANNO_REGEX, ANNO_TAG_PREFIX, ANNO_TAG_SUFFIX, ANNOTATION_DEFAULT_LABEL, EMPTY_ANNO_TEXT } from "../core/constants";

export function buildAnnotationMarkup(content) {
  return ANNO_TAG_PREFIX + sanitizeAnnotationContent(content) + ANNO_TAG_SUFFIX;
}

export function buildReferencedAnnotationMarkup(reference) {
  return ANNO_TAG_PREFIX + "\n" + formatMarkdownQuote(reference) + "\n\n" + ANNO_TAG_SUFFIX;
}

export function insertReferencedAnnotation(editor, selection) {
  const reference = normalizeAnnotationContent(selection);
  if (!reference) {
    const cursor = editor.getCursor();
    editor.replaceSelection(ANNO_TAG_PREFIX + ANNO_TAG_SUFFIX);
    editor.setCursor({
      line: cursor.line,
      ch: cursor.ch + ANNO_TAG_PREFIX.length,
    });
    return;
  }

  const to = editor.getCursor("to") || editor.getCursor();
  const targetLine = Number.isSafeInteger(to.line) ? to.line : editor.getCursor().line;
  const lineText = typeof editor.getLine === "function" ? editor.getLine(targetLine) || "" : "";
  const insertAt = {
    line: targetLine,
    ch: lineText.length,
  };
  const leading = lineText.trim().length > 0 ? "\n\n" : "";
  const quote = formatMarkdownQuote(reference);
  const block = leading + ANNO_TAG_PREFIX + "\n" + quote + "\n\n" + ANNO_TAG_SUFFIX;
  const beforeAnswer = leading + ANNO_TAG_PREFIX + "\n" + quote + "\n";

  editor.replaceRange(block, insertAt);
  editor.setCursor({
    line: insertAt.line + beforeAnswer.split("\n").length - 1,
    ch: 0,
  });
}

export function formatMarkdownQuote(content) {
  return sanitizeAnnotationContent(content)
    .split("\n")
    .map((line) => (line.length > 0 ? "> " + line : ">"))
    .join("\n");
}

export function sanitizeAnnotationContent(content) {
  return normalizeAnnotationContent(content).replaceAll(ANNO_TAG_SUFFIX, "[/ anno]");
}

export function extractAnnotationContents(markdown) {
  return extractAnnotationItems(markdown)
    .map((item) => item.content)
    .filter((content) => content.length > 0);
}

export function extractAnnotationItems(markdown) {
  const source = String(markdown || "");
  return Array.from(source.matchAll(ANNO_REGEX)).map((match, index) => {
    const startOffset = match.index || 0;
    const endOffset = startOffset + match[0].length;
    return {
      index: index + 1,
      content: normalizeAnnotationContent(match[1] || ""),
      raw: match[0],
      startOffset,
      endOffset,
      startLine: lineNumberAtOffset(source, startOffset),
      endLine: lineNumberAtOffset(source, Math.max(startOffset, endOffset - 1)),
    };
  });
}

export function findAnnotationItemAtOffset(markdown, offset) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  return (
    extractAnnotationItems(markdown).find((item) => {
      return item.startOffset <= safeOffset && safeOffset <= item.endOffset;
    }) || null
  );
}

export function removeAnnotationByIndex(markdown, index) {
  const source = String(markdown || "");
  const item = extractAnnotationItems(source).find((candidate) => candidate.index === index);
  if (!item) return { removed: false, markdown: source, item: null };

  const range = annotationRemovalRange(source, item);
  const nextMarkdown = source.slice(0, range.startOffset) + source.slice(range.endOffset);
  return {
    removed: true,
    markdown: cleanupAnnotationRemovalWhitespace(nextMarkdown),
    item,
    range,
  };
}

export function annotationRemovalRange(markdown, item) {
  const source = String(markdown || "");
  const lineStart = source.lastIndexOf("\n", Math.max(0, item.startOffset - 1)) + 1;
  const nextLineBreak = source.indexOf("\n", item.endOffset);
  const lineEnd = nextLineBreak >= 0 ? nextLineBreak + 1 : source.length;
  const beforeOnLine = source.slice(lineStart, item.startOffset);
  const afterOnLine = source.slice(item.endOffset, nextLineBreak >= 0 ? nextLineBreak : source.length);

  if (beforeOnLine.trim().length === 0 && afterOnLine.trim().length === 0) {
    return {
      startOffset: lineStart,
      endOffset: lineEnd,
    };
  }

  return {
    startOffset: item.startOffset,
    endOffset: item.endOffset,
  };
}

export function lineNumberAtOffset(markdown, offset) {
  const source = String(markdown || "");
  const safeOffset = Math.max(0, Math.min(source.length, Number(offset) || 0));
  let line = 0;
  for (let index = 0; index < safeOffset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function cleanupAnnotationRemovalWhitespace(markdown) {
  return String(markdown || "").replace(/\n{4,}/gu, "\n\n\n");
}

export function normalizeAnnotationContent(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").trim();
}

export function formatAnnotationsForClipboard(annotations) {
  return annotations.join("\n\n");
}

export function createAnnotationElement(content, isStandalone) {
  const wrapper = document.createElement("span");
  wrapper.classList.add("anno-token");
  if (isStandalone) wrapper.classList.add("anno-token-block");

  const badge = document.createElement("span");
  badge.classList.add("anno-token-badge");
  badge.textContent = ANNOTATION_DEFAULT_LABEL;
  wrapper.appendChild(badge);

  const body = document.createElement("span");
  body.classList.add("anno-token-content");
  body.textContent = content || EMPTY_ANNO_TEXT;
  wrapper.appendChild(body);

  return wrapper;
}
