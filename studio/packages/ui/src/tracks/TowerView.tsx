import { useEffect, useMemo, useRef } from "react";
import type { Id, SessionStatus, TowerData } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

// 脉络的楼 in a session (2026-11-15, plans/tracks.md; the user: 这个会话点开直接就能看到相关的楼板表现，以及可以继续走对话): the
// building takes the conversation's place, the composer stays under it. The building itself is a page of its own
// (tower.html: three.js and the prototype's drawing code, kept apart from the workbench's bundle and styles) in an
// iframe; this side fetches the data, hands it in, and takes 「在对话里看这一轮」/「打开子会话」 back.

/** The sessions that are 脉络会话 (they open as their building), kept current. Nothing is asked while the feature is off. */
export function useTracksOn(link: HostLink | null, enabled: boolean): ReadonlySet<Id> {
  const [on] = useLiveResource<Id[]>(
    {
      load: link && enabled ? () => call(link, "GET /api/tracks", {}).then((r) => r.on) : null,
      initial: [],
      onEvent: (cur, e) => (e.type !== "tracks.changed" ? cur : cur.includes(e.sessionId) === e.on ? cur : e.on ? [...cur, e.sessionId] : cur.filter((id) => id !== e.sessionId)),
    },
    [link, enabled],
  );
  return useMemo(() => new Set(on), [on]);
}

/** A card picked in the building (tower.pick): whose conversation to show in the 会话弹窗, at which row. */
export interface TowerPickTarget {
  sessionId: Id;
  itemId?: Id;
  title?: string;
}

export function TowerView({
  link,
  sessionId,
  popup,
  onOpen,
  onPick,
  onUnpick,
}: {
  link: HostLink;
  sessionId: Id;
  /**
   * The card's 会话弹窗 window (the one not pinned) is open, told to the page: when it closes (its ×, Esc, 固定) the card
   * is let go there; when the page reloads with it open, the card is marked again.
   */
  popup: boolean;
  onOpen(target: { sessionId?: Id; itemId?: Id }): void;
  onPick(target: TowerPickTarget): void;
  /** The building's empty space was clicked, or Esc pressed in it. */
  onUnpick(): void;
}) {
  // The Host puts the building together from all the session's rows each time, so it is asked again only when
  // something a floor shows changed: a turn began or ended (its own, or one of the sessions it started), its AI wrote
  // a title or a point, a 中转 session moved. Not on every row.
  const statuses = useRef(new Map<Id, SessionStatus>());
  const [data] = useLiveResource<TowerData | null>(
    {
      load: () => call(link, "GET /api/sessions/:id/tracks", { id: sessionId }),
      initial: null,
      reset: true,
      reloadOn: (e) => {
        if (e.type === "tracks.changed") return e.sessionId === sessionId;
        if (e.type === "teamthreads.changed") return true;
        if (e.type !== "session.upserted" || (e.session.id !== sessionId && e.session.startedBy !== sessionId)) return false;
        const was = statuses.current.get(e.session.id);
        statuses.current.set(e.session.id, e.session.status);
        return was !== e.session.status;
      },
      reloadDelay: 1200,
    },
    [link, sessionId],
  );

  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const latest = useRef(data);
  latest.current = data;
  const calls = useRef({ onOpen, onPick, onUnpick });
  calls.current = { onOpen, onPick, onUnpick };
  const popupOpen = useRef(popup);
  popupOpen.current = popup;
  const hand = () => {
    if (ready.current && latest.current) frame.current?.contentWindow?.postMessage({ type: "tower.data", data: latest.current }, "*");
  };
  const tellPopup = () => {
    if (ready.current) frame.current?.contentWindow?.postMessage({ type: "tower.popup", open: popupOpen.current }, "*");
  };
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { type?: string; sessionId?: unknown; itemId?: unknown; title?: unknown } | null;
      const itemId = typeof m?.itemId === "string" ? { itemId: m.itemId } : {};
      // The page says so each time it has loaded (it loads anew when the data changed).
      if (m?.type === "tower.ready") {
        ready.current = true;
        hand();
        if (popupOpen.current) tellPopup();
      } else if (m?.type === "tower.open") calls.current.onOpen({ ...(typeof m.sessionId === "string" ? { sessionId: m.sessionId } : {}), ...itemId });
      else if (m?.type === "tower.pick" && typeof m.sessionId === "string") calls.current.onPick({ sessionId: m.sessionId, ...itemId, ...(typeof m.title === "string" && m.title ? { title: m.title } : {}) });
      else if (m?.type === "tower.unpick") calls.current.onUnpick();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(hand, [data]);
  // Only changes are told (the page starts with none open); a reload of the page is told again above.
  const toldPopup = useRef(popup);
  useEffect(() => {
    if (toldPopup.current === popup) return;
    toldPopup.current = popup;
    tellPopup();
  }, [popup]);

  return (
    <div className="tower-view" data-testid="tower-view">
      {!data && <div className="tower-loading">正在整理这个会话的脉络…</div>}
      <iframe ref={frame} src="./tower.html" title="脉络" data-testid="tower-frame" />
    </div>
  );
}

/**
 * Above the conversation of a session, while 脉络 or 白板 is on (设置 → 测试功能): which view of it to look at, and whether
 * the session is a 脉络会话. `tracks` false: 脉络 is off, only 对话 | 白板. `board`: 白板 is on — whether it is shown, and
 * whether its AI wrote something the person has not looked at (a dot).
 */
export function TowerSwitch({ tower, on, off, tracks = true, board, onView, onToggle }: { tower: boolean; on: boolean; off?: string; tracks?: boolean; board?: { shown: boolean; dot: boolean; onView(): void }; onView(tower: boolean): void; onToggle(on: boolean): void }) {
  // A remote task whose own computer cannot answer for it yet: said in the row's place (the task page, tracksOff).
  if (off)
    return (
      <div className="tower-switch" data-testid="tower-switch">
        <span className="tower-hint" data-testid="tower-off">
          脉络：{off}
        </span>
      </div>
    );
  return (
    <div className="tower-switch" data-testid="tower-switch">
      <div className="tower-seg" role="tablist">
        <button type="button" role="tab" aria-selected={!tower && !board?.shown} onClick={() => onView(false)} data-testid="tower-view-chat">
          对话
        </button>
        {board && (
          <button type="button" role="tab" aria-selected={board.shown} title={board.dot ? "白板：AI 写了你还没看过的内容" : "白板：AI 写的任务内容、计划、建议和定下来的事；你看和批注"} onClick={board.onView} data-testid="view-whiteboard">
            白板
            {board.dot && <i className="wb-dot" data-testid="wb-dot" />}
          </button>
        )}
        {tracks && (
          <button type="button" role="tab" aria-selected={tower} onClick={() => onView(true)} data-testid="tower-view-tower">
            脉络
          </button>
        )}
      </div>
      {tracks && !board?.shown && <TowerTick on={on} onToggle={onToggle} />}
    </div>
  );
}

function TowerTick({ on, onToggle }: { on: boolean; onToggle(on: boolean): void }) {
  return (
    <>
      <label className="tower-on" title="勾上以后：这个会话一打开就是脉络；AI 每轮结束时给这一轮写一行标题、记下你强调的事（从你发的下一条消息起）。以前的轮次没有 AI 写的标题，用对话里的话顶着。">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} data-testid="tower-on" />
        脉络会话
      </label>
      <span className="tower-hint">{on ? "打开就是脉络；AI 每轮写一行标题" : "勾上后打开就是脉络，AI 每轮写一行标题"}</span>
    </>
  );
}
