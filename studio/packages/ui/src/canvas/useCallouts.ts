import { useEffect, useMemo, useState } from "react";
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

export type WaitingQuestions = Readonly<Record<string, { count: number; first: { id: string; text: string; createdAt: string } }>>;

/** Questions waiting for the person on each topic's canvas (左栏「? N」), as counts. */
export function useWaitingQuestions(link: HostLink): Readonly<Record<string, number>> {
  const waiting = useWaitingQuestionList(link);
  return useMemo(() => Object.fromEntries(Object.entries(waiting).map(([topic, w]) => [topic, w.count])), [waiting]);
}

/** Questions waiting on each topic's canvas, with the oldest (Focus), refreshed when a bubble changes. */
export function useWaitingQuestionList(link: HostLink | null): WaitingQuestions {
  const [counts, setCounts] = useState<WaitingQuestions>({});
  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    const load = () =>
      void call(link, "GET /api/callouts/waiting")
        .then((c) => !cancelled && setCounts(c))
        .catch(() => undefined);
    load();
    const off = onHostEvent((e) => {
      if (e.type === "callout.upserted") load();
    });
    const offReconnect = onHostReconnect(load);
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link]);
  return counts;
}
