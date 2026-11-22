import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { gridStyle, linkCurve, nearestSide, sidePoint } from "../../ui/src/canvas/geometry.js";
import { applyRecords, deletedItems, emptyBoard, fitView, freeSpot, fromSnapshot, live, lockedBy, moveOps, nextUndo, setLock, toBoard, zoomAt, type BoardModel } from "./boardState.js";
import { agentOf, subState, useCowork } from "./CoworkChat.js";
import { Avatar, avatarColor, timeText, useDisplayName } from "./bits.js";
import { Dialog, Field } from "./Dialog.js";
import { errorText } from "./Messages.js";
import { useSession } from "./session.js";
import { RelayClientError, type BoardFields, type BoardItem, type BoardNewItem, type BoardOp, type BoardOpRecord, type BoardPresence, type BoardRef } from "./shared.js";

// A 协作's 白板 (2026-11-23, plans/cowork.md「白板怎么借 Studio 的画布」「白板：多人同时改」, prototype A's board): a floating
// window over the 协作 page. Cards — 便签, 子会话卡, 引用卡 (a file at a commit, a document's version, a link; 已过时 when a
// newer commit of the file came), 分组 and 连线 — on an infinite plane that pans and zooms; the curves and the dot grid are
// Studio's canvas geometry (ui/src/canvas/geometry.ts). Several people and AIs change it at once: every change is one
// operation the service numbers and pushes (boardState.ts holds the result); a drag shows only here and as a ghost to the
// others until it is let go; a card's text is written under a soft lock (「小周 在写」, read-only for the rest); a text
// written on an older version becomes 「另一版」 and the card asks which to keep; deletes go to 最近删除; Ctrl+Z takes back
// only my own steps; what I did while the service was out is sent again, in order, when it is back.

const DEFAULT: Record<string, { w: number; h: number }> = { note: { w: 220, h: 120 }, session: { w: 250, h: 112 }, ref: { w: 240, h: 100 }, group: { w: 460, h: 300 } };
const COLORS: Array<{ id: string | null; label: string }> = [
  { id: null, label: "无" },
  { id: "yellow", label: "黄" },
  { id: "green", label: "绿" },
  { id: "blue", label: "蓝" },
  { id: "red", label: "红" },
];
const AI_RECENT_MS = 90_000;
const LOCK_RENEW_MS = 10_000;
const PRESENCE_MS = 8_000;
const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const KIND_WORD: Record<string, string> = { note: "便签", session: "子会话", ref: "引用", group: "分组", link: "连线" };
const REF_WORD: Record<BoardRef["kind"], string> = { file: "文件", commit: "提交", doc: "文档", url: "链接" };

type Drag = { id: string; kind: "move" | "size" | "link"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number; moved: boolean; pointer: number };

