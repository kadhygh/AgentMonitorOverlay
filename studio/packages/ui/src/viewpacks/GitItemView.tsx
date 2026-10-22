import type { GitViewItem, StateSnapshot, ViewPack, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { ReviewPage } from "../gitreview/ReviewApp.js";

// A 查看包's changes (2026-10-23): Git Review inside the window, on what the item names — the uncommitted changes,
// the working tree against a base, or a commit (against its parent or a base) — and, when the item names files, only
// those (the ones without changes in it are said so). Comments go to the pack's conversation by default.

export function GitItemView({ link, state, pack, workspace, item, active }: { link: HostLink; state: StateSnapshot; pack: ViewPack; workspace: Workspace; item: GitViewItem; active: boolean }) {
  const s = item.source;
  const commit = s.kind === "commit" ? s.commit : null;
  const base = s.kind === "base" ? { sha: s.base, label: s.label } : s.kind === "commit" && s.base ? { sha: s.base, label: s.label ?? null } : null;
  return (
    <div className="vp-item" data-testid="viewpack-git">
      {item.note && <div className="vp-note">{item.note}</div>}
      <div className="vw-changes">
        <ReviewPage link={link} state={state} workspace={workspace} sessionId={pack.sessionId} commit={commit} base={base} only={item.files.length ? item.files : null} embedded inactive={!active} />
      </div>
    </div>
  );
}
