import { DEFAULT_SETTINGS } from "./constants";

export function joinUrl(root, path) {
  return String(root || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/u, "") + path;
}

export async function fetchJson(url) {
  if (typeof fetch !== "function") throw new Error("fetch is unavailable in this Obsidian runtime");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok === false) {
      throw new Error((body && body.message) || "AMO bridge returned " + response.status);
    }
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function postJson(url, payload) {
  if (typeof fetch !== "function") throw new Error("fetch is unavailable in this Obsidian runtime");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok === false) {
      throw new Error((body && body.message) || "AMO bridge returned " + response.status);
    }
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function postDebugLog(url, payload) {
  if (typeof fetch !== "function") return;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Debug logging is best-effort and must never break Obsidian actions.
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function writeTextToClipboard(value) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    throw new Error("Clipboard API is unavailable");
  }
  await navigator.clipboard.writeText(value);
}