export function BoardBody({ focus }: { focus: { session: string; n: number } | null }) {
  const { session, cowork, me, toast, openSub } = useCowork();
  const show = useDisplayName();
  const { connection } = useSession(session);
  const [model, setModel] = useState<BoardModel>(emptyBoard);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [presence, setPresence] = useState<BoardPresence[]>([]);
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
  const [linkTo, setLinkTo] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [pop, setPop] = useState<null | { kind: "deleted" } | { kind: "history"; id: string } | { kind: "conflict"; id: string } | { kind: "ref" } | { kind: "session" }>(null);
  const [now, setNow] = useState(Date.now());
  const plane = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number; pointer: number } | null>(null);
  const id = cowork.id;
  const ended = !!cowork.endedAt;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // The board from the service, then what it pushes.
  const box = () => ({ w: plane.current?.clientWidth || 800, h: plane.current?.clientHeight || 500 });
  const load = useCallback(
    async (after: number) => {
      const s = await session.client.coworkBoard(id, after);
      setModel((m) => fromSnapshot(m, s, me));
    },
    [session, id, me],
  );
  useEffect(() => {
    let alive = true;
    session.client
      .coworkBoard(id, 0)
      .then((s) => {
        if (!alive) return;
        const m = fromSnapshot(emptyBoard(), s, me);
        setModel(m);
        setView(fitView(m, box()));
        setLoaded(true);
      })
      .catch((err) => toast(errorText(err)));
    const off = session.onBoard((cw, p) => {
      if (cw !== id) return;
      if (p.type === "board") setModel((m) => applyRecords(m, p.ops, me));
      else if (p.type === "board-lock") setModel((m) => setLock(m, p.card, p.lock));
      else setPresence(p.presence);
    });
    return () => {
      alive = false;
      off();
    };
  }, [session, id, me]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back online: what was missed, then what I did meanwhile (each with its opId: nothing applies twice).
  const flushing = useRef(false);
  useEffect(() => {
    if (connection !== "online" || !loaded || flushing.current) return;
    flushing.current = true;
    void (async () => {
      try {
        await load(modelRef.current.seq);
        const pending = modelRef.current.pending;
        if (pending.length) {
          setModel((m) => ({ ...m, pending: [] }));
          await send(pending, true);
        }
      } catch {
        // still out: tried again when the connection comes back
      } finally {
        flushing.current = false;
      }
    })();
  }, [connection, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Who I am looking at what (repeated while open; gone when closed).
  const sel = useRef<string | null>(null);
  sel.current = selected;
  useEffect(() => {
    const say = (dragging: { id: string; x: number; y: number } | null = null) => session.sendFrame({ type: "board-presence", coworkId: id, selected: sel.current ? [sel.current] : [], dragging, open: true });
    say();
    const t = setInterval(() => say(), PRESENCE_MS);
    return () => {
      clearInterval(t);
      session.sendFrame({ type: "board-presence", coworkId: id, open: false });
    };
  }, [session, id]);
  useEffect(() => session.sendFrame({ type: "board-presence", coworkId: id, selected: selected ? [selected] : [], dragging: null, open: true }), [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastSaid = useRef(0);
  const sayDrag = (d: { id: string; x: number; y: number } | null) => {
    const t = Date.now();
    if (d && t - lastSaid.current < 200) return;
    lastSaid.current = t;
    session.sendFrame({ type: "board-presence", coworkId: id, selected: selected ? [selected] : [], dragging: d, open: true });
  };

  /** Operations to the service; the cards come back as they are after. Offline: kept here and sent when back. */
  const send = async (ops: BoardOp[], replay = false): Promise<BoardOpRecord[]> => {
    if (!ops.length) return [];
    try {
      const r = await session.client.coworkBoardOps(id, ops);
      setModel((m) => applyRecords(m, r.applied, me));
      const rej = r.rejected.filter((x) => x.code !== "exists");
      if (rej.length) {
        const x = rej[0]!;
        toast(x.code === "locked" ? `${show(x.by ?? "别人")} 正在写这张卡，等一会儿再改` : x.code === "nothing" ? "没有可以撤销的了（只撤销你自己的改动）" : x.message);
        if (x.code !== "nothing") void load(modelRef.current.seq).catch(() => undefined);
      }
      return r.applied;
    } catch (err) {
      if (err instanceof RelayClientError && err.status) {
        toast(errorText(err));
        return [];
      }
      setModel((m) => ({ ...m, pending: [...m.pending, ...ops] }));
      if (!replay) toast("连不上服务：改动先存在本机，连上后按顺序补发");
      return [];
    }
  };
  /** A change shown at once (the service's answer replaces it with the card's next version). */
  const local = (cardId: string, f: Partial<BoardItem>) => setModel((m) => (m.items[cardId] ? { ...m, items: { ...m.items, [cardId]: { ...m.items[cardId]!, ...f } } } : m));

  const add = async (item: BoardNewItem, edit = false) => {
    const size = DEFAULT[item.kind] ?? DEFAULT.note!;
    const spot = freeSpot(model, view, box(), size);
    const cardId = item.id ?? newId("c");
    const applied = await send([{ op: "add", opId: newId("o"), item: { ...size, ...spot, ...item, id: cardId } }]);
    setSelected(cardId);
    if (edit && applied.length) void startEdit(cardId, "");
    return cardId;
  };

  // 在白板上看 from a 子会话: its card selected and in the middle (put on the board when it is not there yet).
  useEffect(() => {
    if (!focus || !loaded) return;
    const card = live(modelRef.current).find((i) => i.kind === "session" && i.session === focus.session);
    const centre = (c: { x: number; y: number; w: number; h: number }) => {
      const b = box();
      setView((v) => ({ ...v, x: b.w / 2 - (c.x + c.w / 2) * v.k, y: b.h / 2 - (c.y + c.h / 2) * v.k }));
    };
    if (card) {
      setSelected(card.id);
      centre(card);
    } else if (!ended) {
      void add({ kind: "session", session: focus.session }).then((cid) => {
        toast("放上了这个子会话的卡");
        const c = modelRef.current.items[cid];
        if (c) centre(c);
      });
    }
  }, [focus?.n, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- writing a card's text under the soft lock
  const lockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startEdit = async (cardId: string, initial?: string) => {
    const it = modelRef.current.items[cardId];
    if (!it || ended) return;
    const by = lockedBy(modelRef.current, cardId, me);
    if (by) return toast(`${show(by)} 正在写这张卡；还能拖动它、连线`);
    try {
      const l = await session.client.coworkBoardLock(id, cardId, true);
      setModel((m) => setLock(m, cardId, l));
    } catch (err) {
      return toast(err instanceof RelayClientError && err.status === 409 ? "别人正在写这张卡" : errorText(err));
    }
    setEditing({ id: cardId, text: initial ?? it.text });
    if (lockTimer.current) clearInterval(lockTimer.current);
    lockTimer.current = setInterval(() => void session.client.coworkBoardLock(id, cardId, true).catch(() => undefined), LOCK_RENEW_MS);
  };
  const endEdit = async (save: boolean) => {
    const e = editing;
    if (!e) return;
    setEditing(null);
    if (lockTimer.current) clearInterval(lockTimer.current);
    lockTimer.current = null;
    const it = modelRef.current.items[e.id];
    if (save && it && e.text !== it.text) {
      local(e.id, { text: e.text });
      await send([{ op: "set", opId: newId("o"), id: e.id, base: it.version, fields: { text: e.text } }]);
    }
    void session.client.coworkBoardLock(id, e.id, false).catch(() => undefined);
    setModel((m) => setLock(m, e.id, null));
  };
  useEffect(() => () => void (lockTimer.current && clearInterval(lockTimer.current)), []);

  // ---- pointer: cards move, size and link; empty space pans; the wheel zooms
  const onCardDown = (e: ReactPointerEvent, it: BoardItem, kind: Drag["kind"] = "move") => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, textarea, input, a")) return;
    e.stopPropagation();
    setSelected(it.id);
    if (ended && kind !== "move") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: it.id, kind, sx: e.clientX, sy: e.clientY, ox: it.x, oy: it.y, ow: it.w, oh: it.h, moved: false, pointer: e.pointerId };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d && d.pointer === e.pointerId) {
      const dx = (e.clientX - d.sx) / view.k;
      const dy = (e.clientY - d.sy) / view.k;
      if (!d.moved && Math.hypot(dx, dy) * view.k < 4) return;
      d.moved = true;
      if (d.kind === "move" && !ended) {
        setGhost({ id: d.id, x: d.ox + dx, y: d.oy + dy, w: d.ow, h: d.oh });
        sayDrag({ id: d.id, x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) });
      } else if (d.kind === "size") setGhost({ id: d.id, x: d.ox, y: d.oy, w: Math.max(140, d.ow + dx), h: Math.max(70, d.oh + dy) });
      else if (d.kind === "link") {
        const r = plane.current!.getBoundingClientRect();
        setLinkTo(toBoard(view, { x: e.clientX - r.left, y: e.clientY - r.top }));
      }
      return;
    }
    const p = pan.current;
    if (p && p.pointer === e.pointerId) setView((v) => ({ ...v, x: p.ox + e.clientX - p.sx, y: p.oy + e.clientY - p.sy }));
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d && d.pointer === e.pointerId) {
      drag.current = null;
      const g = ghost;
      setGhost(null);
      if (d.kind === "link") {
        const at = linkTo;
        setLinkTo(null);
        if (!at) return;
        const target = [...live(modelRef.current)].reverse().find((c) => c.kind !== "link" && c.kind !== "group" && c.id !== d.id && at.x >= c.x && at.x <= c.x + c.w && at.y >= c.y && at.y <= c.y + c.h) ?? [...live(modelRef.current)].reverse().find((c) => c.kind === "group" && c.id !== d.id && at.x >= c.x && at.x <= c.x + c.w && at.y >= c.y && at.y <= c.y + c.h);
        if (target && !live(modelRef.current).some((l) => l.kind === "link" && l.from === d.id && l.to === target.id)) void send([{ op: "add", opId: newId("o"), item: { id: newId("l"), kind: "link", from: d.id, to: target.id } }]);
        return;
      }
      if (!d.moved || !g || ended) return;
      sayDrag(null);
      if (d.kind === "move") {
        const ops = moveOps(modelRef.current, d.id, g.x, g.y, () => newId("o"));
        for (const o of ops) if (o.op === "set") local(o.id, o.fields as Partial<BoardItem>);
        void send(ops);
      } else {
        const it = modelRef.current.items[d.id];
        const fields: BoardFields = { w: Math.round(g.w), h: Math.round(g.h) };
        local(d.id, fields as Partial<BoardItem>);
        if (it) void send([{ op: "set", opId: newId("o"), id: d.id, base: it.version, fields }]);
      }
      return;
    }
    if (pan.current?.pointer === e.pointerId) pan.current = null;
  };
  const onPlaneDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    setSelected(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pan.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, pointer: e.pointerId };
  };
  useEffect(() => {
    const el = plane.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => zoomAt(v, e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX - r.left, y: e.clientY - r.top }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const zoomBy = (f: number) => {
    const b = box();
    setView((v) => zoomAt(v, f, { x: b.w / 2, y: b.h / 2 }));
  };

  // ---- what the selected card can do
  const sel0 = selected ? model.items[selected] : null;
  const remove = (cardId: string) => {
    const it = modelRef.current.items[cardId];
    if (!it) return;
    const by = lockedBy(modelRef.current, cardId, me);
    if (by) return toast(`${show(by)} 正在写这张卡，不能删`);
    setSelected(null);
    // A card's lines go with it (they come back with it from 最近删除 one by one).
    const lines = live(modelRef.current).filter((l) => l.kind === "link" && (l.from === cardId || l.to === cardId));
    void send([{ op: "delete", opId: newId("o"), id: cardId }, ...lines.map((l): BoardOp => ({ op: "delete", opId: newId("o"), id: l.id }))]);
  };
  const undo = () => {
    const seq = nextUndo(modelRef.current);
    if (seq == null) return toast("没有可以撤销的了（只撤销你自己的改动）");
    void send([{ op: "undo", opId: newId("o"), seq }]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("textarea, input")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !ended) {
      e.preventDefault();
      remove(selected);
    } else if (e.key === "Escape") setSelected(null);
  };

  const items = live(model);
  const cards = items.filter((i) => i.kind !== "link");
  const groups = cards.filter((i) => i.kind === "group");
  const others = presence.filter((p) => p.name !== me);
  const viewers = [...new Set([me, ...presence.map((p) => p.name)])];
  const recentAi = items.filter((i) => i.updatedAgent && now - i.updatedAt < AI_RECENT_MS).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const rectOf = (it: BoardItem) => (ghost?.id === it.id ? ghost : it);
  const sessionsOn = new Set(items.filter((i) => i.kind === "session").map((i) => i.session));
  const deleted = deletedItems(model);

  return (
    <div className="bd" tabIndex={0} onKeyDown={onKey} aria-label="白板">
      <div className="bd-bar">
        <span className="bd-viewers" title={viewers.map(show).join("、")}>
          {viewers.slice(0, 5).map((n) => (
            <Avatar key={n} name={n} small />
          ))}
          <span>{viewers.length} 人在看</span>
        </span>
        {recentAi && <span className="muted tiny">· {agentOf(cowork, recentAi.updatedAgent)?.name ?? "AI"} 刚改过一张</span>}
        {model.pending.length > 0 && <span className="cw-chip st-owner">! {model.pending.length} 条改动等连上后补发</span>}
        <span className="grow" />
        {!ended && (
          <>
            <button type="button" className="small" onClick={() => void add({ kind: "note", text: "" }, true)}>
              ＋ 便签
            </button>
            <button type="button" className="small" onClick={() => setPop({ kind: "session" })}>
              ＋ 子会话卡
            </button>
            <button type="button" className="small" onClick={() => setPop({ kind: "ref" })}>
              ＋ 引用文件 / 提交
            </button>
            <button type="button" className="small" onClick={() => void add({ kind: "group", text: "分组" })}>
              ＋ 分组
            </button>
          </>
        )}
        <button type="button" className="small" onClick={() => setPop(pop?.kind === "deleted" ? null : { kind: "deleted" })}>
          最近删除 · {deleted.length}
        </button>
      </div>
      {sel0 && (
        <div className="bd-selbar" aria-label="选中的卡">
          <span className="muted tiny">
            {KIND_WORD[sel0.kind]} · {show(sel0.createdBy)} 加的
          </span>
          {!ended && (sel0.kind === "note" || sel0.kind === "group") && (
            <button type="button" className="small" onClick={() => void startEdit(sel0.id)}>
              改字
            </button>
          )}
          {!ended &&
            sel0.kind !== "link" &&
            COLORS.map((c) => (
              <button key={c.label} type="button" className={`bd-swatch c-${c.id ?? "none"} ${sel0.color === c.id ? "on" : ""}`} title={`颜色：${c.label}`} aria-label={`颜色：${c.label}`} onClick={() => (local(sel0.id, { color: c.id }), void send([{ op: "set", opId: newId("o"), id: sel0.id, base: sel0.version, fields: { color: c.id } }]))} />
            ))}
          {!ended && sel0.kind === "ref" && (
            <button type="button" className="small" onClick={() => void send([{ op: "set", opId: newId("o"), id: sel0.id, base: sel0.version, fields: { stale: !sel0.stale } }])}>
              {sel0.stale ? "不再标过时" : "标已过时"}
            </button>
          )}
          <button type="button" className="small" onClick={() => setPop({ kind: "history", id: sel0.id })}>
            改动记录
          </button>
          {!ended && (
            <button type="button" className="small ghost" onClick={() => remove(sel0.id)}>
              删除
            </button>
          )}
        </div>
      )}
      <div className="bd-plane" ref={plane} style={gridStyle(view)} onPointerDown={onPlaneDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="bd-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {groups.map((g) => (
            renderCard(g, rectOf(g))
          ))}
          <svg className="bd-links" aria-hidden="true">
            <defs>
              <marker id={`bd-arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" />
              </marker>
            </defs>
            {items
              .filter((l) => l.kind === "link" && l.from && l.to && model.items[l.from] && model.items[l.to] && !model.items[l.from]!.deleted && !model.items[l.to]!.deleted)
              .map((l) => {
                const a = rectOf(model.items[l.from!]!);
                const b = rectOf(model.items[l.to!]!);
                const aSide = nearestSide(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
                const bSide = nearestSide(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
                const c = linkCurve(sidePoint(a, aSide), aSide, sidePoint(b, bSide), bSide);
                return (
                  <g key={l.id} className={`bd-link ${selected === l.id ? "on" : ""}`}>
                    <path d={c.d} className="hit" onPointerDown={(e) => (e.stopPropagation(), setSelected(l.id))} />
                    <path d={c.d} markerEnd={`url(#bd-arrow-${id})`} />
                  </g>
                );
              })}
            {linkTo && drag.current?.kind === "link" && model.items[drag.current.id] && (() => {
              const a = model.items[drag.current.id]!;
              const aSide = nearestSide(a, linkTo);
              return <path className="bd-link-draft" d={linkCurve(sidePoint(a, aSide), aSide, linkTo, null).d} />;
            })()}
          </svg>
          {cards
            .filter((c) => c.kind !== "group")
            .map((c) => (
              renderCard(c, rectOf(c))
            ))}
          {others
            .filter((p) => p.dragging && model.items[p.dragging.id])
            .map((p) => {
              const it = model.items[p.dragging!.id]!;
              return (
                <div key={`g-${p.name}`} className="bd-ghost" style={{ left: p.dragging!.x, top: p.dragging!.y, width: it.w, height: it.h, borderColor: avatarColor(p.name) }}>
                  <span style={{ background: avatarColor(p.name) }}>{show(p.name)} 在拖</span>
                </div>
              );
            })}
        </div>
        {loaded && !cards.length && <div className="bd-empty muted">白板还是空的：放一张便签，或者把子会话、文件、提交引上来。AI 也会往上放东西。</div>}
      </div>
      <div className="bd-foot">
        <button type="button" className="small" onClick={() => zoomBy(1 / 1.2)} aria-label="缩小">
          −
        </button>
        <span className="bd-zoom">{Math.round(view.k * 100)}%</span>
        <button type="button" className="small" onClick={() => zoomBy(1.2)} aria-label="放大">
          ＋
        </button>
        <button type="button" className="small" onClick={() => setView(fitView(model, box()))}>
          回到中间
        </button>
        <span className="grow" />
        <span className="muted tiny">空白处拖动平移 · 滚轮缩放 · 卡片右边的点拖出连线 · Ctrl+Z 只撤销你自己的</span>
      </div>
      {pop?.kind === "deleted" && (
        <BoardPop title={`最近删除 · ${deleted.length}`} onClose={() => setPop(null)} foot="删掉的留到协作结束。别人正在写的卡不能删。">
          {!deleted.length && <div className="muted tiny">没有删掉的。</div>}
          {deleted.map((d) => (
            <div key={d.id} className="bd-pop-row">
              <span className="grow">
                {KIND_WORD[d.kind]}「{cardTitle(d, cowork.sessions)}」
                <span className="muted tiny">
                  {" "}
                  {d.deletedBy ? show(d.deletedBy) : ""} 删的 · {d.deletedAt ? timeText(d.deletedAt) : ""}
                </span>
              </span>
              {!ended && (
                <button type="button" className="small" onClick={() => void send([{ op: "restore", opId: newId("o"), id: d.id }])}>
                  找回
                </button>
              )}
            </div>
          ))}
        </BoardPop>
      )}
      {pop?.kind === "history" && <HistoryPop cardId={pop.id} title={model.items[pop.id] ? cardTitle(model.items[pop.id]!, cowork.sessions) : ""} onClose={() => setPop(null)} />}
      {pop?.kind === "conflict" && model.items[pop.id]?.alt && (
        <ConflictDialog
          it={model.items[pop.id]!}
          onClose={() => setPop(null)}
          onKeep={(keep, both) => {
            const it = model.items[pop.id]!;
            const ops: BoardOp[] = [{ op: "resolve", opId: newId("o"), id: it.id, keep }];
            if (both) {
              const nid = newId("c");
              ops.push({ op: "add", opId: newId("o"), item: { id: nid, kind: "note", x: it.x + it.w + 40, y: it.y, w: it.w, h: it.h, text: it.alt!.text } }, { op: "add", opId: newId("o"), item: { id: newId("l"), kind: "link", from: nid, to: it.id } });
            }
            setPop(null);
            void send(ops);
          }}
        />
      )}
      {pop?.kind === "ref" && <RefDialog onClose={() => setPop(null)} onAdd={(ref) => (setPop(null), void add({ kind: "ref", ref }))} />}
      {pop?.kind === "session" && (
        <BoardPop title="放一张子会话卡" onClose={() => setPop(null)}>
          {!cowork.sessions.length && <div className="muted tiny">这个协作还没有子会话。</div>}
          {cowork.sessions.map((s) => (
            <div key={s.id} className="bd-pop-row">
              <span className="grow">
                {s.title} <span className="muted tiny">{subState(s, show, me).word}</span>
              </span>
              <button type="button" className="small" disabled={sessionsOn.has(s.id)} onClick={() => (setPop(null), void add({ kind: "session", session: s.id }))}>
                {sessionsOn.has(s.id) ? "已在白板上" : "放上去"}
              </button>
            </div>
          ))}
        </BoardPop>
      )}
    </div>
  );

  // A plain function, not a component: a component made inside would be a new kind each time and lose the text box.
  function renderCard(it: BoardItem, r: { x: number; y: number; w: number; h: number }) {
    const by = lockedBy(model, it.id, me, now);
    const theirs = others.filter((p) => p.selected.includes(it.id));
    const aiNew = !!it.updatedAgent && now - it.updatedAt < AI_RECENT_MS;
    const isEditing = editing?.id === it.id;
    const sub = it.kind === "session" ? cowork.sessions.find((s) => s.id === it.session) : undefined;
    const outline = theirs[0] ? avatarColor(theirs[0].name) : undefined;
    const creator = it.updatedAgent ? (agentOf(cowork, it.updatedAgent)?.name ?? "AI") : show(it.createdBy);
    let head: ReactNode;
    let body: ReactNode;
    if (it.kind === "group") {
      head = null;
      body = null;
    } else if (it.kind === "session") {
      const st = sub ? subState(sub, show, me) : null;
      head = (
        <>
          子会话{st ? ` · ${st.word}` : ""}
        </>
      );
      body = (
        <>
          <b className="bd-title">{sub?.title ?? "（子会话不见了）"}</b>
          <span className="bd-meta">{sub?.conclusion ? `结论：${sub.conclusion}` : sub ? `${show(sub.from)} → ${show(sub.to)}` : ""}</span>
          {sub && (
            <button type="button" className="link tiny" onClick={() => openSub(sub.id)}>
              打开子会话
            </button>
          )}
        </>
      );
    } else if (it.kind === "ref") {
      const ref = it.ref;
      head = (
        <>
          引用 · {ref ? REF_WORD[ref.kind] : ""}
          {it.stale && <span className="bd-stale">! 已过时</span>}
        </>
      );
      body = (
        <>
          <b className="bd-title">{ref?.title || ref?.path || ref?.url || it.text || "（引用）"}</b>
          <span className="bd-meta">{[ref?.commit ? `依据 ${ref.commit.slice(0, 7)}` : "", ref?.version ? `版本 ${ref.version}` : "", ref?.path && ref.title ? ref.path : ""].filter(Boolean).join(" · ")}</span>
        </>
      );
    } else {
      head = <>便签 · {creator}</>;
      body = isEditing ? (
        <textarea
          className="bd-edit"
          autoFocus
          value={editing!.text}
          onChange={(e) => setEditing({ id: it.id, text: e.target.value })}
          onBlur={() => void endEdit(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") void endEdit(false);
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void endEdit(true);
          }}
          aria-label="便签的字"
        />
      ) : (
        <span className="bd-text">{it.text || <span className="muted">（双击写字）</span>}</span>
      );
    }
    return (
      <div
        key={it.id}
        className={`bd-card k-${it.kind} c-${it.color ?? "none"} ${selected === it.id ? "on" : ""} ${aiNew ? "ai-new" : ""} ${it.stale ? "stale" : ""} ${by ? "locked" : ""}`}
        data-card={it.id}
        style={{ left: r.x, top: r.y, width: r.w, height: r.h, ...(outline ? { outlineColor: outline } : {}) }}
        onPointerDown={(e) => onCardDown(e, it)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => (it.kind === "note" || it.kind === "group") && void startEdit(it.id)}
      >
        {it.kind === "group" ? (
          <div className="bd-group-head">{isEditing ? <input className="bd-edit-line" autoFocus value={editing!.text} onChange={(e) => setEditing({ id: it.id, text: e.target.value })} onBlur={() => void endEdit(true)} onKeyDown={(e) => (e.key === "Enter" ? void endEdit(true) : e.key === "Escape" ? void endEdit(false) : undefined)} aria-label="分组名" /> : it.text || "分组"}</div>
        ) : (
          <>
            <span className="bd-head">{head}</span>
            {body}
          </>
        )}
        <span className="bd-tags">
          {theirs.map((p) => (
            <span key={p.name} className="bd-tag who" style={{ background: avatarColor(p.name) }}>
              {show(p.name)} 选中
            </span>
          ))}
          {by && <span className="bd-tag lock">{show(by)} 在写…</span>}
          {aiNew && <span className="bd-tag ai">AI 刚改</span>}
        </span>
        {it.alt && (
          <button type="button" className="bd-conflict" onClick={() => setPop({ kind: "conflict", id: it.id })}>
            ! 有冲突，看另一版
          </button>
        )}
        {by && it.kind === "note" && <span className="bd-readonly muted tiny">文字只读：{show(by)} 在写 · 还能拖动和连线</span>}
        {!ended && it.kind !== "group" && <span className="bd-handle" title="拖到另一张卡上连线" onPointerDown={(e) => onCardDown(e, it, "link")} />}
        {!ended && <span className="bd-size" title="拖动改大小" onPointerDown={(e) => onCardDown(e, it, "size")} />}
      </div>
    );
  }
}

