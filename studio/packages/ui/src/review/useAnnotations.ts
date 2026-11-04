import type { Annotation } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { removeById, upsertById, useLiveResource } from "../host/live.js";

/** Annotations of one session, kept live from the Host event bus. Ordered by creation. */
export function useAnnotations(link: HostLink, sessionId: string | null) {
  const [annotations] = useLiveResource<readonly Annotation[]>(
    {
      load: sessionId ? () => call(link, "GET /api/sessions/:id/annotations", { id: sessionId }) : null,
      initial: [],
      onEvent: (cur, e) =>
        e.type === "annotation.upserted" && e.annotation.sessionId === sessionId ? upsertById(cur, e.annotation) : e.type === "annotation.removed" && e.sessionId === sessionId ? removeById(cur, e.annotationId) : cur,
      reset: true,
    },
    [link, sessionId],
  );

  return annotations;
}
