import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commandAvailable, type FocusCardView } from "./model";
import { FOCUS_CONVERSATION_ACTIONS, type FocusCommandAction } from "../runtime/focusCommandRouter";

export function useFocusCommands() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Record<string, { pending: boolean; message: string }>>({});
  const requests = useRef(new Map<string, { cardId: string; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    void listen<{ requestId: string; ok: boolean; message: string }>("amo-focus-session-command-result", event => {
      const request = requests.current.get(event.payload.requestId);
      if (!request) return;
      clearTimeout(request.timer); requests.current.delete(event.payload.requestId);
      setStatus(previous => ({ ...previous, [request.cardId]: { pending: false, message: event.payload.ok ? `Request delegated. ${event.payload.message || "Check the main AMO window for the result."}` : event.payload.message || "The request could not be delegated." } }));
    }).then(fn => { if (disposed) fn(); else { unlisten = fn; setReady(true); } }).catch(() => { if (!disposed) setReady(false); });
    return () => { disposed = true; unlisten?.(); for (const request of requests.current.values()) clearTimeout(request.timer); requests.current.clear(); };
  }, []);
  async function send(card: FocusCardView, action: FocusCommandAction) {
    if (!ready || !card.session || status[card.cardId]?.pending) return;
    const unavailable = (action === "activate" || action === "resume") ? !commandAvailable(card, action) : FOCUS_CONVERSATION_ACTIONS.includes(action) && (!card.conversation || card.conversation.sessionComponentId !== card.session.componentId);
    if (unavailable) {
      setStatus(previous => ({ ...previous, [card.cardId]: { pending: false, message: "This conversation action is unavailable. Refresh the card and check its conversation component." } }));
      return;
    }
    const requestId = crypto.randomUUID();
    setStatus(previous => ({ ...previous, [card.cardId]: { pending: true, message: "Sending request to AMO…" } }));
    const timer = setTimeout(() => {
      requests.current.delete(requestId);
      setStatus(previous => ({ ...previous, [card.cardId]: { pending: false, message: "No delegation result received. Check AMO and the target application before trying again." } }));
    }, 20000);
    requests.current.set(requestId, { cardId: card.cardId, timer });
    try { await getCurrentWindow().emitTo("main", "amo-focus-session-command", { requestId, action, cardId: card.cardId, sessionComponentId: card.session.componentId, conversationComponentId: card.conversation?.componentId ?? null, sessionId: card.session.sessionRef.sessionId, frameworkId: card.session.sessionRef.frameworkId }); }
    catch (reason) { clearTimeout(timer); requests.current.delete(requestId); setStatus(previous => ({ ...previous, [card.cardId]: { pending: false, message: reason instanceof Error ? reason.message : "Could not send request to AMO" } })); }
  }
  return { ready, status, send };
}