function cardTitle(it: BoardItem, sessions: Array<{ id: string; title: string }>): string {
  if (it.kind === "session") return sessions.find((s) => s.id === it.session)?.title ?? "子会话";
  if (it.kind === "ref") return it.ref?.title || it.ref?.path || it.ref?.url || "引用";
  return (it.text || KIND_WORD[it.kind] || "").replace(/\s+/g, " ").slice(0, 30);
}

function BoardPop({ title, onClose, children, foot }: { title: string; onClose: () => void; children: ReactNode; foot?: string }) {
  return (
    <div className="bd-pop" role="dialog" aria-label={title}>
      <div className="bd-pop-head">
        <b>{title}</b>
        <button type="button" className="small ghost" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="bd-pop-body">{children}</div>
      {foot && <div className="bd-pop-foot muted tiny">{foot}</div>}
    </div>
  );
}

const CHANGE_WORD: Record<string, string> = { x: "挪了位置", y: "挪了位置", w: "改了大小", h: "改了大小", text: "改了文字", color: "改了颜色", group: "换了分组", stale: "标了过时", ref: "改了引用", deleted: "删除", alt: "另一版" };

function HistoryPop({ cardId, title, onClose }: { cardId: string; title: string; onClose: () => void }) {
  const { session, cowork } = useCowork();
  const show = useDisplayName();
  const [ops, setOps] = useState<BoardOpRecord[] | null>(null);
  useEffect(() => {
    void session.client.coworkBoardHistory(cowork.id, cardId).then(setOps, () => setOps([]));
  }, [session, cowork.id, cardId]);
  const what = (r: BoardOpRecord) => {
    if (r.op === "add") return "加了这张卡";
    if (r.op === "delete") return "删了这张卡";
    if (r.op === "restore") return "找回了这张卡";
    if (r.op === "undo") return "撤销了自己的一步";
    if (r.op === "resolve") return "在两版里挑了一版";
    const ch = r.changes.find((c) => c.id === cardId);
    const keys = [...new Set(Object.keys(ch?.after ?? {}).map((k) => CHANGE_WORD[k]).filter(Boolean))];
    if (ch && "text" in ch.after) return `改了文字：「${String(ch.before.text ?? "").slice(0, 20)}」→「${String(ch.after.text ?? "").slice(0, 20)}」${r.conflict ? "（成了另一版）" : ""}`;
    return keys.join("、") || "改了";
  };
  return (
    <BoardPop title={`改动记录 · 「${title}」`} onClose={onClose} foot="Ctrl+Z 只撤销你自己的改动，撤销也记一条。">
      {!ops && <div className="muted tiny">加载中…</div>}
      {ops?.map((r) => (
        <div key={r.seq} className="bd-pop-row">
          <span className="muted tiny bd-pop-time">{timeText(r.at)}</span>
          <span className="grow">
            {r.agent ? (agentOf(cowork, r.agent)?.name ?? `${show(r.actor)} 的 AI`) : show(r.actor)} {what(r)}
          </span>
        </div>
      ))}
    </BoardPop>
  );
}

