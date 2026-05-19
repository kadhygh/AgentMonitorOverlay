import { ANNO_TAG_PREFIX, ANNO_TAG_SUFFIX } from "./constants";
import { normalizeAnnotationContent } from "../annotations/syntax";

export function rootContainsAnnotationMarkers(root) {
  return Boolean(
    root &&
      typeof root.textContent === "string" &&
      (root.textContent.includes(ANNO_TAG_PREFIX) || root.textContent.includes(ANNO_TAG_SUFFIX))
  );
}

export function previewText(value, limit = 180) {
  const normalized = normalizeAnnotationContent(value || "");
  const maxLength = Number.isFinite(Number(limit)) ? Number(limit) : 180;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) + "..." : normalized;
}

export function describeElement(element) {
  if (!(element instanceof Element)) return "";
  const tag = element.tagName.toLowerCase();
  const id = element.id ? "#" + element.id : "";
  const classes = Array.from(element.classList || [])
    .slice(0, 6)
    .map((className) => "." + className)
    .join("");
  const path = element.getAttribute("data-path") || element.getAttribute("data-file") || "";
  return tag + id + classes + (path ? "[path=" + path + "]" : "");
}

export function getVaultRoot(app) {
  const adapter = app.vault.adapter;
  if (adapter && typeof adapter.getBasePath === "function") return adapter.getBasePath();
  return null;
}

export function getWindowSelectionText() {
  try {
    const selection = window.getSelection && window.getSelection();
    return normalizeAnnotationContent(selection ? selection.toString() : "");
  } catch {
    return "";
  }
}

export function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createInfoRow(container, label, value) {
  const row = container.createDiv({ cls: "amo-panel-info-row" });
  row.createEl("span", { text: label });
  row.createEl("code", { text: value || "-" });
  return row;
}

export function formatNoteTargetSource(source) {
  if (source === "active-note") return "Active note";
  if (source === "canvas-selection") return "Canvas selection";
  if (source === "last-note") return "Last note";
  return "Unknown";
}

export function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return "";
  }
}
