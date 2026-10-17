import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadCard } from "../api/cardClient";
import { BROKER_SESSIONS_URL, getBrokerJson } from "../api/brokerClient";
import { createFocusCommandRouter } from "../runtime/focusCommandRouter";
import { getOrCreateUtilityWindow, openWorkspaceCenterForPath } from "./useMainUtilityWindows";
import { bringUtilityWindowToFront } from "../windows/utilityWindow";
import type { AgentSession } from "../types";

export function useTaskLaunchWindow(options: { activate: (session: AgentSession) => Promise<void>; feedback: (message: string) => void }) {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    let disposed = false;
    const stop: (() => void)[] = [];
    const route = createFocusCommandRouter({
      loadCard: async id => (await loadCard(id)).card,
      loadSession: async id => (await getBrokerJson<{ session: AgentSession }>(`${BROKER_SESSIONS_URL}/${encodeURIComponent(id)}`, { timeoutMs: 5000 })).session,
      revealMain: async () => { await getCurrentWindow().show(); },
      activate: session => latest.current.activate(session),
      resume: async () => { throw new Error("新任务入口不会隐式恢复或重启会话。"); },
    });
    const report = (reason: unknown) => latest.current.feedback(reason instanceof Error ? reason.message : String(reason));
    async function listen(name: string, handler: (payload: unknown) => Promise<void>) {
      try {
        const unlisten = await getCurrentWindow().listen(name, event => { if (!disposed) void handler(event.payload).catch(report); });
        if (disposed) unlisten(); else stop.push(unlisten);
      } catch (reason) { if (!disposed) report(reason); }
    }
    void listen("amo-task-launch-open", async () => { await getOrCreateUtilityWindow("task-launch"); await bringUtilityWindowToFront("task-launch"); });
    void listen("task-launch-open-focus", async () => { await getOrCreateUtilityWindow("focus"); await bringUtilityWindowToFront("focus"); });
    void listen("task-launch-open-workspaces", async payload => {
      const path = (payload as { workspacePath?: unknown } | null)?.workspacePath;
      if (path !== undefined && (typeof path !== "string" || path.length > 8192)) return;
      await openWorkspaceCenterForPath(typeof path === "string" ? path : "");
    });
    void listen("task-launch-open-session", async payload => {
      const request = payload as { cardId?: unknown; requestId?: unknown } | null;
      if (typeof request?.cardId !== "string" || request.cardId.length > 128 || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 128) return;
      let result;
      try {
        const { card } = await loadCard(request.cardId);
        const processing = card.components.find(c => c.type === "amo.processing" && c.schemaVersion === 1);
        const session = card.components.find(c => c.type === "amo.session" && c.schemaVersion === 1 && c.componentId === processing?.data.sourceComponentId);
        const conversation = card.components.find(c => c.type === "amo.conversation" && c.schemaVersion === 1 && c.data.sessionComponentId === session?.componentId);
        const ref = session?.data.sessionRef as { frameworkId?: string; sessionId?: string } | undefined;
        if (card.archivedAt || !session || !conversation || !ref?.sessionId || ref.frameworkId !== "codex") throw new Error("会话尚未接入或卡片关联已变化，请先刷新状态。");
        result = await route({ requestId: request.requestId, action: "activate", cardId: card.cardId, sessionComponentId: session.componentId, conversationComponentId: conversation.componentId, sessionId: ref.sessionId, frameworkId: ref.frameworkId });
      } catch (reason) { result = { requestId: request.requestId, ok: false, message: reason instanceof Error ? reason.message : String(reason) }; }
      if (!disposed) await getCurrentWindow().emitTo("task-launch", "task-launch-command-result", result);
    });
    return () => { disposed = true; stop.forEach(unlisten => unlisten()); };
  }, []);
}
