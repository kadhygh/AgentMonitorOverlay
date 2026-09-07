import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, Check, CircleHelp, Link2, Minus, Plus, RotateCcw, Save, StickyNote, Trash2, X } from "lucide-react";
import { CanvasRequestError, loadCanvas, saveCanvas } from "../api/taskCanvasClient";
import { clamp, connectNodes, coordinate, edgePath, emptyDocument, removeNode, visibleNode, worldPoint, zoomAt, type CanvasBoard, type CanvasDocument, type CanvasNode } from "../canvas/model";
import { useCanvasSessions } from "../canvas/useCanvasSessions";
import { useAmoThemeRuntime } from "../theme/amoTheme";
import { closeUtilityWindow, startUtilityWindowDrag, useUtilityWindowLifecycle } from "./utilityWindow";
import "../canvas/canvas.css";

type Selection = { kind: "node" | "edge"; id: string } | null;
type Gesture = { pointer: number; kind: "pan" | "node"; id?: string; startX: number; startY: number; x: number; y: number; initial: CanvasDocument };
const titleOf = (s: { taskTitle?: string | null; title: string }) => s.taskTitle || s.title || "Untitled task";
const messageOf = (e: unknown) => e instanceof Error ? e.message : "Could not reach the broker";

export function CanvasWorkbenchApp() {
  useUtilityWindowLifecycle("canvas");
  useAmoThemeRuntime();
  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [draft, setDraft] = useState<CanvasDocument>(emptyDocument);
  const [savedDocument, setSavedDocument] = useState("");
  const [busy, setBusy] = useState<"loading" | "saving" | null>("loading");
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const [help, setHelp] = useState(false);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const loadGeneration = useRef(0);
  const pendingSave = useRef<{ operationId: string; expectedRevision: number; document: CanvasDocument; serialized: string } | null>(null);
  const dirty = !!board && JSON.stringify(draft) !== savedDocument;
  const sessions = useCanvasSessions(draft.nodes.flatMap(n => n.sessionId ? [n.sessionId] : []));
  const editable = !!board && busy !== "loading" && !reloadPrompt;
  const selectedNode = selection?.kind === "node" ? draft.nodes.find(n => n.id === selection.id) : undefined;
  const update = (fn: (current: CanvasDocument) => CanvasDocument) => { if (editable) setDraft(fn); };

  async function reload() {
    const generation = ++loadGeneration.current;
    gesture.current = null;
    setReloadPrompt(false); setBusy("loading"); setError("");
    try {
      const result = await loadCanvas();
      if (generation !== loadGeneration.current) return;
      setBoard(result.board); setDraft(result.board.document); setSavedDocument(JSON.stringify(result.board.document));
      pendingSave.current = null; setSelection(null); setConnectFrom(null);
    } catch (reason) { if (generation === loadGeneration.current) setError(messageOf(reason)); }
    finally { if (generation === loadGeneration.current) setBusy(null); }
  }
  useEffect(() => { void reload(); return () => { loadGeneration.current++; }; }, []);
  async function save() {
    if (!board || busy || reloadPrompt) return;
    // A timeout may mean the commit succeeded: retry that exact operation before saving newer edits.
    const operation = pendingSave.current ?? { operationId: crypto.randomUUID(), expectedRevision: board.revision, document: draft, serialized: JSON.stringify(draft) };
    pendingSave.current = operation;
    setBusy("saving"); setError("");
    try {
      const result = await saveCanvas(operation.operationId, operation.expectedRevision, operation.document);
      setBoard(result.board); setSavedDocument(operation.serialized); pendingSave.current = null;
    } catch (reason) {
      if (reason instanceof CanvasRequestError && reason.status < 500) pendingSave.current = null;
      setError(messageOf(reason));
    } finally { setBusy(null); }
  }
  function removeSelection() {
    if (!editable || !selection) return;
    update(d => selection.kind === "node" ? removeNode(d, selection.id) : { ...d, edges: d.edges.filter(e => e.id !== selection.id) });
    setSelection(null); setConnectFrom(null);
  }
  useEffect(() => {
    const observer = new ResizeObserver(entries => { const bounds = entries[0].contentRect; setSize({ width: bounds.width, height: bounds.height }); });
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (gesture.current) { setDraft(gesture.current.initial); gesture.current = null; }
        setSelection(null); setConnectFrom(null); setReloadPrompt(false); setHelp(false); return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); return; }
      if ((event.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelection(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!editable || (event.target as HTMLElement).closest("textarea")) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      update(d => ({ ...d, viewport: zoomAt(d.viewport, event.clientX - rect.left, event.clientY - rect.top, d.viewport.zoom * Math.exp(-event.deltaY * .0015)) }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [editable]);

  function addNode(kind: "task" | "note", sessionId?: string) {
    if (!editable || draft.nodes.length >= 500) return;
    const point = worldPoint(size.width / 2, size.height / 2, draft.viewport);
    const id = crypto.randomUUID();
    const offset = (draft.nodes.length % 6) * 18;
    const node: CanvasNode = { id, kind, x: coordinate(point.x - 140 + offset), y: coordinate(point.y - 90 + offset), width: 280, height: 180, ...(kind === "task" ? { sessionId } : { text: "" }) };
    update(d => ({ ...d, nodes: [...d.nodes, node] })); setSelection({ kind: "node", id }); setConnectFrom(null);
  }
  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!editable || event.button !== 0 && event.button !== 1 || (event.target as HTMLElement).closest(".amo-canvas-node, .amo-canvas-edge")) return;
    event.preventDefault(); setSelection(null); setConnectFrom(null);
    gesture.current = { pointer: event.pointerId, kind: "pan", startX: event.clientX, startY: event.clientY, x: draft.viewport.x, y: draft.viewport.y, initial: draft };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function startNode(event: ReactPointerEvent<HTMLElement>, node: CanvasNode) {
    if (!editable || event.button !== 0 || (event.target as HTMLElement).closest("button, textarea")) return;
    event.stopPropagation(); event.preventDefault();
    if (connectFrom) { update(d => connectNodes(d, connectFrom, node.id, crypto.randomUUID())); setConnectFrom(null); return; }
    setSelection({ kind: "node", id: node.id });
    gesture.current = { pointer: event.pointerId, kind: "node", id: node.id, startX: event.clientX, startY: event.clientY, x: node.x, y: node.y, initial: draft };
    stage.current?.setPointerCapture(event.pointerId);
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    update(d => current.kind === "pan" ? { ...d, viewport: { ...d.viewport, x: coordinate(current.x + dx), y: coordinate(current.y + dy) } } : { ...d, nodes: d.nodes.map(n => n.id === current.id ? { ...n, x: coordinate(current.x + dx / d.viewport.zoom), y: coordinate(current.y + dy / d.viewport.zoom) } : n) });
  }
  function zoom(factor: number) { if (editable) update(d => ({ ...d, viewport: zoomAt(d.viewport, size.width / 2, size.height / 2, d.viewport.zoom * factor) })); }
  function fit() {
    if (!editable) return;
    if (!draft.nodes.length) { update(d => ({ ...d, viewport: { x: 0, y: 0, zoom: 1 } })); return; }
    const left = Math.min(...draft.nodes.map(n => n.x)), top = Math.min(...draft.nodes.map(n => n.y));
    const right = Math.max(...draft.nodes.map(n => n.x + n.width)), bottom = Math.max(...draft.nodes.map(n => n.y + n.height));
    const z = clamp(Math.min((size.width - 100) / (right - left), (size.height - 100) / (bottom - top)), .2, 1);
    update(d => ({ ...d, viewport: { x: coordinate(size.width / 2 - (left + right) / 2 * z), y: coordinate(size.height / 2 - (top + bottom) / 2 * z), zoom: z } }));
  }
  const nodeMap = new Map(draft.nodes.map(n => [n.id, n]));
  const visible = draft.nodes.filter(n => visibleNode(n, draft.viewport, size.width, size.height));
  const candidates = sessions.active.filter(s => `${titleOf(s)} ${s.cwd} ${s.tool}`.toLowerCase().includes(search.toLowerCase()));
  return <main className="amo-canvas-app">
    <header className="amo-canvas-header" onPointerDown={startUtilityWindowDrag}>
      <div className="amo-canvas-brand"><span className="amo-canvas-logo"><Link2 size={19} /></span><div><strong>Task Canvas</strong><small>One board · all workspaces</small></div></div>
      <div className="amo-canvas-header-actions"><span className={`amo-canvas-save-state ${dirty ? "is-dirty" : ""}`}>{busy === "loading" ? "Loading…" : busy === "saving" ? "Saving…" : dirty ? "Unsaved changes" : board ? `Saved · r${board.revision}` : "Not loaded"}</span>
        <button disabled={!!busy} onClick={() => dirty ? setReloadPrompt(true) : void reload()} title="Reload stored board"><RotateCcw size={15} /> Reload</button>
        <button className="amo-canvas-primary" disabled={!board || !!busy || !dirty && !pendingSave.current} onClick={() => void save()}><Save size={15} />{pendingSave.current && !busy ? "Retry save" : "Save"}</button>
        <button className="amo-canvas-icon" aria-label="Hide Canvas" onClick={() => void closeUtilityWindow("canvas")}><X size={18} /></button>
      </div>
    </header>
    {error && <div role="alert" className="amo-canvas-alert"><strong>Board could not be {board ? "saved or reloaded" : "loaded"}.</strong> {error} {board && "Your current edits remain on this canvas."}</div>}
    <div className="amo-canvas-layout">
      <aside className="amo-canvas-sidebar"><div className="amo-canvas-sidebar-heading"><strong>Existing tasks</strong><span>{sessions.active.length}</span></div><p>Add references from any workspace.</p>
        <input aria-label="Search tasks" placeholder="Search tasks or workspaces…" value={search} onChange={event => setSearch(event.target.value)} />
        {sessions.error && <div className="amo-canvas-session-error" role="status">Task updates unavailable. {sessions.error}</div>}
        <div className="amo-canvas-task-list">{candidates.map(s => <button key={s.sessionId} className="amo-canvas-candidate" disabled={!editable || draft.nodes.length >= 500} onClick={() => addNode("task", s.sessionId)} title={`Add reference: ${titleOf(s)}\n${s.cwd}`}><span className="amo-canvas-candidate-title">{titleOf(s)}<Plus size={14} /></span><span>{s.tool} · {s.state.replace(/_/g, " ")}</span><small>{s.cwd || "No workspace"}</small></button>)}{!candidates.length && <div className="amo-canvas-sidebar-empty">{search ? "No matching tasks" : "No active tasks available"}</div>}</div>
        <div className="amo-canvas-sidebar-footer"><button disabled={!editable || draft.nodes.length >= 500} onClick={() => addNode("note")}><StickyNote size={16} /> Add note</button><small>Removing a reference only changes this board.</small></div>
      </aside>
      <section className="amo-canvas-workspace">
        <div className="amo-canvas-toolbar"><div><span className="amo-canvas-eyebrow">DEFAULT BOARD</span><span>{draft.nodes.length} / 500 nodes · {draft.edges.length} / 1000 links</span></div><div>
          <button disabled={!editable || !selectedNode || draft.edges.length >= 1000} className={connectFrom ? "is-active" : ""} onClick={() => setConnectFrom(connectFrom ? null : selectedNode?.id ?? null)}><Link2 size={15} /> Connect</button>
          <button disabled={!selection || !editable} onClick={removeSelection}><Trash2 size={15} /> Remove</button>
          <button aria-label="Canvas controls help" className="amo-canvas-icon" onClick={() => setHelp(!help)}><CircleHelp size={17} /></button>
        </div></div>
        <div ref={stage} className={`amo-canvas-stage ${connectFrom ? "is-connecting" : ""}`} onPointerDown={startPan} onPointerMove={move} onPointerUp={event => { gesture.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { if (gesture.current) setDraft(gesture.current.initial); gesture.current = null; }} style={{ backgroundSize: `${24 * draft.viewport.zoom}px ${24 * draft.viewport.zoom}px`, backgroundPosition: `${draft.viewport.x}px ${draft.viewport.y}px` }}>
          <div className="amo-canvas-world" style={{ transform: `translate(${draft.viewport.x}px, ${draft.viewport.y}px) scale(${draft.viewport.zoom})` }}>
            <svg className="amo-canvas-edges" aria-label="Directed connections"><defs><marker id="amo-canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>{draft.edges.map(edge => {
              const source = nodeMap.get(edge.source), target = nodeMap.get(edge.target);
              if (!source || !target) return null;
              return <g key={edge.id} className={`amo-canvas-edge ${selection?.id === edge.id ? "is-selected" : ""}`} onPointerDown={event => { event.stopPropagation(); setSelection({ kind: "edge", id: edge.id }); setConnectFrom(null); }}><path className="amo-canvas-edge-hit" d={edgePath(source, target)} /><path className="amo-canvas-edge-line" d={edgePath(source, target)} markerEnd="url(#amo-canvas-arrow)" /></g>;
            })}</svg>
            {visible.map(node => {
              const session = node.sessionId ? sessions.references.get(node.sessionId) ?? (sessions.resolved.has(node.sessionId) ? undefined : sessions.active.find(s => s.sessionId === node.sessionId)) : undefined;
              const state = node.kind === "note" ? "Note" : session?.archivedAt || session?.dismissedAt ? "Archived" : session ? session.state.replace(/_/g, " ") : sessions.resolved.has(node.sessionId!) ? "Missing reference" : "Loading reference…";
              const title = node.kind === "note" ? "Note" : session ? titleOf(session) : node.sessionId!;
              return <article key={node.id} className={`amo-canvas-node is-${node.kind} ${selection?.id === node.id ? "is-selected" : ""} ${connectFrom === node.id ? "is-source" : ""} ${draft.viewport.zoom < .55 ? "is-compact" : ""}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height }} onPointerDown={event => startNode(event, node)}>
                <div className="amo-canvas-node-heading"><span>{node.kind === "note" ? <StickyNote size={15} /> : <span className={`amo-canvas-status-dot ${session?.needsAttention ? "needs-attention" : ""}`} />}{state}</span><button className="amo-canvas-port" aria-label={`Connect from ${title}`} disabled={!editable || draft.edges.length >= 1000} onClick={() => { setSelection({ kind: "node", id: node.id }); setConnectFrom(connectFrom === node.id ? null : node.id); }}><ArrowRight size={14} /></button></div>
                {node.kind === "note" ? draft.viewport.zoom < .55 ? <p className="amo-canvas-note-preview">{node.text || "Empty note"}</p> : <textarea disabled={!editable} aria-label="Note text" placeholder="Write a thought, next step, or context…" maxLength={4000} value={node.text ?? ""} onFocus={() => setSelection({ kind: "node", id: node.id })} onChange={event => { const text = event.target.value; update(d => ({ ...d, nodes: d.nodes.map(n => n.id === node.id ? { ...n, text } : n) })); }} /> : <><h2 title={title}>{title}</h2><p className="amo-canvas-node-message">{session?.lastMessage || (state === "Missing reference" ? "This task is no longer available. The reference and connections are retained." : "Task reference")}</p><footer title={session?.cwd ?? node.sessionId}>{session?.cwd || node.sessionId}</footer></>}
              </article>;
            })}
          </div>
          {!draft.nodes.length && <div className="amo-canvas-empty"><span><Link2 size={32} /></span><h1>Make room for the bigger picture</h1><p>Add tasks from the sidebar, capture a note,<br />and connect the next steps.</p><button disabled={!editable} onClick={() => addNode("note")}><Plus size={16} /> Add your first note</button></div>}
        </div>
        {connectFrom && <div className="amo-canvas-hint" role="status"><Link2 size={15} /> Select a different card to connect. Escape cancels.</div>}
        {help && <div className="amo-canvas-help"><strong>Canvas controls</strong><p>Drag a card header to move it. Drag the background to pan. Scroll to zoom around the pointer.</p><p>Select a card, choose Connect, then click another card. Select a line or card and press Delete to remove it.</p><p>Escape cancels a drag or connection. Ctrl/Cmd+S saves. Hide keeps your draft; Save keeps it across restarts.</p></div>}
        <div className="amo-canvas-bottom"><span>{selection ? `${selection.kind === "edge" ? "Connection" : selectedNode?.kind === "note" ? "Note" : "Task reference"} selected` : "Drag to pan · Scroll to zoom"}</span><div><button aria-label="Zoom out" disabled={!editable} onClick={() => zoom(1 / 1.2)}><Minus size={14} /></button><span>{Math.round(draft.viewport.zoom * 100)}%</span><button aria-label="Zoom in" disabled={!editable} onClick={() => zoom(1.2)}><Plus size={14} /></button><button disabled={!editable} onClick={fit}>Fit board</button></div></div>
      </section>
    </div>
    {reloadPrompt && <div className="amo-canvas-modal-backdrop"><div role="alertdialog" aria-modal="true" aria-labelledby="canvas-reload-title" className="amo-canvas-modal"><h2 id="canvas-reload-title">Discard unsaved changes?</h2><p>Reload replaces this draft with the last saved board. Task sessions are unaffected.</p><div><button autoFocus onClick={() => setReloadPrompt(false)}><X size={15} /> Keep editing</button><button className="amo-canvas-primary" onClick={() => void reload()}><Check size={15} /> Discard and reload</button></div></div></div>}
  </main>;
}
