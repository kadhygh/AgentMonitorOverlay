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
  return Array.from(markdown.matchAll(ANNO_REGEX))
    .map((match) => normalizeAnnotationContent(match[1] || ""))
    .filter((content) => content.length > 0);
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

