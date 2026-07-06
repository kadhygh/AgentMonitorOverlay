import { invoke } from "@tauri-apps/api/core";
import type { OpenPathResult } from "../types";

export function toCliPasteClipboardText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/g, "")
    .replace(/\n/g, "\r\n");
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
