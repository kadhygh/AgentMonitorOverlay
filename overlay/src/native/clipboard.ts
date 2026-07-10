import { invoke } from "@tauri-apps/api/core";
import type { OpenPathResult } from "../types";

const CLI_SAFE_PASTE_STORAGE_KEY = "amo.clipboard.safePaste";

export function loadCliSafePasteEnabled() {
  return localStorage.getItem(CLI_SAFE_PASTE_STORAGE_KEY) !== "false";
}

export function saveCliSafePasteEnabled(enabled: boolean) {
  localStorage.setItem(CLI_SAFE_PASTE_STORAGE_KEY, enabled ? "true" : "false");
}

export function toCliPasteClipboardText(text: string, safePaste = true) {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/g, "");

  if (safePaste) {
    return normalized.replace(/[ \t]*\n+[ \t]*/g, " ");
  }

  return normalized.replace(/\n/g, "\r\n");
}

export async function writeClipboardText(text: string): Promise<OpenPathResult> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return {
        ok: true,
        message: "Copied text to clipboard.",
      };
    } catch {
      // Fall back to the native clipboard path below.
    }
  }

  return invoke<OpenPathResult>("write_clipboard_text", { text });
}
