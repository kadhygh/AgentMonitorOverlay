import { useEffect, useState } from "react";
import type { PromptTemplate } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/**
 * 提示词模板 (2026-10-31), live: those a composer in this project offers (the global ones and the project's; only the
 * global ones for null). Reloaded when one changes anywhere (an agent may add one meanwhile) or the socket reconnects.
 */
export function usePromptTemplates(link: HostLink, workspaceId: string | null): PromptTemplate[] | null {
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  useEffect(() => {
    if (!link.url) return;
    let live = true;
    const load = () =>
      call(link, "GET /api/prompt-templates", {}, undefined, { workspace: workspaceId ?? "global" })
        .then((t) => live && setTemplates(t))
        .catch(() => undefined);
    const offEvent = onHostEvent((e) => {
      if (e.type === "prompt-templates.changed") void load();
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
    return () => {
      live = false;
      offEvent();
      offReconnect();
    };
  }, [link, workspaceId]);
  return templates;
}
