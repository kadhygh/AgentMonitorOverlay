import type { StudioSettings } from "@amo-studio/protocol";
import { call } from "../host/client.js";
import { sharedLive } from "../host/shared.js";

/**
 * Studio-wide settings from the Host, kept live: one copy per window (host/shared.ts), read again after a reconnect.
 * Here rather than in SettingsDialog so the chat, the board and Focus do not pull in the dialog for it (2026-11-04).
 */
export const useSettings = sharedLive<StudioSettings>((link) => ({
  load: () => call(link, "GET /api/settings"),
  onEvent: (cur, e) => (e.type === "settings.updated" ? e.settings : cur),
}));
