const { normalizeText } = require("./normalize");

function normalizeNoteDisplayTitle(value) {
  return String(normalizeText(value) || "")
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/u, "")
    .trim()
    .slice(0, 120);
}

function sanitizeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function sanitizeObsidianFileNamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function trimMessage(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

module.exports = {
  normalizeNoteDisplayTitle,
  sanitizeFilePart,
  sanitizeObsidianFileNamePart,
  trimMessage,
};
