import { extractAnnotationItems, normalizeAnnotationContent } from "./syntax";

export function findUnannotatedMarkdownRange(markdown, selectedText) {
  const source = String(markdown || "").replace(/\r\n?/gu, "\n");
  const content = normalizeAnnotationContent(selectedText);
  if (!source || !content) return null;

  const exact = findUnannotatedExactRange(source, content);
  if (exact) return exact;

  return findUnannotatedWhitespaceRange(source, content);
}

export function findUnannotatedExactRange(source, content) {
  let offset = 0;
  while (offset <= source.length) {
    const index = source.indexOf(content, offset);
    if (index < 0) return null;
    const range = { start: index, end: index + content.length };
    if (!rangeIntersectsAnnotation(source, range)) return range;
    offset = index + Math.max(1, content.length);
  }
  return null;
}

export function findUnannotatedWhitespaceRange(source, content) {
  const haystack = normalizeTextWithOffsetMap(source);
  const needle = normalizeSearchText(content);
  if (!needle) return null;

  let offset = 0;
  while (offset <= haystack.text.length) {
    const index = haystack.text.indexOf(needle, offset);
    if (index < 0) return null;
    const endIndex = index + needle.length - 1;
    const range = {
      start: haystack.startOffsets[index],
      end: haystack.endOffsets[endIndex],
    };
    if (!rangeIntersectsAnnotation(source, range)) return range;
    offset = index + Math.max(1, needle.length);
  }
  return null;
}

export function normalizeTextWithOffsetMap(value) {
  const source = String(value || "").replace(/\r\n?/gu, "\n");
  const chars = [];
  const startOffsets = [];
  const endOffsets = [];
  let pendingWhitespaceStart = -1;
  let pendingWhitespaceEnd = -1;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/u.test(char)) {
      if (pendingWhitespaceStart < 0) pendingWhitespaceStart = index;
      pendingWhitespaceEnd = index + 1;
      continue;
    }

    if (pendingWhitespaceStart >= 0 && chars.length > 0) {
      chars.push(" ");
      startOffsets.push(pendingWhitespaceStart);
      endOffsets.push(pendingWhitespaceEnd);
    }
    pendingWhitespaceStart = -1;
    pendingWhitespaceEnd = -1;

    chars.push(char);
    startOffsets.push(index);
    endOffsets.push(index + 1);
  }

  return {
    text: chars.join(""),
    startOffsets,
    endOffsets,
  };
}

export function normalizeSearchText(value) {
  return normalizeAnnotationContent(value).replace(/\s+/gu, " ");
}

export function rangeIntersectsAnnotation(markdown, range) {
  return extractAnnotationItems(markdown).some((item) => {
    return range.start < item.endOffset && item.startOffset < range.end;
  });
}

export function endOfLineOffset(markdown, offset) {
  const source = String(markdown || "");
  const safeOffset = Math.max(0, Math.min(source.length, Number(offset) || 0));
  const nextLineBreak = source.indexOf("\n", safeOffset);
  return nextLineBreak >= 0 ? nextLineBreak : source.length;
}

export function editorPositionToOffset(markdown, position) {
  const source = String(markdown || "").replace(/\r\n?/gu, "\n");
  const targetLine = Math.max(0, Number(position && position.line) || 0);
  const targetCh = Math.max(0, Number(position && position.ch) || 0);
  let offset = 0;
  const lines = source.split("\n");
  for (let line = 0; line < Math.min(targetLine, lines.length); line += 1) {
    offset += lines[line].length + 1;
  }
  return Math.min(source.length, offset + targetCh);
}

export function editorOffsetToPosition(markdown, offset) {
  const source = String(markdown || "").replace(/\r\n?/gu, "\n");
  const safeOffset = Math.max(0, Math.min(source.length, Number(offset) || 0));
  let line = 0;
  let lastLineStart = 0;
  for (let index = 0; index < safeOffset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lastLineStart = index + 1;
    }
  }
  return {
    line,
    ch: safeOffset - lastLineStart,
  };
}
