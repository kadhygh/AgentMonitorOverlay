import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadActiveSessionSnapshot } from "../api/sessionSnapshot";
import { loadCanvasSessions } from "../api/taskCanvasClient";
import type { AgentSession } from "../types";

/** Read-only reconciliation. No overlay monitoring, focus probing, or notification owners. */
export function useCanvasSessions(ids: string[]) {
  const [active, setActive] = useState<AgentSession[]>([]);
  const [references, setReferences] = useState<Map<string, AgentSession>>(new Map());
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const nativeVisible = useRef(true);
  const key = JSON.stringify([...new Set(ids)].sort());
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined, unlisten: (() => void) | undefined;
    const visible = () => nativeVisible.current && document.visibilityState !== "hidden";
    const refresh = async () => {
      if (disposed || !visible() || controller) return;
      clearTimeout(timer);
      const current = new AbortController(); controller = current;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; current.abort(); }, 15000);
      try {
        const requested: string[] = JSON.parse(key);
        const [snapshot, exact] = await Promise.all([loadActiveSessionSnapshot(current.signal), requested.length ? loadCanvasSessions(requested, current.signal) : Promise.resolve({ sessions: [] })]);
        if (!disposed && !current.signal.aborted) {
          setActive(snapshot.sessions.filter(s => !s.archivedAt && !s.dismissedAt));
          setReferences(new Map(exact.sessions.map(s => [s.sessionId, s])));
          setResolved(new Set(requested)); setError("");
        }
      } catch (reason) { if (!disposed && visible() && (timedOut || !current.signal.aborted)) setError(timedOut ? "Task refresh timed out. Retrying shortly." : reason instanceof Error ? reason.message : "Task refresh failed"); }
      finally { clearTimeout(timeout); current.abort(); controller = undefined; if (!disposed && visible()) timer = setTimeout(() => void refresh(), 5000); }
    };
    const visibilityChanged = () => { if (visible()) void refresh(); else { clearTimeout(timer); controller?.abort(); } };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("focus", visibilityChanged);
    void listen<boolean>("amo-canvas-visibility", event => { nativeVisible.current = event.payload; visibilityChanged(); }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    void refresh();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); unlisten?.(); document.removeEventListener("visibilitychange", visibilityChanged); window.removeEventListener("focus", visibilityChanged); };
  }, [key]);
  return { active, references, resolved, error };
}
