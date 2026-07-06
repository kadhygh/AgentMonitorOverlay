import { invoke } from "@tauri-apps/api/core";

export type ScratchpadShortcutButton = "mouse4" | "mouse5";

export interface ScratchpadShortcutState {
  enabled: boolean;
  button: ScratchpadShortcutButton;
}

export interface ScratchpadShortcutResult {
  ok: boolean;
  enabled: boolean;
  button: ScratchpadShortcutButton;
  message: string;
}

const SCRATCHPAD_SHORTCUT_STORAGE_KEY = "amo.scratchpad.shortcut";

export function loadScratchpadShortcutState(): ScratchpadShortcutState {
  try {
    const raw = localStorage.getItem(SCRATCHPAD_SHORTCUT_STORAGE_KEY);
    if (!raw) return { enabled: true, button: "mouse4" };
    const parsed = JSON.parse(raw) as Partial<ScratchpadShortcutState>;
    return {
      enabled: parsed.enabled !== false,
      button: "mouse4",
    };
  } catch {
    return { enabled: true, button: "mouse4" };
  }
}

export function saveScratchpadShortcutState(next: ScratchpadShortcutState) {
  localStorage.setItem(SCRATCHPAD_SHORTCUT_STORAGE_KEY, JSON.stringify(next));
}

export async function applyScratchpadShortcutState(next: ScratchpadShortcutState) {
  return invoke<ScratchpadShortcutResult>("set_scratchpad_shortcut_config", { config: next });
}
