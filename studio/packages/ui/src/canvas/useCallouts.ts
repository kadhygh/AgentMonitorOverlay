import { useMemo } from "react";
import type { CanvasCallout } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { upsertById, useLiveResource } from "../host/live.js";

/** 画布审阅: the bubbles on a topic's canvas (open and answered ones, then the last closed), kept live. */
export function useCallouts(link: HostLink, topicId: string): readonly CanvasCallout[] {
  const [list] = useLiveResource<readonly CanvasCallout[]>(
    {
      load: () => call(link, "GET /api/topics/:id/callouts", { id: topicId }),
      initial: [],
      onEvent: (cur, e) => (e.type === "callout.upserted" && e.callout.topicId === topicId ? upsertById(cur, e.callout) : cur),
      reset: true,
    },
    [link, topicId],
  );
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
  const [counts] = useLiveResource<WaitingQuestions>(
    { load: link ? () => call(link, "GET /api/callouts/waiting") : null, initial: {}, reloadOn: (e) => e.type === "callout.upserted" },
    [link],
  );
  return counts;
}
