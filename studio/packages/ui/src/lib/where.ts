// Which program a page runs in (2026-10-23): AMO Studio, or the AMO Reviewer program on its own, whose preload says
// `app: "reviewer"`. Studio-only parts (bookmarks, sessions) are left out there.

/** Whether the page runs in AMO Studio (or a plain browser on Studio's Host), not in the AMO Reviewer program alone. */
export function inAmo(): boolean {
  return (window.amo as { app?: string } | undefined)?.app !== "reviewer";
}
