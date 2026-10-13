// The Electron side of the scratchpad (preload `window.amo.scratchpad`); absent in a plain browser, where the UI
// still works but has no window to open and no global shortcut.

/** What the global shortcut is doing (app/src/scratchpad-window.ts). */
export interface ShortcutStatus {
  wanted: string;
  active: string;
  error: string | null;
}

export interface ScratchpadBridge {
  open(): Promise<void>;
  hide(): void;
  applyShortcut(): Promise<ShortcutStatus>;
  shortcutStatus(): Promise<ShortcutStatus>;
}

export function scratchpadBridge(): ScratchpadBridge | null {
  return (window.amo as { scratchpad?: ScratchpadBridge } | undefined)?.scratchpad ?? null;
}
