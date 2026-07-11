import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { OpenPathResult } from "../types";

export const WINDOWS_NOTIFICATIONS_CHANGED_EVENT = "amo-windows-notifications-changed";

const WINDOWS_NOTIFICATIONS_STORAGE_KEY = "amo.notifications.windows.enabled";
const AMO_WINDOW_LABELS = ["main", "settings"];

export interface WindowsNotificationsChangedEvent {
  enabled: boolean;
}

export function loadWindowsNotificationsEnabled() {
  try {
    return localStorage.getItem(WINDOWS_NOTIFICATIONS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export async function saveWindowsNotificationsEnabled(enabled: boolean) {
  try {
    localStorage.setItem(WINDOWS_NOTIFICATIONS_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // The current window still receives the in-memory state update.
  }

  const payload = { enabled } satisfies WindowsNotificationsChangedEvent;
  await Promise.all(
    AMO_WINDOW_LABELS.map((label) =>
      getCurrentWindow()
        .emitTo(label, WINDOWS_NOTIFICATIONS_CHANGED_EVENT, payload)
        .catch(() => undefined),
    ),
  );
}

export async function showWindowsNotification(
  title: string,
  body: string,
): Promise<OpenPathResult> {
  try {
    return await invoke<OpenPathResult>("show_windows_notification", { title, body });
  } catch (error) {
    return {
      ok: false,
      message: `Windows notification failed: ${(error as Error).message}`,
    };
  }
}
