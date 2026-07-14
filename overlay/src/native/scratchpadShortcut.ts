import { invoke } from "@tauri-apps/api/core";

export type ScratchpadShortcut =
  | "ctrl+mouse4"
  | "mouse4"
  | "ctrl+mouse5"
  | "mouse5"
  | "ctrl+alt+z"
  | "ctrl+alt+space";

export interface ScratchpadShortcutState {
  enabled: boolean;
  shortcut: ScratchpadShortcut;
}

export interface ScratchpadShortcutResult {
  ok: boolean;
  enabled: boolean;
  shortcut: ScratchpadShortcut;
  message: string;
}

const SCRATCHPAD_SHORTCUT_STORAGE_KEY = "amo.scratchpad.shortcut";
const VALID_SHORTCUTS = new Set<ScratchpadShortcut>([
  "ctrl+mouse4",
  "mouse4",
  "ctrl+mouse5",
  "mouse5",
  "ctrl+alt+z",
  "ctrl+alt+space",
]);

function defaultScratchpadShortcutState(): ScratchpadShortcutState {
  const personalProfile = import.meta.env.VITE_AMO_SHORTCUT_PROFILE === "kadhygh";
  return {
    enabled: personalProfile,
    shortcut: personalProfile ? "ctrl+mouse4" : "ctrl+alt+space",
  };
}

export function loadScratchpadShortcutState(): ScratchpadShortcutState {
  try {
    const raw = localStorage.getItem(SCRATCHPAD_SHORTCUT_STORAGE_KEY);
    if (!raw) return defaultScratchpadShortcutState();
    const parsed = JSON.parse(raw) as Partial<ScratchpadShortcutState> & { button?: string };
    const migratedShortcut = parsed.button === "mouse5" ? "ctrl+mouse5" : "ctrl+mouse4";
    const shortcut = VALID_SHORTCUTS.has(parsed.shortcut as ScratchpadShortcut)
      ? (parsed.shortcut as ScratchpadShortcut)
      : migratedShortcut;
    return {
      enabled: parsed.enabled !== false,
      shortcut,
    };
  } catch {
    return defaultScratchpadShortcutState();
  }
}

export function scratchpadShortcutLabel(state: ScratchpadShortcutState) {
  if (!state.enabled) return "Disabled";
  const labels: Record<ScratchpadShortcut, string> = {
    "ctrl+mouse4": "Ctrl + Mouse4",
    mouse4: "Mouse4",
    "ctrl+mouse5": "Ctrl + Mouse5",
    mouse5: "Mouse5",
    "ctrl+alt+z": "Ctrl + Alt + Z",
    "ctrl+alt+space": "Ctrl + Alt + Space",
  };
  return labels[state.shortcut];
}

export function saveScratchpadShortcutState(next: ScratchpadShortcutState) {
  localStorage.setItem(SCRATCHPAD_SHORTCUT_STORAGE_KEY, JSON.stringify(next));
}

export async function applyScratchpadShortcutState(next: ScratchpadShortcutState) {
  return invoke<ScratchpadShortcutResult>("set_scratchpad_shortcut_config", { config: next });
}
