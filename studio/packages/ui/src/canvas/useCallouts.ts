import { useEffect, useState } from "react";
import type { CanvasCallout } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/** 画布审阅: the bubbles on a topic's canvas (open and answered ones, then the last closed), kept live. */
export function useCallouts(link: HostLink, topicId: string): readonly CanvasCallout[] {
  const [list, setList] = useState<readonly CanvasCallout[]>([]);
  useEffect(() => {
    let cancelled = false;
    setList([]);
    const load = () =>
      void call(link, "GET /api/topics/:id/callouts", { id: topicId })
        .then((all) => !cancelled && setList(all))
        .catch(() => undefined);
    load();
    const off = onHostEvent((e) => {
      if (e.type !== "callout.upserted" || e.callout.topicId !== topicId) return;
      setList((cur) => (cur.some((c) => c.id === e.callout.id) ? cur.map((c) => (c.id === e.callout.id ? e.callout : c)) : [...cur, e.callout]));
    });
    const offReconnect = onHostReconnect(load);
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link, topicId]);
  return list;
}
