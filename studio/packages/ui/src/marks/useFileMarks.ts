import { useEffect, useState } from "react";
import type { FileMark } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/**
 * File marks, live: all of them (`workspaceId` undefined) or one project's. Reloaded whenever a mark changes anywhere
 * (`marks.changed`), a project goes away (its marks go with it), or the event socket reconnects. `enabled: false`
 * holds off until needed (the composer asks only once @ is typed).
 */
export function useFileMarks(link: HostLink, workspaceId?: string | null, enabled = true): { marks: FileMark[] | null; reload(): void } {
  const [marks, setMarks] = useState<FileMark[] | null>(null);
  const [tick, setTick] = useState(0);
  const scoped = workspaceId !== undefined;
  useEffect(() => {
    if (!enabled || !link.url || (scoped && !workspaceId)) return;
    let live = true;
    const load = () =>
      call(link, "GET /api/file-marks", {}, undefined, workspaceId ? { workspace: workspaceId } : undefined)
        .then((m) => live && setMarks(m))
        .catch(() => undefined);
    const offEvent = onHostEvent((e) => {
      if ((e.type === "marks.changed" && (!workspaceId || e.workspaceId === workspaceId)) || e.type === "workspace.removed" || e.type === "workspace.upserted") void load();
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
    return () => {
      live = false;
      offEvent();
      offReconnect();
    };
  }, [link, workspaceId, scoped, enabled, tick]);
  return { marks: scoped && !workspaceId ? [] : marks, reload: () => setTick((n) => n + 1) };
}
