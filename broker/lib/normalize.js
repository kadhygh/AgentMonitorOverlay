function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeText).filter(Boolean);
}

function normalizeInteger(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

function normalizeVersionNumber(value) {
  if (Number.isInteger(value)) return value;
  const parsed = Number.parseInt(normalizeText(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  normalizeInteger,
  normalizeText,
  normalizeTextArray,
  normalizeVersionNumber,
};
