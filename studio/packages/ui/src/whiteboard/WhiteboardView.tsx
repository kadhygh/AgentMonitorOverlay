import { useEffect, useMemo, useRef, useState } from "react";
import { WHITEBOARD_KINDS as KINDS, WHITEBOARD_STATUSES as STATUSES, type WhiteboardData, type WhiteboardNote, type Id } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { whiteboardFrameDoc, whiteboardTheme, type WhiteboardFrameMessage } from "./frame.js";

// 白板 in a session (2026-11-16, plans/whiteboard.md; the user: 人只是看这个白板加批注，这个批注可以加在白板上的任意位置，或者选中任意
// 白板上的节点): the board takes the conversation's place (Thread's cover, as 脉络的楼 does), the composer stays under it.
// The page that draws it is in a sandboxed frame (frame.ts); this side fetches the board, hands it in, and keeps the
// person's notes in the column beside it. Notes gather here and go to the AI with the person's next message.

/** How far each board that is on has got and how far the person has looked: the mark on 「白板」. Nothing is asked while the feature is off. */
export function useWhiteboardMarks(link: HostLink | null, enabled: boolean): ReadonlyMap<Id, { rev: number; seenRev: number }> {
  const [on] = useLiveResource<Array<{ sessionId: Id; rev: number; seenRev: number }>>(
    {
      load: link && enabled ? () => call(link, "GET /api/whiteboards", {}).then((r) => r.on) : null,
      initial: [],
      onEvent: (cur, e) => (e.type !== "whiteboard.changed" ? cur : [...cur.filter((b) => b.sessionId !== e.sessionId), ...(e.on ? [{ sessionId: e.sessionId, rev: e.rev, seenRev: e.seenRev }] : [])]),
    },
    [link, enabled],
  );
  return useMemo(() => new Map(on.map((b) => [b.sessionId, b])), [on]);
}

/** Where the person is about to write a note. */
type Target = { nodeId: string; x?: undefined; y?: undefined; quote?: undefined } | { nodeId?: string; x: number; y: number; quote?: string };

const STATE_LABEL: Record<WhiteboardNote["state"], string> = { draft: "还没发给 AI", sent: "已发给 AI，还没回应", answered: "AI 回应了", closed: "已关掉" };
const STATE_MARK: Record<WhiteboardNote["state"], string> = { draft: "○", sent: "◐", answered: "!", closed: "✓" };

