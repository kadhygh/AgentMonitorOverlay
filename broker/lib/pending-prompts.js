const crypto = require("crypto");
const { normalizeInteger, normalizeText } = require("./normalize");

const DEFAULT_PROMPT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

function normalizeAnnotations(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        const content = normalizeText(item);
        return content ? { index: index + 1, content } : null;
      }

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const content = normalizeText(item.content || item.text || item.body || item.annotation);
      if (!content) {
        return null;
      }

      return {
        index: normalizeInteger(item.index) || index + 1,
        content,
      };
    })
    .filter(Boolean);
}

function renderPendingPrompt(payload, annotations, summary) {
  const lines = [];
  const cleanSummary = normalizeText(summary);
  if (cleanSummary) {
    lines.push(cleanSummary);
  }

  const numberAnnotations = shouldNumberAnnotations(payload);
  for (const annotation of annotations) {
    lines.push(numberAnnotations ? `${annotation.index}. ${annotation.content}` : annotation.content);
  }

  return `${lines.join("\n\n")}\n`;
}

function shouldNumberAnnotations(payload) {
  const options = payload && typeof payload.promptOptions === "object" ? payload.promptOptions : {};
  if (typeof options.numberAnnotations === "boolean") return options.numberAnnotations;
  if (typeof options.number_annotations === "boolean") return options.number_annotations;
  if (typeof payload?.numberAnnotations === "boolean") return payload.numberAnnotations;
  if (typeof payload?.number_annotations === "boolean") return payload.number_annotations;
  if (typeof payload?.includeAnnotationNumbers === "boolean") return payload.includeAnnotationNumbers;
  if (typeof payload?.include_annotation_numbers === "boolean") return payload.include_annotation_numbers;
  return false;
}

function promptContentHash(value) {
  return crypto.createHash("sha1").update(normalizeText(value)).digest("hex");
}

function findDuplicatePrompt(existing, record, duplicateWindowMs = DEFAULT_PROMPT_DUPLICATE_WINDOW_MS) {
  if (!existing || existing.lastPromptHash !== record.promptHash) {
    return null;
  }

  if (
    record.pendingPromptId &&
    existing.lastPromptPendingPromptId &&
    record.pendingPromptId === existing.lastPromptPendingPromptId
  ) {
    return {
      notePath: existing.lastPromptNote,
      noteAbsolutePath: existing.lastPromptNoteAbsolutePath,
      canvasNodeId: existing.lastPromptCanvasNodeId,
    };
  }

  const existingAt = Date.parse(existing.lastPromptAt || "");
  const nextAt = Date.parse(record.capturedAt || "");
  const closeEnough =
    Number.isFinite(existingAt) &&
    Number.isFinite(nextAt) &&
    Math.abs(nextAt - existingAt) <= duplicateWindowMs;
  if (closeEnough && existing.lastPromptSource === "amo-sync-back" && record.source !== "amo-sync-back") {
    return {
      notePath: existing.lastPromptNote,
      noteAbsolutePath: existing.lastPromptNoteAbsolutePath,
      canvasNodeId: existing.lastPromptCanvasNodeId,
    };
  }

  return null;
}

module.exports = {
  DEFAULT_PROMPT_DUPLICATE_WINDOW_MS,
  findDuplicatePrompt,
  normalizeAnnotations,
  promptContentHash,
  renderPendingPrompt,
  shouldNumberAnnotations,
};
