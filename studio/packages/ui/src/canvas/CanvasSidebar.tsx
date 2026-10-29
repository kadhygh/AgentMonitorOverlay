import type { ReactNode } from "react";

export type { CanvasSelection } from "./CanvasDetail.js";
export type SidebarTab = "todo" | "talk" | "docs" | "marks" | "agent";

interface CanvasSidebarProps {
  tab: SidebarTab;
  onTab(tab: SidebarTab): void;
  /** Its width, dragged at its left edge (CanvasPage). */
  width: number;
  /** Rendered for the "整体待办" and "agent 视角" tabs (S3-05). */
  todoTab?: ReactNode;
  agentTab?: ReactNode;
  /** 文档 (stage 16): the topic's documents. */
  docsTab?: ReactNode;
  /** 书签 (2026-10-19): the topic's bookmarks. */
  marksTab?: ReactNode;
  /** 沟通 (画布审阅): the bubbles on the canvas; `talkCount` questions wait for the person. */
  talkTab?: ReactNode;
  talkCount?: number;
}

/** The tabs there are, in order: [id, name, the short name a narrow sidebar shows]. */
export function sidebarTabs(props: Pick<CanvasSidebarProps, "todoTab" | "talkTab" | "docsTab" | "marksTab">): Array<[SidebarTab, string, string]> {
  const all: Array<[SidebarTab, string, string, unknown]> = [
    // 整体待办 belongs to the planning feature: no tab while it is turned off.
    ["todo", "整体待办", "待办", props.todoTab],
    ["talk", "沟通", "沟通", props.talkTab],
    ["docs", "文档", "文档", props.docsTab],
    ["marks", "书签", "书签", props.marksTab],
    ["agent", "agent 视角", "agent", true],
  ];
  return all.filter(([, , , on]) => !!on).map(([id, label, short]) => [id, label, short]);
}

/**
 * Right column of the canvas (2026-10-29 redesign): whole-picture todos, the talk on the cards, the topic's documents and
 * bookmarks, and the agent's view, under one row of tabs ruled off from the content. The selection's details are not here
 * any more: they float beside the card (CanvasDetail). Shown and hidden by 侧栏 on the canvas, its width dragged.
 */
export function CanvasSidebar(props: CanvasSidebarProps) {
  const { tab, onTab, width, talkCount = 0 } = props;
  const tabs = sidebarTabs(props);
  return (
    <aside className="canvas-side" aria-label="画布侧栏" style={{ flexBasis: width, width }} data-testid="canvas-side">
      <div role="tablist" aria-label="侧栏" className="canvas-side-tabs">
        {tabs.map(([id, label, short]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} aria-label={id === "talk" && talkCount ? `${label} ${talkCount}` : label} className="canvas-side-tab" onClick={() => onTab(id)} data-testid={`side-tab-${id}`} title={label}>
            <span className="tab-full">{label}</span>
            {short !== label && <span className="tab-short">{short}</span>}
            {id === "talk" && talkCount > 0 && (
              <span className="side-tab-count" data-testid="side-talk-count" title={`${talkCount} 个问题待你确认`}>
                {talkCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="canvas-side-body" role="tabpanel" aria-label={tabs.find(([id]) => id === tab)?.[1]}>
        {tab === "todo" && props.todoTab}
        {tab === "talk" && props.talkTab}
        {tab === "docs" && props.docsTab}
        {tab === "marks" && props.marksTab}
        {tab === "agent" && props.agentTab}
      </div>
    </aside>
  );
}
