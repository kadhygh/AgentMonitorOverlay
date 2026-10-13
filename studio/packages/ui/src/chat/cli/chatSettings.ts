import { useCallback, useEffect, useState } from "react";
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "@amo-studio/protocol";
import { call, type HostLink } from "../../host/client.js";

// The conversation settings kept by the Host (stage 12, S12-E): asked once per window, shared by every user of the
// hook in it (the settings dialog and the composers).

const EVENT = "amo:chat-settings";
let cached: ChatSettings | null = null;

export function useChatSettings(link: HostLink): { settings: ChatSettings; update(patch: Partial<ChatSettings>): Promise<void> } {
  const [settings, setSettings] = useState<ChatSettings>(cached ?? DEFAULT_CHAT_SETTINGS);
  useEffect(() => {
    let live = true;
    const onChange = (e: Event) => setSettings((e as CustomEvent<ChatSettings>).detail);
    window.addEventListener(EVENT, onChange);
    if (!cached && link.url) {
      call(link, "GET /api/settings/chat")
        .then((s) => {
          cached = s;
          if (live) setSettings(s);
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
      window.removeEventListener(EVENT, onChange);
    };
  }, [link]);
  const update = useCallback(
    async (patch: Partial<ChatSettings>) => {
      const next = await call(link, "PUT /api/settings/chat", {}, patch);
      cached = next;
      window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
    },
    [link],
  );
  return { settings, update };
}
