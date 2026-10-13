import { useEffect, useState } from "react";
import type { HostEvent, SessionItem } from "@amo-studio/protocol";
import { call, type HostLink } from "./client.js";
import { onHostEvent, onHostReconnect } from "./events.js";

// Items of one session, kept live from the Host event bus. While an agent message streams, the stored markdown stays
// empty and deltas accumulate here; the final text arrives with item.updated.

export function applyItemEvent(items: readonly SessionItem[], e: HostEvent, sessionId: string): readonly SessionItem[] {
  switch (e.type) {
    case "item.appended":
      if (e.item.sessionId !== sessionId || items.some((i) => i.id === e.item.id)) return items;
      return [...items, e.item].sort((a, b) => a.seq - b.seq);
    case "item.updated":
      if (e.item.sessionId !== sessionId) return items;
      return items.map((i) => (i.id === e.item.id ? e.item : i));
    case "item.delta":
      if (e.sessionId !== sessionId) return items;
      return items.map((i) => {
        if (i.id !== e.itemId) return i;
        if (i.type === "agent" && i.streaming) return { ...i, markdown: i.markdown + e.append };
        if (i.type === "reasoning" && i.streaming) return { ...i, text: i.text + e.append };
        // A running command's output; the full output arrives with the item's update when it ends.
        if (i.type === "tool" && i.status === "running") return { ...i, detail: (i.detail ?? "") + e.append };
        return i;
      });
    default:
      return items;
  }
}

export function useSessionItems(link: HostLink, sessionId: string | null) {
  const [items, setItems] = useState<readonly SessionItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems([]);
    setError(null);
    if (!sessionId) return;
    let cancelled = false;
    // Subscribe before loading so nothing between the fetch and the subscription is lost.
    const buffered: HostEvent[] = [];
    let loaded = false;
    const offEvent = onHostEvent((e) => {
      if (!loaded) buffered.push(e);
      else setItems((cur) => applyItemEvent(cur, e, sessionId));
    });
    const load = () =>
      call(link, "GET /api/sessions/:id/items", { id: sessionId })
        .then((fetched) => {
          if (cancelled) return;
          let next: readonly SessionItem[] = fetched;
          for (const e of buffered.splice(0)) next = applyItemEvent(next, e, sessionId);
          loaded = true;
          setItems(next);
        })
        .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    const offReconnect = onHostReconnect(() => {
      loaded = false;
      void load();
    });
    void load();
    return () => {
      cancelled = true;
      offEvent();
      offReconnect();
    };
  }, [link, sessionId]);

  return { items, error };
}
