import { useMemo, useState, type ReactNode } from "react";
import { originLabel, type MessageOrigin } from "@amo-studio/protocol";
import { Markdown } from "../lib/markdown.js";
import { IconChevronDown, IconChevronRight } from "./icons.js";
import { originBrief } from "./originBrief.js";
import { OpenInRelay, useRelayAvailable } from "../teamrelay/TeamRelay.js";

// 交流框架 (2026-11-15, plans/collab-framework.md): a message an agent or Studio put into the session — a sub-session's
// report, a 中转 reply, the 主控's word, a forwarded 留言, 值守 — is not the person's, so it is not drawn as their bubble.
// It is a folded row across the conversation: who it is from, two or three lines of what it says, the whole text on a
// click. The person skims past it; the model has read all of it either way.

const STATE_MARK: Record<NonNullable<MessageOrigin["state"]>, string> = { done: "✓", stopped: "○", failed: "!" };

/** `itemId`: on the row as data-row-id, for the 事项 list's click (not data-item-id: that is a reply, which takes 批注). */
export function OriginMessage({ itemId, origin, body, children }: { itemId: string; origin: MessageOrigin; body: string; children?: ReactNode }) {
  // What another session opened this one with is its assignment, at the top of the conversation: shown in full.
  const [open, setOpen] = useState(origin.kind === "start");
  const brief = useMemo(() => originBrief(origin, body), [origin, body]);
  const length = body.trim().length;
  return (
    // Also a msg-user-row: what tells a turn's inputs from its work by that class (TurnStartHint, the margins) still does.
    <div className="msg-user-row msg-origin-row">
      <div className={`msg-origin${open ? " open" : ""}`} data-testid="msg-origin" data-kind={origin.kind} data-state={origin.state} data-row-id={itemId}>
        <button type="button" className="msg-origin-head" aria-expanded={open} data-testid="msg-origin-toggle" title={open ? "收起" : "展开看全文"} onClick={() => setOpen((v) => !v)}>
          {open ? <IconChevronDown /> : <IconChevronRight />}
          {origin.state && <span className={`msg-origin-mark ${origin.state}`}>{STATE_MARK[origin.state]}</span>}
          <span className="msg-origin-label">{originLabel(origin)}</span>
          {length > 0 && <span className="msg-origin-note">{length.toLocaleString("en-US")} 字</span>}
        </button>
        {open ? (
          <div className="msg-origin-body" data-testid="msg-origin-body">
            <Markdown source={body.trim()} />
            {origin.kind === "cowork" && origin.threadIds?.[0] && <CoworkRelayLink threadId={origin.threadIds[0]} />}
          </div>
        ) : (
          brief && (
            <div className="msg-origin-brief" data-testid="msg-origin-brief" onClick={() => setOpen(true)}>
              {brief}
            </div>
          )
        )}
      </div>
      {children}
    </div>
  );
}

/** 协作 (2026-11-23): where it was said, in the AMO 中转 client (the whole 协作 is seen there, the user 11-23). */
function CoworkRelayLink({ threadId }: { threadId: string }) {
  const relay = useRelayAvailable();
  if (!relay) return null;
  return (
    <div className="msg-origin-actions">
      <OpenInRelay threadId={threadId} title="在 AMO 中转里打开协作里的这段对话" />
    </div>
  );
}
