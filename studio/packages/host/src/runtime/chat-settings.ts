import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// Conversation settings (stage 12, S12-E), kept in the Host's kv table: read by the runtimes when a session starts,
// written by the cli feature (设置 → 界面).

const KEY = "chat.settings";

export function readChatSettings(store: Store): ChatSettings {
  try {
    const raw = JSON.parse(store.getKv(KEY)?.value ?? "{}") as Partial<ChatSettings>;
    return { promptSuggestions: typeof raw.promptSuggestions === "boolean" ? raw.promptSuggestions : DEFAULT_CHAT_SETTINGS.promptSuggestions };
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

export function writeChatSettings(store: Store, settings: ChatSettings): ChatSettings {
  store.setKv(KEY, JSON.stringify(settings));
  return settings;
}
