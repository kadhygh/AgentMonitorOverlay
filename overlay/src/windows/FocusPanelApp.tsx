import { useEffect, useRef, useState } from "react";
import { Focus, List, Maximize2, Plus, RefreshCw, Settings2, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CardRequestError, executeCardCommands, loadCard, type CardCommandOperation } from "../api/cardClient";
import { useFocusCards } from "../focus/useFocusCards";
import { NewCardForm } from "../focus/NewCardForm";
import { FocusCardEditor } from "../focus/FocusCardEditor";
import { FocusDialog } from "../focus/FocusDialog";
import { TaskGroupSettings } from "../focus/TaskGroupSettings";
import { useFocusInputRegions } from "../focus/useFocusInputRegions";
import { cardsInGroup, groupCommand, manualLanes } from "../focus/manualGroups";
import { useAmoThemeRuntime } from "../theme/amoTheme";
import { closeUtilityWindow, useUtilityWindowLifecycle } from "./utilityWindow";
import "../focus/focus.css";

// Temporarily disabled: populate Focus from existing TaskCards instead.
// Keep the standalone creation form and its draft handling for a later iteration.
const MANUAL_CARD_CREATION_ENABLED = false;

export function FocusPanelApp() {
  useUtilityWindowLifecycle("focus"); useAmoThemeRuntime();
  const feed = useFocusCards();
  const [surface, setSurface] = useState<string | null>(null), [visited, setVisited] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null), [over, setOver] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const [context, setContext] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const [moveError, setMoveError] = useState(""), [moving, setMoving] = useState(false), [retry, setRetry] = useState(false);
  const movePending = useRef<{ cardId: string; operation: CardCommandOperation } | null>(null), moveBusy = useRef(false);
  const root = useRef<HTMLElement>(null), menu = useRef<HTMLDivElement>(null);
  const { inputRegionError, runWindowGesture } = useFocusInputRegions(root, !!dragging || !!surface || !!context, feed.visible);
  const lanes = manualLanes(feed.groups);
  function openCard(cardId: string) { setVisited(ids => ids.includes(cardId) ? ids : [...ids, cardId]); setSurface(cardId); setContext(null); }
  function endDrag() { dragId.current = null; setDragging(null); setOver(null); }
  useEffect(() => {
    const stop = () => endDrag();
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { endDrag(); setContext(null); } };
    window.addEventListener("dragend", stop); window.addEventListener("blur", stop); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("dragend", stop); window.removeEventListener("blur", stop); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => { if (context) menu.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [context]);
  async function move(cardId?: string, groupId: string | null = null) {
    if (moveBusy.current) return;
    moveBusy.current = true; setMoving(true); setMoveError(""); setContext(null);
    try {
      if (!movePending.current) {
        if (!cardId) return;
        const { card } = await loadCard(cardId);
        if (card.archivedAt) throw new Error("卡片已归档，请在全部分组中恢复后再移动。");
        movePending.current = { cardId, operation: { operationId: crypto.randomUUID(), expectedRevision: card.revision, commands: [groupCommand(card, groupId)] } };
      }
      const request = movePending.current;
      await executeCardCommands(request.cardId, request.operation);
      movePending.current = null; setRetry(false); feed.refresh();
    } catch (reason) {
      const certain = reason instanceof CardRequestError && reason.status >= 400 && reason.status < 500;
      if (certain) movePending.current = null;
      setRetry(!!movePending.current); setMoveError(reason instanceof Error ? reason.message : "无法移动卡片"); feed.refresh();
    } finally { moveBusy.current = false; setMoving(false); }
  }
  return <main ref={root} data-testid="focus-panel" className={`amo-focus-panel${dragging ? " is-dragging" : ""}`} onPointerDown={e => { if (!(e.target as HTMLElement).closest(".amo-focus-context")) setContext(null); }}>
    <header className="amo-focus-header" onPointerDown={event => {
      if ((event.target as HTMLElement).closest("button, input, select, textarea, label") || event.button !== 0) return;
      void runWindowGesture(() => getCurrentWindow().startDragging()).catch(reason => setMoveError(String(reason)));
    }}>
      <span data-focus-region className="amo-focus-brand"><Focus size={19} /><h1>Focus Panel</h1></span>
      <div className="amo-focus-header-actions">
        {MANUAL_CARD_CREATION_ENABLED && <button aria-label="新建卡片" title="新建卡片" onClick={() => setSurface("new")}><Plus size={16} /><span>新建卡片</span></button>}
        <button data-focus-region aria-label="全部分组" title="全部分组" onClick={() => setSurface("list")}><List size={17} /></button>
        <button data-focus-region aria-label="分组设置" title="分组设置" onClick={() => setSurface("settings")}><Settings2 size={16} /></button>
        <button data-focus-region aria-label="刷新" title="刷新" onClick={feed.refresh}><RefreshCw size={15} /></button>
        <button data-focus-region aria-label="调整面板大小" title="拖动调整面板大小" onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); void runWindowGesture(() => getCurrentWindow().startResizeDragging("SouthEast")).catch(reason => setMoveError(String(reason))); }}><Maximize2 size={15} /></button>
        <button data-focus-region aria-label="关闭 Focus Panel" title="隐藏面板，保留草稿" onClick={() => void closeUtilityWindow("focus")}><X size={16} /></button>
      </div>
    </header>
    {feed.error && <div data-focus-region role="alert" className="amo-focus-error">{feed.error}<button onClick={feed.refresh}>重试刷新</button></div>}
    {inputRegionError && <div data-focus-region role="alert" className="amo-focus-error">{inputRegionError}</div>}
    <section className="amo-focus-lanes" aria-label="任务分组">
      {lanes.map(group => <section key={group.groupId ?? "ungrouped"} data-testid="focus-group" data-group-id={group.groupId ?? ""} className={`amo-focus-lane${group.dragOnly ? " is-drag-only" : ""}${over === (group.groupId ?? "") ? " is-over" : ""}`} onDragOver={e => {
        if (!dragId.current || moving || retry) return;
        e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(group.groupId ?? "");
      }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }} onDrop={e => {
        if (!dragId.current || moving || retry) return;
        e.preventDefault(); const id = dragId.current; endDrag(); void move(id, group.groupId);
      }}>
        <div className="amo-focus-lane-title"><span data-focus-region>{group.name}</span>{!group.dragOnly && <small data-focus-region>{cardsInGroup(feed.cards, group.groupId, feed.groups).length}</small>}</div>
        <div className="amo-focus-tiles">{group.dragOnly ? <span className="amo-focus-drop-label">放到这里</span> : cardsInGroup(feed.cards, group.groupId, feed.groups).map(card => <button data-focus-region key={card.cardId} data-testid="focus-card" data-card-id={card.cardId} className="amo-focus-tile" draggable={!moving && !retry} onDragStart={e => {
          dragId.current = card.cardId; e.dataTransfer.setData("text/plain", card.cardId); e.dataTransfer.effectAllowed = "move"; setDragging(card.cardId); setContext(null);
        }} onClick={() => { if (!dragId.current) openCard(card.cardId); }} onContextMenu={e => {
          e.preventDefault(); const bounds = root.current?.getBoundingClientRect(); if (!bounds) return;
          setContext({ cardId: card.cardId, x: Math.max(8, Math.min(e.clientX - bounds.left, bounds.width - 220)), y: Math.max(8, Math.min(e.clientY - bounds.top, bounds.height - 200)) });
        }}>{card.title}</button>)}</div>
      </section>)}
      {!feed.loading && !lanes.length && <div data-focus-region className="amo-focus-empty"><p>先创建分组，再从已有 TaskCard 加入。</p><button onClick={() => setSurface("settings")}>创建分组</button></div>}
      {feed.loading && <p data-focus-region className="amo-focus-empty" role="status">正在读取卡片…</p>}
    </section>
    {moveError && <div data-focus-region className="amo-focus-error" role="alert">{moveError}{retry && <button disabled={moving} onClick={() => void move()}>Retry same request</button>}</div>}
    {moving && <footer data-focus-region className="amo-focus-footer" role="status">正在保存分组…</footer>}
    {context && <div ref={menu} role="menu" aria-label="移至分组" className="amo-focus-context" style={{ left: context.x, top: context.y, maxHeight: Math.max(80, (root.current?.clientHeight ?? 540) - context.y - 8) }}><strong>移至分组</strong>{feed.groups.map(group => <button role="menuitem" key={group.groupId} disabled={moving || retry} onClick={() => void move(context.cardId, group.groupId)}>{group.name}</button>)}</div>}
    <TaskGroupSettings groups={feed.groups} revision={feed.groupRevision} reviewGroupId={feed.reviewGroupId} open={surface === "settings"} onClose={() => setSurface(null)} onChanged={feed.refresh} />
    {surface === "list" && <FocusDialog title="全部分组" onClose={() => setSurface(null)}>
      {lanes.map(group => <details className="amo-focus-group-list" key={group.groupId ?? "ungrouped"} open><summary>{group.name}<span>{cardsInGroup(feed.cards, group.groupId, feed.groups, true).length}</span>{group.dragOnly && <small>仅拖拽时显示</small>}</summary>{cardsInGroup(feed.cards, group.groupId, feed.groups, true).map(card => <button className="amo-focus-list-card" key={card.cardId} onClick={() => openCard(card.cardId)}><span>{card.title}</span>{card.archivedAt && <small>已归档</small>}</button>)}</details>)}
      {!lanes.length && <p>还没有分组或卡片。</p>}
      {visited.filter(id => !feed.cards.some(c => c.cardId === id)).map(id => <button key={id} onClick={() => openCard(id)}>找回卡片草稿 · {id.slice(-8)}</button>)}
    </FocusDialog>}
    {MANUAL_CARD_CREATION_ENABLED && <div hidden={surface !== "new"}><FocusDialog title="新建卡片" onClose={() => setSurface(null)}><NewCardForm open={surface === "new"} groups={feed.groups} onClose={() => setSurface(null)} onCreated={id => { feed.refresh(); openCard(id); }} /></FocusDialog></div>}
    {visited.map(id => <FocusCardEditor key={id} cardId={id} card={feed.cards.find(card => card.cardId === id)} groups={feed.groups} open={surface === id} onClose={() => setSurface(null)} onChanged={feed.refresh} onList={() => setSurface("list")} />)}
  </main>;
}
