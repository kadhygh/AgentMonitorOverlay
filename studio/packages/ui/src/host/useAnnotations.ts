import { useEffect, useState } from "react";
import type { Annotation } from "@amo-studio/protocol";
import { call, type HostLink } from "./client.js";
import { onHostEvent, onHostReconnect } from "./events.js";

/** Annotations of one session, kept live from the Host event bus. Ordered by creation. */
export function useAnnotations(link: HostLink, sessionId: string | null) {
  const [annotations, setAnnotations] = useState<readonly Annotation[]>([]);

  useEffect(() => {
    setAnnotations([]);
    if (!sessionId) return;
    let cancelled = false;
    const load = () =>
      call(link, "GET /api/sessions/:id/annotations", { id: sessionId })
        .then((list) => !cancelled && setAnnotations(list))
        .catch(() => undefined);
    const offEvent = onHostEvent((e) => {
      if (e.type === "annotation.upserted" && e.annotation.sessionId === sessionId) {
        setAnnotations((cur) => {
          const i = cur.findIndex((a) => a.id === e.annotation.id);
          if (i < 0) return [...cur, e.annotation];
          const next = cur.slice();
          next[i] = e.annotation;
          return next;
        });
      } else if (e.type === "annotation.removed" && e.sessionId === sessionId) {
        setAnnotations((cur) => cur.filter((a) => a.id !== e.annotationId));
      }
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
    return () => {
      cancelled = true;
      offEvent();
      offReconnect();
    };
  }, [link, sessionId]);

  return annotations;
}
