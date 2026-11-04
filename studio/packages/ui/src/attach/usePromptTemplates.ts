import type { PromptTemplate } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

/**
 * 提示词模板 (2026-10-31), live: those a composer in this project offers (the global ones and the project's; only the
 * global ones for null). Reloaded when one changes anywhere (an agent may add one meanwhile) or the socket reconnects.
 */
export function usePromptTemplates(link: HostLink, workspaceId: string | null): PromptTemplate[] | null {
  const [templates] = useLiveResource<PromptTemplate[] | null>(
    {
      load: link.url ? () => call(link, "GET /api/prompt-templates", {}, undefined, { workspace: workspaceId ?? "global" }) : null,
      initial: null,
      reloadOn: (e) => e.type === "prompt-templates.changed",
    },
    [link, workspaceId],
  );
  return templates;
}
