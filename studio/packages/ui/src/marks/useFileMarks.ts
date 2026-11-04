import type { Bookmark, FileMark } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

/**
 * File marks, live: all of them (`workspaceId` undefined) or one project's. Reloaded whenever a mark changes anywhere
 * (`marks.changed`), a project goes away (its marks go with it), or the event socket reconnects. `enabled: false`
 * holds off until needed (the composer asks only once @ is typed).
 */
export function useFileMarks(link: HostLink, workspaceId?: string | null, enabled = true): { marks: FileMark[] | null; reload(): void } {
  const scoped = workspaceId !== undefined;
  const [marks, , reload] = useLiveResource<FileMark[] | null>(
    {
      load: !enabled || !link.url || (scoped && !workspaceId) ? null : () => call(link, "GET /api/file-marks", {}, undefined, workspaceId ? { workspace: workspaceId } : undefined),
      initial: null,
      reloadOn: (e) => (e.type === "marks.changed" && (!workspaceId || e.workspaceId === workspaceId)) || e.type === "workspace.removed" || e.type === "workspace.upserted",
    },
    [link, workspaceId, scoped, enabled],
  );
  return { marks: scoped && !workspaceId ? [] : marks, reload };
}

/** 书签 (2026-10-19), live: every bookmark, or one topic's ("none": 未归专题); reloaded as useFileMarks is. */
export function useBookmarks(link: HostLink, topic?: string): Bookmark[] | null {
  const [marks] = useLiveResource<Bookmark[] | null>(
    {
      load: link.url ? () => call(link, "GET /api/bookmarks", {}, undefined, topic ? { topic } : undefined) : null,
      initial: null,
      reloadOn: (e) => e.type === "marks.changed" || e.type === "workspace.removed" || e.type === "topic.upserted",
    },
    [link, topic],
  );
  return marks;
}
