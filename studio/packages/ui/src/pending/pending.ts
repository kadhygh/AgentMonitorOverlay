import type { PendingEntry, PendingSnapshot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

// 待我处理 (2026-11-24, protocol/src/pending.ts; plans/collab-framework.md「Studio 里「待我处理」的接口」): the Host's snapshot,
// kept current by `pending.changed`. Read by the Focus row and the 协作 line; the 待我处理 page (replacing 留言) is the
// 交流·本机留言和主控 work and reads the same hook.

const EMPTY: PendingSnapshot = { groups: [], mine: 0, version: 0, problems: [] };

export function usePending(link: HostLink | null): PendingSnapshot {
  const [snap] = useLiveResource<PendingSnapshot>(
    { load: link ? () => call(link, "GET /api/pending", {}) : null, initial: EMPTY, onEvent: (cur, e) => (e.type === "pending.changed" ? e.snapshot : cur) },
    [link],
  );
  return snap;
}

/** The person's own items, newest first, across groups. */
export function mineItems(snap: PendingSnapshot): Array<PendingEntry & { group: string; groupTitle: string }> {
  return snap.groups
    .filter((g) => g.for.kind === "person")
    .flatMap((g) => g.items.map((i) => ({ ...i, group: g.id, groupTitle: g.title })))
    .sort((a, b) => b.since - a.since);
}

/** Goes where an item is: the 中转 client for a 协作's, a session or task here, or the workbench. */
export async function openPendingEntry(link: HostLink, entry: PendingEntry): Promise<void> {
  const o = entry.open;
  if (o.kind === "relay") await call(link, "POST /api/cowork/open-in-relay", {}, { target: o.target });
  else if (o.kind === "session") await window.amo?.openInWorkbench?.({ ...(o.taskId ? { taskId: o.taskId } : {}), sessionId: o.sessionId });
  else if (o.kind === "task") await window.amo?.openInWorkbench?.({ taskId: o.taskId });
  else await window.amo?.openInWorkbench?.({ show: true });
}

export const PENDING_KIND_LABEL: Record<PendingEntry["kind"], string> = { mention: "@ 你", reply: "回你", waiting: "在等你", message: "发给你", notice: "知会你", quiet: "久没动静" };
