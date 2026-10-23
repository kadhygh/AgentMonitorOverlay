import { useMemo } from "react";
import type { GitViewItem, StateSnapshot, ViewPack, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { ReviewPage } from "../gitreview/ReviewApp.js";
import type { ViewMark } from "../gitreview/DiffView.js";

// A 查看包's changes (2026-10-23): Git Review inside the window, on what the item names — the uncommitted changes,
// the working tree against a base, or a commit (against its parent or a base). The files the item points at are a
// group of their own above the rest of the changes (those without changes in it are said so), and its 重点 are drawn
// on their lines. With several items, j / k go through the pack's list and Ctrl+J / Ctrl+K through the files here.
// Comments go to the pack's conversation by default.

export function GitItemView({ link, state, pack, workspace, item, active }: { link: HostLink; state: StateSnapshot; pack: ViewPack; workspace: Workspace; item: GitViewItem; active: boolean }) {
  const s = item.source;
  const commit = s.kind === "commit" ? s.commit : null;
  const base = s.kind === "base" ? { sha: s.base, label: s.label } : s.kind === "commit" && s.base ? { sha: s.base, label: s.label ?? null } : null;
  const highlights = useMemo(() => {
    const by = new Map<string, ViewMark[]>();
    for (const h of item.highlights ?? []) {
      const key = h.path.toLowerCase();
      by.set(key, [...(by.get(key) ?? []), { from: h.line, to: h.endLine ?? h.line, note: h.note }]);
    }
    return by.size ? by : null;
  }, [item.highlights]);
  return (
    <div className="vp-item" data-testid="viewpack-git">
      {item.note && <div className="vp-note">{item.note}</div>}
      <div className="vw-changes">
        <ReviewPage
          link={link}
          state={state}
          workspace={workspace}
          sessionId={pack.sessionId}
          commit={commit}
          base={base}
          only={item.files.length ? item.files : null}
          highlights={highlights}
          fileKeys={pack.items.length > 1 ? "ctrl" : "plain"}
          embedded
          inactive={!active}
        />
      </div>
    </div>
  );
}
