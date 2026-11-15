import { useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Id, SessionStatus, TowerData } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { IconX } from "../chat/icons.js";

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
  /** The 会话弹窗 is open (told to the page: closing it by its × unselects the card there). */
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

// 会话弹窗 (2026-11-16, the user: 点击某个卡片时，不要用侧边栏展示应该改成会话弹窗…弹窗应该能拖动，能 pin。弹窗也能加批注。):
// the conversation of the card picked (and its composer) floats over the building, in the task page's one Thread (its
// `float`); this is the window's head and corner. Where it is and how big, in the stage's box (the building's area):
// kept while the page is open, for every session and task (the user: 位置在这次页面打开期间记住).

export interface PopupBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

let rememberedBox: PopupBox | null = null;
export const rememberedPopupBox = (): PopupBox | null => rememberedBox;
export const rememberPopupBox = (box: PopupBox): void => void (rememberedBox = box);

const POPUP_MARGIN = 8;
// Narrower than this, the composer's bar (model, effort, send) no longer fits on its line.
const POPUP_MIN_W = 400;
const POPUP_MIN_H = 280;

/** Inside the stage (`w` × `h`), at least as big as it can be there; with nothing yet, along its right side. */
function fitPopup(box: PopupBox | null, w: number, h: number): PopupBox {
  const most = { w: Math.max(0, w - 2 * POPUP_MARGIN), h: Math.max(0, h - 2 * POPUP_MARGIN) };
  const b = box ?? { width: Math.min(640, Math.max(460, Math.round(w * 0.55))), height: h, left: w, top: 0 };
  const width = Math.min(most.w, Math.max(Math.min(POPUP_MIN_W, most.w), b.width));
  const height = Math.min(most.h, Math.max(Math.min(POPUP_MIN_H, most.h), b.height));
  return {
    width,
    height,
    left: Math.max(POPUP_MARGIN, Math.min(b.left, w - POPUP_MARGIN - width)),
    top: Math.max(POPUP_MARGIN, Math.min(b.top, h - POPUP_MARGIN - height)),
  };
}

const same = (a: PopupBox | null, b: PopupBox) => !!a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

export function TowerPopupHead({
  title,
  sub,
  box,
  pinned,
  onBox,
  onPin,
  onChat,
  onClose,
}: {
  title: string;
  /** The card's own words (a round's title), after the session's name. */
  sub?: string;
  box: PopupBox | null;
  pinned: boolean;
  onBox(box: PopupBox): void;
  onPin(pinned: boolean): void;
  onChat(): void;
  onClose(): void;
}) {
  const head = useRef<HTMLDivElement>(null);
  const latest = useRef({ box, onBox });
  latest.current = { box, onBox };
  const stageOf = () => head.current?.closest<HTMLElement>(".thread-stage") ?? null;
  // Placed (or put back inside) when it opens and whenever the stage changes size: never out of the building's area.
  useLayoutEffect(() => {
    const stage = stageOf();
    if (!stage) return;
    const place = () => {
      const next = fitPopup(latest.current.box, stage.clientWidth, stage.clientHeight);
      if (!same(latest.current.box, next)) latest.current.onBox(next);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // Moved by its head, sized by its corner. While the pointer is down the pane is moved by hand (not a render of the
  // whole task page per move) and the box is kept once it is let go. The building is an iframe, which would take the
  // pointer from under a fast drag: the pointer is captured, and the iframe takes no pointer meanwhile (data-moving).
  const drag = useRef<{ kind: "move" | "size"; x: number; y: number; from: PopupBox; now: PopupBox } | null>(null);
  const start = (kind: "move" | "size") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (kind === "move" && (e.target as Element).closest("button"))) return;
    const stage = stageOf();
    const from = latest.current.box;
    if (!stage || !from) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    stage.dataset.moving = "";
    drag.current = { kind, x: e.clientX, y: e.clientY, from, now: from };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    const stage = stageOf();
    const pane = head.current?.parentElement;
    if (!d || !stage || !pane) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const f = d.from;
    // Sized: its top-left stays, it grows only as far as the stage goes.
    const next =
      d.kind === "move"
        ? fitPopup({ ...f, left: f.left + dx, top: f.top + dy }, W, H)
        : fitPopup({ ...f, width: Math.min(f.width + dx, W - POPUP_MARGIN - f.left), height: Math.min(f.height + dy, H - POPUP_MARGIN - f.top) }, W, H);
    d.now = next;
    Object.assign(pane.style, { left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px` });
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    const stage = stageOf();
    if (stage) delete stage.dataset.moving;
    if (d && !same(d.from, d.now)) latest.current.onBox(d.now);
  };

  return (
    <>
      <div ref={head} className="tower-popup-head" title="按住拖动" onPointerDown={start("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} data-testid="tower-popup-head">
        <span className="tower-popup-title" title={sub ? `${title} · ${sub}` : title} data-testid="tower-popup-title">
          <b>{title}</b>
          {sub && <span className="tower-popup-sub">{sub}</span>}
        </span>
        <button type="button" className={`tower-popup-btn${pinned ? " on" : ""}`} aria-pressed={pinned} title={pinned ? "取消固定：点楼的空白处或按 Esc 时关掉" : "固定：点楼的空白处、按 Esc 都不关，只有点 × 才关；点别的卡片照样换内容"} onClick={() => onPin(!pinned)} data-testid="tower-popup-pin">
          {pinned ? "已固定" : "固定"}
        </button>
        <button type="button" className="tower-popup-btn" title="切回对话视图，停在这里看的地方" onClick={onChat} data-testid="tower-popup-chat">
          切到对话
        </button>
        <button type="button" className="tower-popup-btn icon" aria-label="关闭弹窗" title="关闭" onClick={onClose} data-testid="tower-popup-close">
          <IconX />
        </button>
      </div>
      <span className="tower-popup-resize" aria-hidden="true" title="拖动调整大小" onPointerDown={start("size")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} data-testid="tower-popup-resize" />
    </>
  );
}

/** Above the conversation of a session, while 脉络 is on: which of the two to look at, and whether the session is a 脉络会话. */
export function TowerSwitch({ tower, on, off, onView, onToggle }: { tower: boolean; on: boolean; off?: string; onView(tower: boolean): void; onToggle(on: boolean): void }) {
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
