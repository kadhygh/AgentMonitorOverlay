import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { REMOTE_TASK_FOLDER, type StateSnapshot, type Workspace } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";

// 远程 Reviewer (plans/remote-reviewer.md, 2026-11-02): a remote task's 查看包 and Review on this computer. The windows
// are the usual ones; only their link goes through this Host's /api/remote/view/<task>/…, which passes each read on to
// the computer the task runs on (and keeps it, for when that computer is away). The task's project is not on this
// computer: a stand-in names it by that computer and 任务文件夹, with that computer's id for it (the routes carry it).
// What only this computer could do (VS Code, Explorer, 书签) is not offered; files open in the remote viewer.

/**
 * 「我也关注」 (2026-11-02, the user): tasks for which this computer also opens what an agent shows the person when the
 * turn was started on the other side — on A a granted task (B's turns), on B a remote copy (A's turns). Per machine
 * (localStorage, like 「我也关心」), never sent anywhere; off by default.
 */
export const FOLLOW_REVIEW_KEY = "amo.remoteReviewFollow";

/** A Reviewer window on a remote task. */
export interface RemoteReview {
  taskId: string;
  /** The computer the task runs on, as last heard. */
  device: string;
  /** This Host itself (the window's own link goes through it to that computer). */
  host: HostLink;
  /** What its pictures are served under here (/api/remote/files/<key>/…), once known. */
  key: string | null;
}

const Ctx = createContext<RemoteReview | null>(null);

/** The remote task a Reviewer window shows, or null for this computer's own projects. */
export const useRemoteReview = () => useContext(Ctx);

/** The Host link a remote task's Reviewer window uses: the same Host, its reads passed on to the task's computer. */
export function remoteViewLink(link: HostLink, taskId: string): HostLink {
  return { url: `${link.url}/api/remote/view/${encodeURIComponent(taskId)}`, token: link.token };
}

/** The task's project as this computer shows it: that computer's id, named by the device; paths start at 任务文件夹. */
export function remoteWorkspace(workspaceId: string, device: string): Workspace {
  return { id: workspaceId, name: `${device} · ${REMOTE_TASK_FOLDER}`, path: REMOTE_TASK_FOLDER, createdAt: "" };
}

/** A path of the task's project (relative, forward slashes) as that computer's files are named here. */
export const remoteProjectPath = (rel: string): string => (rel === REMOTE_TASK_FOLDER || rel.startsWith(`${REMOTE_TASK_FOLDER}/`) ? rel : `${REMOTE_TASK_FOLDER}/${rel.replace(/\\/g, "/").replace(/^\.?\//, "")}`);

/**
 * Wraps a Reviewer window on a remote task (`taskId`; null: this computer's own, children as they are): `children` gets
 * the link to use, and inside, useRemoteReview() says which task. The task gone from this computer: `gone` instead.
 */
export function RemoteReviewScope({ link, state, taskId, gone, children }: { link: HostLink; state: StateSnapshot; taskId: string | null | undefined; gone: ReactNode; children(link: HostLink, remote: RemoteReview | null): ReactNode }) {
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : undefined;
  const device = task?.remote?.name ?? "";
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    setKey(null);
    if (!taskId || !task?.remote) return;
    let live = true;
    call(link, "GET /api/remote/tasks/:id/files-key", { id: taskId })
      .then((r) => live && setKey(r.key))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link, taskId, !!task?.remote]); // eslint-disable-line react-hooks/exhaustive-deps
  const remote = useMemo<RemoteReview | null>(() => (taskId && device ? { taskId, device, host: link, key } : null), [taskId, device, link, key]);
  const view = useMemo(() => (taskId ? remoteViewLink(link, taskId) : link), [link, taskId]);
  if (!taskId) return <>{children(link, null)}</>;
  if (!remote) return <>{gone}</>;
  return <Ctx.Provider value={remote}>{children(view, remote)}</Ctx.Provider>;
}

/** Why what a remote task's Reviewer shows is the copy from last time (its computer away); null while it is fresh. */
export function useRemoteStale(taskId: string | null | undefined): string | null {
  const [stale, setStale] = useState<string | null>(null);
  useEffect(() => {
    setStale(null);
    if (!taskId) return;
    return onHostEvent((e) => {
      if (e.type === "remote.view" && e.taskId === taskId) setStale(e.stale);
    });
  }, [taskId]);
  return stale;
}

/** The line under a remote Reviewer window's head saying what it shows is old (its computer away). */
export function RemoteStaleBar({ taskId }: { taskId: string }) {
  const stale = useRemoteStale(taskId);
  return stale ? (
    <div className="vw-stale" role="status" data-testid="remote-review-stale">
      {stale}
    </div>
  ) : null;
}
