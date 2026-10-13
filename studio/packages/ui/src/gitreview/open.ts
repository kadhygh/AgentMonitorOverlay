import { useEffect, useState } from "react";
import type { GitStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { reviewHash, type ReviewTarget } from "./logic.js";

// Opening the Git Review window, and whether a project can be reviewed at all.

type ReviewBridge = { openReview?(target: ReviewTarget): Promise<void> };

/** Opens (or brings forward) the project's review window; outside Electron, the same page in a new tab. */
export function openReview(target: ReviewTarget): void {
  const bridge = window.amo as ReviewBridge | undefined;
  if (bridge?.openReview) void bridge.openReview(target);
  else window.open(`${location.pathname}${location.search}${reviewHash(target)}`, "_blank");
}

// Asked once per project while the window lives: a folder rarely becomes (or stops being) a repository.
const known = new Map<string, Promise<GitStatus | null>>();

export function gitStatus(link: HostLink, workspaceId: string): Promise<GitStatus | null> {
  let p = known.get(workspaceId);
  if (!p) {
    p = call(link, "GET /api/workspaces/:id/git/status", { id: workspaceId }).catch(() => null);
    known.set(workspaceId, p);
  }
  return p;
}

/** Whether the project is a git repository (false until known). */
export function useIsGitRepo(link: HostLink, workspaceId: string | null | undefined): boolean {
  const [repo, setRepo] = useState(false);
  useEffect(() => {
    setRepo(false);
    if (!workspaceId || !link.url) return;
    let live = true;
    void gitStatus(link, workspaceId).then((s) => live && setRepo(!!s?.repo));
    return () => {
      live = false;
    };
  }, [link, workspaceId]);
  return repo;
}
