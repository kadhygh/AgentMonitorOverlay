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

export function TowerView({ link, sessionId, onOpen }: { link: HostLink; sessionId: Id; onOpen(target: { sessionId?: Id; itemId?: Id }): void }) {
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
  const open = useRef(onOpen);
  open.current = onOpen;
  const hand = () => {
    if (ready.current && latest.current) frame.current?.contentWindow?.postMessage({ type: "tower.data", data: latest.current }, "*");
  };
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { type?: string; sessionId?: unknown; itemId?: unknown } | null;
      // The page says so each time it has loaded (it loads anew when the data changed).
      if (m?.type === "tower.ready") {
        ready.current = true;
        hand();
      } else if (m?.type === "tower.open") open.current({ ...(typeof m.sessionId === "string" ? { sessionId: m.sessionId } : {}), ...(typeof m.itemId === "string" ? { itemId: m.itemId } : {}) });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(hand, [data]);

  return (
    <div className="tower-view" data-testid="tower-view">
      {!data && <div className="tower-loading">正在整理这个会话的脉络…</div>}
      <iframe ref={frame} src="./tower.html" title="脉络" data-testid="tower-frame" />
    </div>
  );
}

/** Above the conversation of a session, while 脉络 is on: which of the two to look at, and whether the session is a 脉络会话. */
export function TowerSwitch({ tower, on, onView, onToggle }: { tower: boolean; on: boolean; onView(tower: boolean): void; onToggle(on: boolean): void }) {
  return (
    <div className="tower-switch" data-testid="tower-switch">
      <div className="tower-seg" role="tablist">
        <button type="button" role="tab" aria-selected={!tower} onClick={() => onView(false)} data-testid="tower-view-chat">
          对话
        </button>
        <button type="button" role="tab" aria-selected={tower} onClick={() => onView(true)} data-testid="tower-view-tower">
          脉络
        </button>
      </div>
      <label className="tower-on" title="勾上以后：这个会话一打开就是脉络；AI 每轮结束时给这一轮写一行标题、记下你强调的事（从你发的下一条消息起）。以前的轮次没有 AI 写的标题，用对话里的话顶着。">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} data-testid="tower-on" />
        脉络会话
      </label>
      <span className="tower-hint">{on ? "打开就是脉络；AI 每轮写一行标题" : "勾上后打开就是脉络，AI 每轮写一行标题"}</span>
    </div>
  );
}