function ConflictDialog({ it, onClose, onKeep }: { it: BoardItem; onClose: () => void; onKeep: (keep: "current" | "alt", both?: boolean) => void }) {
  const show = useDisplayName();
  const alt = it.alt!;
  return (
    <Dialog
      title="这张便签有两版"
      onClose={onClose}
      wide
      foot={
        <>
          <button type="button" onClick={() => onKeep("current", true)}>
            两版都留：另一版另放一张卡，连线指过去
          </button>
          <span className="grow" />
          <button type="button" className="ghost" onClick={onClose}>
            以后再说
          </button>
        </>
      }
    >
      <p className="muted tiny">有人断线时改了文字，连上后这张卡已经被改过。文字不互相覆盖：后来的那版存成了「另一版」，挑一版留下。</p>
      <div className="bd-versions">
        <div className="bd-version">
          <div className="muted tiny">
            {/* (the card's last change was the conflicting one: its author is 另一版's, not this text's) */}
            现在的版本 · 在白板上的
          </div>
          <div className="bd-version-text">{it.text}</div>
          <button type="button" onClick={() => onKeep("current")}>
            用这一版
          </button>
        </div>
        <div className="bd-version">
          <div className="muted tiny">
            另一版 · {show(alt.by)}
            {alt.agent ? " 的 AI" : ""} · {timeText(alt.at)}
          </div>
          <div className="bd-version-text">{alt.text}</div>
          <button type="button" className="primary" onClick={() => onKeep("alt")}>
            用这一版
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function RefDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (ref: BoardRef) => void }) {
  const [kind, setKind] = useState<BoardRef["kind"]>("file");
  const [path, setPath] = useState("");
  const [commit, setCommit] = useState("");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const ok = kind === "url" ? !!url.trim() : kind === "commit" ? !!commit.trim() : !!path.trim();
  const ref = useMemo<BoardRef>(() => ({ kind, ...(path.trim() && kind !== "url" ? { path: path.trim() } : {}), ...(commit.trim() && kind !== "url" ? { commit: commit.trim() } : {}), ...(url.trim() && kind === "url" ? { url: url.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}) }), [kind, path, commit, url, title]);
  return (
    <Dialog
      title="引用文件、提交或链接"
      onClose={onClose}
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={!ok} onClick={() => onAdd(ref)}>
            放上白板
          </button>
        </>
      }
    >
      <div className="bd-refkinds" role="radiogroup" aria-label="引用什么">
        {(["file", "commit", "doc", "url"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`small ${kind === k ? "primary" : ""}`} onClick={() => setKind(k)}>
            {REF_WORD[k]}
          </button>
        ))}
      </div>
      {kind === "url" ? (
        <Field label="链接">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>
      ) : (
        <>
          <Field label={kind === "commit" ? "改了的文件（可以空着）" : "仓库里的路径"}>
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="设计/加特林.md" />
          </Field>
          <Field label="依据的提交" hint="之后有人推了改这个文件的新提交，卡上会标「已过时」">
            <input value={commit} onChange={(e) => setCommit(e.target.value)} placeholder="3f2a91c" />
          </Field>
        </>
      )}
      <Field label="标题（可以空着）">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
    </Dialog>
  );
}
