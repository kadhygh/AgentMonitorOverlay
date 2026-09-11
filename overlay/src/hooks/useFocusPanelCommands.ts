import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BROKER_SESSIONS_URL, getBrokerJson } from "../api/brokerClient";
import { createFocusCommandRouter } from "../runtime/focusCommandRouter";
import type { AgentSession } from "../types";
import type { Card } from "../api/cardClient";

export function useFocusPanelCommands(options: {
  activate(session: AgentSession): Promise<void>;
  resume(session: AgentSession): Promise<void>;
}) {
  const current = useRef(options); current.current = options;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const route = createFocusCommandRouter({
      loadSession: async id => (await getBrokerJson<{ session: AgentSession }>(`${BROKER_SESSIONS_URL}/${encodeURIComponent(id)}`, { timeoutMs: 5000 })).session,
      loadCard: async id => (await getBrokerJson<{ card: Card }>(`http://127.0.0.1:17654/api/cards/${encodeURIComponent(id)}`, { timeoutMs: 5000 })).card,
      revealMain: async () => {
        await getCurrentWindow().unminimize();
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
      },
      activate: session => current.current.activate(session),
      resume: session => current.current.resume(session),
    });
    void getCurrentWindow().listen("amo-focus-session-command", event => {
      if (disposed) return;
      void route(event.payload).then(result => {
        if (!disposed) void getCurrentWindow().emitTo("focus", "amo-focus-session-command-result", result).catch(() => undefined);
      });
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);
}
