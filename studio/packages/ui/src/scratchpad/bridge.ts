// The Electron side of the scratchpad (preload `window.amo.scratchpad`); absent in a plain browser, where the UI
// still works but has no window to open and no global shortcut. Since 2026-10-23 the 便签 is a program of its own
// (packages/notes): inside it the window hides itself and registers the shortcut; inside Studio the bridge brings
// that program up (starting it when it is not running) and opens its settings.

import type { TodoLink, TodoView } from "@amo-studio/protocol";

/** What the global shortcut is doing (packages/notes/src/main.ts). */
export interface ShortcutStatus {
  wanted: string;
  active: string;
  error: string | null;
}

/** The 便签 program as Studio sees it (app/src/notes-link.ts). */
export interface NotesStatus {
  running: boolean;
  active?: string;
  wanted?: string;
  error?: string | null;
}

export interface ScratchpadBridge {
  /** Shows the 便签 window (in Studio: brings up the program, starting it). */
  open(): Promise<void>;
  /** The 便签 window hides itself. */
  hide?(): void;
  applyShortcut?(): Promise<ShortcutStatus>;
  shortcutStatus?(): Promise<ShortcutStatus>;
  /** Studio: whether the program runs, and its shortcut. */
  notesStatus?(): Promise<NotesStatus>;
  /** Studio: starts it (in the tray) when it is not running. */
  startNotes?(): Promise<NotesStatus>;
  /** Studio: opens the program's settings window. */
  openNotesSettings?(): Promise<void>;
  /** Studio: the program's 待办 (starting it in the tray), for binding an item to a task (问题 #10). */
  todo?(): Promise<TodoView>;
  /** Studio: binds a 待办 item to a task (null: unbinds it). */
  bindTodo?(id: string, link: TodoLink | null): Promise<TodoView>;
}

export function scratchpadBridge(): ScratchpadBridge | null {
  return (window.amo as { scratchpad?: ScratchpadBridge } | undefined)?.scratchpad ?? null;
}
