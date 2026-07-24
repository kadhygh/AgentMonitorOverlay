import { invoke } from "@tauri-apps/api/core";
import type { OpenPathResult } from "../types";

const CLI_SAFE_PASTE_STORAGE_KEY = "amo.clipboard.safePaste";
const BROWSER_CLIPBOARD_MAX_CHARS = 64 * 1024;
const BROWSER_CLIPBOARD_TIMEOUT_MS = 1_500;

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

async function tryWriteBrowserClipboardText(text: string) {
  if (!navigator.clipboard?.writeText) return false;

  let timeoutId: number | undefined;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error("Browser clipboard write timed out.")),
          BROWSER_CLIPBOARD_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export async function writeClipboardText(text: string): Promise<OpenPathResult> {
  if (text.length <= BROWSER_CLIPBOARD_MAX_CHARS && (await tryWriteBrowserClipboardText(text))) {
    return {
      ok: true,
      message: "Copied text to clipboard.",
    };
  }

  try {
    return await invoke<OpenPathResult>("write_clipboard_text", { text });
  } catch (error) {
    if (text.length > BROWSER_CLIPBOARD_MAX_CHARS && (await tryWriteBrowserClipboardText(text))) {
      return {
        ok: true,
        message: "Copied text to clipboard.",
      };
    }
    throw error;
  }
}