export function WhiteboardView({ link, sessionId }: { link: HostLink; sessionId: Id }) {
  const [data, setData] = useLiveResource<WhiteboardData | null>(
    {
      load: () => call(link, "GET /api/sessions/:id/whiteboard", { id: sessionId }),
      initial: null,
      reset: true,
      reloadOn: (e) => e.type === "whiteboard.changed" && e.sessionId === sessionId,
      reloadDelay: 120,
    },
    [link, sessionId],
  );
  const [target, setTarget] = useState<Target | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  // The AI's own page failed: the person may look at the board in Studio's own for now (nothing is changed for the AI).
  const [plain, setPlain] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTarget(null);
    setText("");
    setEditing(null);
    setNoteId(null);
    setError(null);
    setPageError(null);
    setPlain(false);
  }, [sessionId]);

  const run = async (work: () => Promise<WhiteboardData>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setData(await work());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // 看过了: said when the person leaves the board (another view, another session), so what changed since their last
  // visit stays marked while they look; 「都看过了」 says it at once.
  const latest = useRef(data);
  latest.current = data;
  useEffect(
    () => () => {
      const b = latest.current;
      if (b && b.sessionId === sessionId && b.rev > b.seenRev) void call(link, "PUT /api/sessions/:id/whiteboard", { id: sessionId }, { seen: true }).catch(() => undefined);
    },
    [link, sessionId],
  );

  // ---- the frame
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const html = data ? (plain && data.view.fallback ? data.view.fallback : data.view.html) : null;
  const doc = useMemo(() => (html === null ? null : whiteboardFrameDoc(html, whiteboardTheme())), [html]);
  useEffect(() => {
    ready.current = false;
    setPageError(null);
  }, [doc]);
  const tell = (m: unknown) => {
    if (ready.current) frame.current?.contentWindow?.postMessage(m, "*");
  };
  const state = useRef({ data, target, noteId });
  state.current = { data, target, noteId };
  const hand = () => {
    const b = state.current.data;
    if (b) tell({ type: "board.data", board: { rev: b.rev, seenRev: b.seenRev, nodes: b.nodes, notes: b.notes, kinds: KINDS, statuses: STATUSES } });
  };
  const markNow = () => {
    const t = state.current.target;
    tell({ type: "board.mark", nodeId: t?.nodeId ?? null, noteId: state.current.noteId, place: t && t.x !== undefined ? { ...(t.nodeId ? { nodeId: t.nodeId } : {}), x: t.x, y: t.y } : null });
  };
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as WhiteboardFrameMessage | null;
      if (!m || typeof m.type !== "string") return;
      if (m.type === "board.ready") {
        ready.current = true;
        tell({ type: "board.theme", vars: whiteboardTheme() });
        hand();
        markNow();
      } else if (m.type === "board.pick") {
        setNoteId(null);
        setEditing(null);
        setTarget(typeof m.nodeId === "string" && state.current.data?.nodes.some((n) => n.id === m.nodeId) ? { nodeId: m.nodeId } : null);
      } else if (m.type === "board.place" && Number.isFinite(m.x) && Number.isFinite(m.y)) {
        setNoteId(null);
        setEditing(null);
        const nodeId = typeof m.nodeId === "string" && state.current.data?.nodes.some((n) => n.id === m.nodeId) ? m.nodeId : undefined;
        setTarget({ ...(nodeId ? { nodeId } : {}), x: m.x, y: m.y, ...(typeof m.quote === "string" && m.quote ? { quote: m.quote } : {}) });
      } else if (m.type === "board.note" && typeof m.id === "string") {
        setNoteId(m.id);
      } else if (m.type === "board.error") setPageError(typeof m.message === "string" ? m.message : "页面出错了");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(hand, [data]);
  useEffect(markNow, [target, noteId]);
  // The theme changed (设置, or the system's): the page's colours follow.
  useEffect(() => {
    const mo = new MutationObserver(() => tell({ type: "board.theme", vars: whiteboardTheme() }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // The note picked on the page is brought into view in the column.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (noteId) list.current?.querySelector(`[data-note="${noteId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [noteId]);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (target || editing) input.current?.focus();
  }, [target, editing]);

  if (!data) return <div className="wb-view wb-loading" data-testid="wb-view">正在读这个会话的白板…</div>;

  const title = (id: string | undefined) => data.nodes.find((n) => n.id === id)?.title ?? "";
  const where = (n: { nodeId?: string; x?: number; gone?: string; quote?: string }) =>
    n.gone ? `在已经拿掉的节点「${n.gone}」上` : n.nodeId ? (n.x === undefined ? `在「${title(n.nodeId)}」上` : `在「${title(n.nodeId)}」旁边${n.quote ? `：「${n.quote}」` : ""}`) : `在白板的一个位置上${n.quote ? `：「${n.quote}」` : ""}`;
  const drafts = data.notes.filter((n) => n.state === "draft");
  const open = data.notes.filter((n) => n.state === "sent" || n.state === "answered");
  const closed = data.notes.filter((n) => n.state === "closed");
  const unseen = data.nodes.filter((n) => n.rev > data.seenRev).length;
  // The notes' column is there once there is something for it: a note, or one being written. Until then the page has the width.
  const column = data.notes.length > 0 || !!target || !!editing;
  const set = (body: { on?: boolean; seen?: true }) => run(() => call(link, "PUT /api/sessions/:id/whiteboard", { id: sessionId }, body));
  const save = async () => {
    const words = text.trim();
    if (!words || busy) return;
    const ok = editing
      ? await run(() => call(link, "PUT /api/sessions/:id/whiteboard/notes/:noteId", { id: sessionId, noteId: editing }, { text: words }))
      : target
        ? await run(() => call(link, "POST /api/sessions/:id/whiteboard/notes", { id: sessionId }, { ...(target.nodeId ? { nodeId: target.nodeId } : {}), ...(target.x !== undefined ? { x: target.x, y: target.y } : {}), ...(target.quote ? { quote: target.quote } : {}), text: words }))
        : false;
    if (!ok) return;
    setText("");
    setEditing(null);
    setTarget(null);
  };
  const cancel = () => {
    setText("");
    setEditing(null);
    setTarget(null);
  };
  // The notes go with the person's next message (the Host writes them under it); this sends one that says only that.
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/sessions/:id/messages", { id: sessionId }, { text: `看一下白板上的 ${drafts.length} 条批注。` });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const noteRow = (n: WhiteboardNote) => (
    <div key={n.id} className={`wb-note ${n.state}${noteId === n.id ? " on" : ""}`} data-note={n.id} data-state={n.state} onClick={() => setNoteId(n.id)} data-testid="wb-note">
      <div className="wb-note-head">
        <span className="wb-note-mark" title={STATE_LABEL[n.state]}>
          {STATE_MARK[n.state]} 批注 {n.id.replace(/^c/, "")}
        </span>
        <span className="wb-note-where" title={where(n)}>
          {where(n)}
        </span>
      </div>
      <div className="wb-note-text">{n.text}</div>
      {n.reply && (
        <div className="wb-note-reply" data-testid="wb-note-reply">
          <b>AI：</b>
          {n.reply}
        </div>
      )}
      <div className="wb-note-acts">
        {n.state === "draft" && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setTarget(null);
                setEditing(n.id);
                setText(n.text);
              }}
            >
              改
            </button>
            <button type="button" onClick={(e) => (e.stopPropagation(), void run(() => call(link, "DELETE /api/sessions/:id/whiteboard/notes/:noteId", { id: sessionId, noteId: n.id })))} data-testid="wb-note-remove">
              删掉
            </button>
          </>
        )}
        {(n.state === "sent" || n.state === "answered") && (
          <button type="button" title="这条处理完了：从白板上收起来，AI 也不再看到它" onClick={(e) => (e.stopPropagation(), void run(() => call(link, "PUT /api/sessions/:id/whiteboard/notes/:noteId", { id: sessionId, noteId: n.id }, { closed: true })))} data-testid="wb-note-close">
            处理完了，关掉
          </button>
        )}
        {n.state === "closed" && (
          <button type="button" onClick={(e) => (e.stopPropagation(), void run(() => call(link, "PUT /api/sessions/:id/whiteboard/notes/:noteId", { id: sessionId, noteId: n.id }, { closed: false })))}>
            重新打开
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="wb-view" data-testid="wb-view">
      <div className="wb-bar">
        {data.on ? (
          <>
            <span className="wb-state">白板开着：AI 往上写，你看和批注</span>
            {unseen > 0 ? (
              <>
                <b data-testid="wb-unseen">有 {unseen} 个节点在你上次看过之后变了</b>
                <button type="button" className="wb-btn" disabled={busy} onClick={() => void set({ seen: true })} data-testid="wb-seen">
                  都看过了
                </button>
              </>
            ) : (
              data.nodes.length > 0 && <span className="wb-dim">没有新的变化</span>
            )}
            <span className="wb-dim wb-push">
              {data.view.own ? (plain ? "AI 自己画的页面出错了，现在用 Studio 自带的画法看" : "画法：AI 自己画的页面") : ""}
              {!column && data.nodes.length > 0 && `${data.view.own ? " · " : ""}点一个节点，或在任意位置点右键，写批注`}
            </span>
            <button type="button" className="wb-btn quiet" disabled={busy} title="停用以后 AI 不再往白板上写，上面已有的内容和批注都留着" onClick={() => void set({ on: false })} data-testid="wb-off">
              停用
            </button>
          </>
        ) : (
          <>
            <span className="wb-state">{data.nodes.length ? "白板停用了：上面的内容留着，AI 不再往上写。" : "这个会话还没开白板。"}</span>
            <button type="button" className="wb-btn primary" disabled={busy} onClick={() => void set({ on: true })} data-testid="wb-on">
              开白板
            </button>
            <span className="wb-dim">开了以后，随你发的下一条消息告诉 AI：把任务内容、计划、建议和定下来的事写到白板上（会多花一些 token）。</span>
          </>
        )}
      </div>
      {(error || (pageError && !plain)) && (
        <div className="wb-error" role="alert" data-testid="wb-error">
          ! {error ?? `画白板的页面出错了：${pageError}`}
          {!error && data.view.fallback && (
            <button type="button" className="wb-btn" onClick={() => setPlain(true)}>
              先用 Studio 自带的画法看
            </button>
          )}
        </div>
      )}
      <div className="wb-main">
        {doc !== null && <iframe ref={frame} sandbox="allow-scripts" srcDoc={doc} title="白板" data-testid="wb-frame" />}
        {column && (
        <aside className="wb-notes" ref={list} data-testid="wb-notes">
          <div className="wb-notes-title">
            批注 <span>{data.notes.length - closed.length}</span>
          </div>
          {target || editing ? (
            <div className="wb-edit" data-testid="wb-note-editor">
              <div className="wb-edit-where">{editing ? `改批注 ${editing.replace(/^c/, "")}` : where(target!)}</div>
              <textarea
                ref={input}
                value={text}
                rows={4}
                placeholder="写给 AI 的话：哪里不对、想怎么改、同不同意…"
                aria-label="批注内容"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
                  else if (e.key === "Escape") cancel();
                }}
                data-testid="wb-note-input"
              />
              <div className="wb-edit-acts">
                <span className="wb-dim">Ctrl+回车 写下</span>
                <button type="button" className="wb-btn quiet" onClick={cancel}>
                  取消
                </button>
                <button type="button" className="wb-btn primary" disabled={busy || !text.trim()} onClick={() => void save()} data-testid="wb-note-save">
                  写下
                </button>
              </div>
            </div>
          ) : (
            <p className="wb-hint">点白板上的一个节点，或者在任意位置点右键，写一条批注。批注先攒在这里，随你的下一条消息一起带给 AI。</p>
          )}
          {drafts.length > 0 && (
            <>
              <div className="wb-notes-head">还没发给 AI · {drafts.length}</div>
              {drafts.map(noteRow)}
              <button type="button" className="wb-btn primary wb-send" disabled={busy || !data.on} title={data.on ? "发一条消息让 AI 看这些批注；你在下面的输入框里自己写一条消息发出去，它们也会一起带过去" : "白板停用着：先开白板，批注才会带给 AI"} onClick={() => void send()} data-testid="wb-send">
                把这 {drafts.length} 条发给 AI
              </button>
            </>
          )}
          {open.length > 0 && (
            <>
              <div className="wb-notes-head">发给 AI 的 · {open.length}</div>
              {open.map(noteRow)}
            </>
          )}
          {closed.length > 0 && (
            <details className="wb-closed">
              <summary>已关掉 · {closed.length}</summary>
              {closed.map(noteRow)}
            </details>
          )}
        </aside>
        )}
      </div>
    </div>
  );
}
