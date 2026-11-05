import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { REMOTE_TASK_FOLDER, remoteFileKind, sortComments, type GitCommentPoint, type GitReviewComment, type TextFile, type Workspace } from "@amo-studio/protocol";
import { ActionMenu } from "../lib/ActionMenu.js";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";
import { Markdown, MarkdownFileLinks, MarkdownImages } from "../lib/markdown.js";
import { rawFileUrl } from "../lib/openin.js";
import { viewRemoteFile } from "../files/FileLinks.js";
import { highlightsSupported } from "../review/highlights.js";
import { FloatBox } from "../review/FloatBox.js";
import { CommentDraft } from "../gitreview/DiffView.js";
import { commentsChanged, SendBar, useReviewComments } from "../gitreview/comments.js";
import { dropDraft, editDraftKey, newDraftKey, setDraftText, useEditing } from "../gitreview/drafts.js";
import { FindBar } from "../gitreview/FindBar.js";
import { isSelectAllKey, typingIn, useSelectAll } from "../gitreview/selectAll.js";
import { relativeIn, remoteLinkPath } from "./logic.js";
import { passageKit, type PassageAnchor } from "./passageKit.js";
import { frameDoc, headingSlug, resolveLink, sourceCandidates, sourceLine, type FrameMessage, type ToFrame } from "./passages.js";
import { openViewer } from "./open.js";

// 渲染批注 (2026-10-28): a Markdown or HTML file shown rendered in the viewer, its passages taking comments — select
// words, 批注, write. They are the file's comments as in its source view (range `file`, at the line the passage starts
// on, best guess), copied out with the same bar; each keeps its words and their context, so it is found and painted
// again after the file is regenerated. HTML runs in a frame with its scripts (folding, theme switches and clickable
// diagrams keep working), sandboxed away from this window: our script inside reports selections and paints (passages.ts).
// An HTML file made from Markdown names that Markdown in its comments: the change goes there.

const MD_HIGHLIGHT = "amo-passage";
const MD_HOT = "amo-passage-hot";
/** Rendered Markdown's text, without the copy buttons of its code blocks. */
const mdKit = passageKit("script, style, noscript, template, button");

/** Follows a link of the rendered file (2026-10-28): the web in the browser, a heading here, a file in the viewer. */
const Follow = createContext<(href: string) => void>(() => undefined);

/** Rendered Markdown's links that are not web addresses: headings and files. */
function ViewerLink({ kind, target, children, fallback }: { kind: "code" | "link"; target: string; children: ReactNode; fallback: ReactNode }) {
  const follow = useContext(Follow);
  if (kind !== "link") return <>{fallback}</>;
  return (
    <a
      className="md-link"
      href={target}
      title={target}
      onClick={(e) => {
        e.preventDefault();
        follow(target);
      }}
    >
      {children}
    </a>
  );
}

/** Where the HTML file's Markdown source is (relative to the project), when one is found. */
function useHtmlSource(link: HostLink, ws: Workspace | null, rel: string | null, html: string | null): string | null {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    setSource(null);
    if (!ws || rel === null || html === null) return;
    const paths = sourceCandidates(html, rel).slice(0, 20);
    if (!paths.length) return;
    let live = true;
    call(link, "POST /api/fs/exists", {}, { paths, workspaceId: ws.id })
      .then((r) => {
        if (!live) return;
        for (const p of paths) {
          const hit = r.found[p];
          const inProject = hit && !hit.dir ? relativeIn(hit.path, ws.path) : null;
          if (inProject) return setSource(inProject);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link, ws?.id, rel, html]); // eslint-disable-line react-hooks/exhaustive-deps
  return source;
}

/** 远程 step 3: the file is a remote task's, fetched from the computer it runs on (`rel`: its place in the task's folder). */
export interface RemoteFileContext {
  taskId: string;
  rel: string;
  /** Serves the task's images: /api/remote/files/<key>/<rel>. */
  key: string;
  /** This Host, when `link` is a remote Reviewer's (远程 Reviewer, 2026-11-02): the images are served by the Host itself. */
  host?: HostLink;
}

/** `/api/remote/files/<key>/<a/b>` for a place in a remote task's folder, each part escaped. */
export const remoteFileUrl = (link: HostLink, key: string, rel: string) => `${link.url}/api/remote/files/${key}/${rel.split("/").map(encodeURIComponent).join("/")}`;

export function RenderedReview({ link, workspace, file, kind, active, remote, sessionId }: { link: HostLink; workspace: Workspace | null; file: TextFile; kind: "markdown" | "html"; active: boolean; remote?: RemoteFileContext; /** A remote task's: where 发到对话 sends the comments. */ sessionId?: string | null }) {
  const text = file.text ?? "";
  const rel = workspace ? relativeIn(file.path, workspace.path) : null;
  const ws = rel !== null ? workspace : null;
  const comments = useReviewComments(link, workspace?.id ?? "", !!ws);
  const mine = useMemo(() => sortComments(comments.filter((c) => c.path === rel && c.state === "draft" && c.range === "file")), [comments, rel]);
  const passages = useMemo(() => mine.filter((c) => c.passage && !c.passage.point), [mine]);
  const places = useMemo(() => mine.filter((c) => c.passage?.point), [mine]);
  /** A place's label, on its pin and its card: 1, 2, … in the list's order. */
  const placeNo = useMemo(() => new Map(places.map((c, i) => [c.id, String(i + 1)])), [places]);
  const source = useHtmlSource(link, ws, rel, kind === "html" ? text : null);
  const [found, setFound] = useState<ReadonlySet<string> | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [pick, setPick] = useState<{ anchor: PassageAnchor; x: number; y: number } | null>(null);
  /** 位置批注 (2026-10-28): the menu of a right click on an HTML page. */
  const [menu, setMenu] = useState<{ x: number; y: number; line: number; point: GitCommentPoint; near: PassageAnchor; selection: PassageAnchor | null } | null>(null);
  /** Words, or a place (with its element's line) and the words nearest it; `at`: where its box opens in the pane. */
  const [draft, setDraft] = useState<(PassageAnchor & { point?: GitCommentPoint; line?: number; at: PanePoint }) | null>(null);
  const [busy, setBusy] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  /** Rendered Markdown, which scrolls itself. */
  const doc = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const mdRanges = useRef(new Map<string, Range>());
  const marksKey = mine.map((c) => c.id).join("|");

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  // ---- Markdown: painted here ----
  useLayoutEffect(() => {
    if (kind !== "markdown") return;
    const root = doc.current;
    if (!root) return;
    let frameId = 0;
    const paint = () => {
      frameId = 0;
      const flat = mdKit.flatten(root);
      const map = new Map<string, Range>();
      for (const c of passages) {
        const r = mdKit.rangeOf(root, c.passage!, flat);
        if (r) map.set(c.id, r);
      }
      mdRanges.current = map;
      setFound(new Set(map.keys()));
      if (!highlightsSupported()) return;
      CSS.highlights.set(MD_HIGHLIGHT, new Highlight(...map.values()));
      const h = hot ? map.get(hot) : undefined;
      if (h) CSS.highlights.set(MD_HOT, new Highlight(h));
      else CSS.highlights.delete(MD_HOT);
    };
    paint();
    // Code blocks colour later (the highlight worker): their text nodes are new.
    const observer = new MutationObserver(() => {
      if (!frameId) frameId = requestAnimationFrame(paint);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, [kind, marksKey, hot, text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (!highlightsSupported()) return;
      CSS.highlights.delete(MD_HIGHLIGHT);
      CSS.highlights.delete(MD_HOT);
    },
    [],
  );

  const onMdMouseUp = (e: ReactMouseEvent) => {
    const x = e.clientX;
    const y = e.clientY;
    setTimeout(() => {
      const root = doc.current;
      const box = pane.current?.getBoundingClientRect();
      const sel = getSelection();
      if (!root || !box || !sel || sel.isCollapsed || !sel.rangeCount || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        setPick(null);
        for (const [id, r] of mdRanges.current) for (const b of r.getClientRects()) if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return goTo(id, false);
        return;
      }
      const range = sel.getRangeAt(0);
      const anchor = mdKit.anchorOf(root, range);
      const rects = [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      setPick(anchor ? { anchor, x: last.right - box.left, y: last.bottom - box.top } : null);
    }, 0);
  };

  // ---- HTML: painted in its frame ----
  // A remote page's own images load from the task's folder there, through this Host (fetched as the page asks).
  const base = remote ? remoteFileUrl(remote.host ?? link, remote.key, `${remote.rel.includes("/") ? remote.rel.slice(0, remote.rel.lastIndexOf("/") + 1) : ""}`) : null;
  const srcDoc = useMemo(() => (kind === "html" ? frameDoc(text, base) : ""), [kind, text, base]);
  const toFrame = (m: ToFrame) => frame.current?.contentWindow?.postMessage({ amoPassage: m }, "*");
  const anchorOf = (p: PassageAnchor) => ({ quote: p.quote, prefix: p.prefix, suffix: p.suffix });
  const sendMarks = () =>
    toFrame({
      type: "marks",
      marks: passages.map((c) => ({ id: c.id, ...anchorOf(c.passage!) })),
      points: [
        ...places.map((c) => ({ id: c.id, n: placeNo.get(c.id) ?? "", point: c.passage!.point!, ...anchorOf(c.passage!) })),
        ...(draft?.point ? [{ id: "draft", n: "+", point: draft.point, ...anchorOf(draft), draft: true }] : []),
      ],
      hot,
    });
  useEffect(() => {
    if (kind === "html") sendMarks();
  }, [kind, marksKey, hot, draft]); // eslint-disable-line react-hooks/exhaustive-deps
  // Links: the web in the browser, a heading of this Markdown here, a file in the viewer (this window, unless 固定).
  const follow = (href: string) => {
    const to = resolveLink(file.path, href);
    if (!to) return showToast({ text: `这个链接在查看器里打不开：${href}`, error: true });
    if (to.kind === "web") return void window.amo?.openExternal?.(to.url);
    if (to.kind === "file" && remote) {
      // A remote file's links are files of the task's folder over there: fetched as this one was.
      const there = remoteLinkPath(remote.rel, href, resolveLink);
      if (!there) return showToast({ text: `这个链接在查看器里打不开：${href}`, error: true });
      return viewRemoteFile({ file: { path: there.path }, ...(there.line ? { line: there.line } : {}) }, remote.taskId, sessionId ?? null);
    }
    if (to.kind === "file") return openViewer({ path: to.path, ...(to.line ? { line: to.line } : {}) });
    const root = doc.current;
    // Written by hand, a link may have one dash where the heading's anchor has two.
    const loose = (s: string) => headingSlug(s).replace(/-+/g, "-");
    const want = loose(to.id);
    const h = root && [...root.querySelectorAll<HTMLElement>(".md-h")].find((el) => loose(el.textContent ?? "") === want);
    if (!root || !h) return showToast({ text: `没有找到标题「${to.id}」` });
    root.scrollTop += h.getBoundingClientRect().top - root.getBoundingClientRect().top - 12;
  };
  const latest = useRef({ sendMarks, follow });
  latest.current = { sendMarks, follow };
  const followLink = useCallback((href: string) => latest.current.follow(href), []);
  // Pictures beside the Markdown file show in it (2026-10-29): a remote task's through this Host from its computer.
  const imageUrl = useCallback(
    (src: string): string | null => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null;
      if (remote) {
        const there = remoteLinkPath(remote.rel, src, resolveLink);
        if (!there || remoteFileKind(there.path) !== "image" || !there.path.startsWith(`${REMOTE_TASK_FOLDER}/`)) return null;
        return remoteFileUrl(remote.host ?? link, remote.key, there.path.slice(REMOTE_TASK_FOLDER.length + 1));
      }
      const to = resolveLink(file.path, src);
      return to?.kind === "file" && remoteFileKind(to.path) === "image" ? rawFileUrl(link, { path: to.path }) : null;
    },
    [remote?.rel, remote?.key, file.path, link], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    if (kind !== "html") return;
    const on = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = (e.data as { amoPassage?: FrameMessage } | null)?.amoPassage;
      if (!m) return;
      if (m.type === "ready") latest.current.sendMarks();
      else if (m.type === "placed") setFound(new Set(m.found));
      else if (m.type === "scroll") {
        setPick(null);
        setMenu(null);
      } else if (m.type === "press") setMenu(null);
      else if (m.type === "point") {
        const at = frame.current.getBoundingClientRect();
        setPick(null);
        setMenu({ x: at.left + m.x, y: at.top + m.y, line: m.line, point: m.point, near: m.near, selection: m.selection });
      } else if (m.type === "hit") goTo(m.id, false);
      else if (m.type === "link") latest.current.follow(m.href);
      else if (m.type === "copy") void copyText(m.text).then(() => showToast({ text: "已复制" }));
      else if (m.type === "select") {
        const box = pane.current?.getBoundingClientRect();
        const at = frame.current.getBoundingClientRect();
        setPick(m.anchor && m.rect && box ? { anchor: m.anchor, x: at.left - box.left + m.rect.right, y: at.top - box.top + m.rect.bottom } : null);
      }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+A selects the document only, not the comments beside it or the window's buttons (2026-11-05). Markdown is
  // drawn whole, so the browser copies the selection itself; an HTML page is selected in its frame, which takes the
  // focus so that Ctrl+C copies there. Inside the frame, Ctrl+A is the page's own.
  useSelectAll(active && kind === "markdown", () => doc.current);
  useEffect(() => {
    if (!active || kind !== "html") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isSelectAllKey(e) || typingIn(e.target) || !frame.current) return;
      e.preventDefault();
      getSelection()?.removeAllRanges();
      frame.current.focus();
      toFrame({ type: "selectAll" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  /** To a passage: in the document (`inDoc`, from the list) or in the list (a click on its highlight). */
  function goTo(id: string, inDoc: boolean) {
    setHot(id);
    if (!inDoc) {
      list.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (kind === "html") return toFrame({ type: "go", id });
    const r = mdRanges.current.get(id);
    const el = doc.current;
    if (!r || !el) return;
    const top = r.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.scrollTop += top - el.clientHeight / 3;
  }

  const draftKey = newDraftKey(ws?.id ?? "", rel ?? "", "passage");
  const save = (note: string) =>
    ws &&
    rel !== null &&
    draft &&
    run(async () => {
      await call(link, "POST /api/workspaces/:id/review-comments", { id: ws.id }, {
        range: "file",
        path: rel,
        side: "new",
        line: draft.line ?? sourceLine(text, draft.quote, kind === "html"),
        lineText: draft.quote,
        note,
        passage: { ...anchorOf(draft), ...(source ? { source } : {}), ...(draft.point ? { point: draft.point } : {}) },
      });
      dropDraft(draftKey);
      setDraft(null);
      if (kind === "html") toFrame({ type: "clear" });
      else getSelection()?.removeAllRanges();
      commentsChanged(ws.id);
    });
  const edit = (id: string, note: string) =>
    ws &&
    run(async () => {
      await call(link, "PATCH /api/review-comments/:id", { id }, { note });
      dropDraft(editDraftKey(id));
      commentsChanged(ws.id);
    });
  const remove = (id: string) =>
    ws &&
    run(async () => {
      await call(link, "DELETE /api/review-comments/:id", { id });
      dropDraft(editDraftKey(id));
      commentsChanged(ws.id);
    });

  const width = pane.current?.clientWidth ?? 0;
  /** A point of the window (the right-click menu's) in the pane. */
  const inPane = (p: { x: number; y: number }): PanePoint => {
    const box = pane.current?.getBoundingClientRect();
    return box ? { x: p.x - box.left, y: p.y - box.top } : p;
  };
  const projectDrafts = comments.filter((c) => c.state === "draft");

  return (
    <div className="vw-rendered" data-testid="viewer-rendered" data-kind={kind}>
      <div className="vw-rendered-main">
        <div className="vw-rendered-doc" ref={pane}>
          {kind === "markdown" ? (
            <>
              <FindBar active={active} container={doc} />
              <div className="vw-content">
                <div className="fp-md" ref={doc} onMouseUp={onMdMouseUp} onScroll={() => setPick(null)} data-testid="viewer-md">
                  <Follow.Provider value={followLink}>
                    <MarkdownFileLinks.Provider value={ViewerLink}>
                      <MarkdownImages.Provider value={imageUrl}>
                        <Markdown source={text} />
                      </MarkdownImages.Provider>
                    </MarkdownFileLinks.Provider>
                  </Follow.Provider>
                </div>
              </div>
            </>
          ) : (
            <iframe
              ref={frame}
              className="vw-frame"
              title={file.path}
              // Its scripts run, without this window's origin: it reaches nothing here but by messages.
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              onLoad={() => sendMarks()}
              data-testid="viewer-html"
            />
          )}
          {pick && ws && (
            <button
              type="button"
              className="btn-primary small vw-pick"
              style={{ left: Math.max(8, Math.min(pick.x - 20, width - 70)), top: pick.y + 6 }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                dropDraft(draftKey);
                setDraft({ ...pick.anchor, at: { x: pick.x, y: pick.y } });
                setPick(null);
              }}
              data-testid="passage-add"
            >
              批注
            </button>
          )}
          {menu && ws && (
            <ActionMenu
              label="批注"
              at={menu}
              testId="point-menu"
              onClose={() => setMenu(null)}
              groups={[
                [
                  {
                    label: "在这里批注",
                    key: "A",
                    title: "在这个位置钉一个点写意见；复制出去时写明它在源码里的行和附近的文字",
                    run: () => {
                      dropDraft(draftKey);
                      setDraft({ ...menu.near, point: menu.point, line: menu.line, at: inPane(menu) });
                    },
                  },
                  menu.selection && {
                    label: "给选中的文字批注",
                    key: "S",
                    run: () => {
                      dropDraft(draftKey);
                      setDraft({ ...menu.selection!, at: inPane(menu) });
                    },
                  },
                ],
              ]}
            />
          )}
          {draft && ws && <DraftFloat key={`${draft.quote}|${draft.at.x}|${draft.at.y}`} draft={draft} pane={pane.current} busy={busy} store={draftKey} onSave={save} onCancel={() => {
            dropDraft(draftKey);
            setDraft(null);
          }} />}
        </div>
        <aside className="vw-notes" aria-label="批注" data-testid="passage-notes">
          <div className="vw-notes-head">
            <span>批注{mine.length ? ` ${mine.length}` : ""}</span>
            {kind === "html" && ws && (
              <span className="vw-notes-source" title={source ? `批注里会写明：改 ${source}，再重新生成这份 HTML` : "没找到同名或页脚里写的 .md 文件：批注指向这份 HTML"} data-testid="passage-source">
                {source ? `源文件 ${source}` : "没有找到源 Markdown"}
              </span>
            )}
          </div>
          <div className="vw-notes-list" ref={list}>
            {!ws && <p className="vw-notes-empty">{remote ? "这个文件不在任务文件夹里（对话里的附件），不能批注。" : "这个文件不在任何项目里，不能批注。"}</p>}
            {mine.map((c) => (
              <NoteCard key={c.id} comment={c} n={placeNo.get(c.id)} busy={busy} hot={hot === c.id} lost={!!c.passage && found !== null && !found.has(c.id)} onGo={() => c.passage && goTo(c.id, true)} onEdit={edit} onDelete={remove} />
            ))}
            {ws && !draft && !mine.length && (
              <p className="vw-notes-empty">
                选中文字，点「批注」写意见{kind === "html" ? "；在页面任意位置右键「在这里批注」，给那个位置写意见" : ""}。和「源码」里按行写的批注是同一批，用下面的按钮一起复制。
              </p>
            )}
          </div>
        </aside>
      </div>
      {ws && (projectDrafts.length > 0 || draft) && <SendBar link={link} workspace={ws} comments={comments} busy={busy} run={run} sessionId={sessionId ?? null} />}
    </div>
  );
}

/** A point in the page's pane, in px from its top left. */
type PanePoint = { x: number; y: number };

const FLOAT_W = 360;

/**
 * 批注小窗 (2026-10-31, 问题 #2): a new comment is written in a box by the words or the place it is about, not in the
 * list (the list stays, for the comments written). Under the point, inside the pane; above it when there is no room
 * below. It stays where it is put while the page scrolls under it (the page scrolls in its frame or its own box).
 */
function DraftFloat({
  draft,
  pane,
  busy,
  store,
  onSave,
  onCancel,
}: {
  draft: PassageAnchor & { point?: GitCommentPoint; at: PanePoint };
  pane: HTMLElement | null;
  busy: boolean;
  store: string;
  onSave(note: string): void;
  onCancel(): void;
}) {
  const inner = pane?.clientWidth ?? 800;
  const height = pane?.clientHeight ?? 600;
  const left = Math.max(8, Math.min(draft.at.x - FLOAT_W / 2, inner - FLOAT_W - 8));
  const above = height - draft.at.y < 240 && draft.at.y > 240;
  // The point is the selection's (or the click's) bottom: above, it clears the line it is on.
  const style: CSSProperties = above ? { left, top: draft.at.y - 26, transform: "translateY(-100%)" } : { left, top: draft.at.y + 8 };
  const title = draft.point ? "在这里批注" : "批注这段话";
  return (
    <FloatBox className="vw-float" style={style} width={FLOAT_W} fromBottom={above} bounds={{ left, inner }} title={title} label={title} testId="passage-draft">
      {draft.point ? <PlaceLabel n="+" where={draft.point.where} /> : <blockquote className="vw-note-quote">{draft.quote}</blockquote>}
      <CommentDraft busy={busy} store={store} anchor="passage" placeholder={draft.point ? "对这个位置的意见或问题（Ctrl+Enter 保存）" : "对这段话的意见或问题（Ctrl+Enter 保存）"} onSave={onSave} onCancel={onCancel} />
    </FloatBox>
  );
}

/** A place's pin label and where it is, in words. */
function PlaceLabel({ n, where }: { n: string; where: string }) {
  return (
    <span className="vw-place">
      <span className="vw-place-pin">{n}</span>
      <span className="vw-place-where">{where}</span>
    </span>
  );
}

function NoteCard({
  comment,
  n,
  busy,
  hot,
  lost,
  onGo,
  onEdit,
  onDelete,
}: {
  comment: GitReviewComment;
  /** A place's label (位置批注). */
  n: string | undefined;
  busy: boolean;
  hot: boolean;
  lost: boolean;
  onGo(): void;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
}) {
  const editing = useEditing(comment.id);
  const editKey = editDraftKey(comment.id);
  const p = comment.passage;
  const card = useRef<HTMLDivElement>(null);
  // 批注小窗 (2026-10-31, 问题 #2): edited in a box over the page, left of its card (the list is narrow, and scrolls).
  const [at, setAt] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect();
    if (!editing || !box) return setAt(null);
    setAt({ position: "fixed", left: Math.max(8, box.left - FLOAT_W - 10), top: Math.max(8, Math.min(box.top, window.innerHeight - 240)) });
  }, [editing]);
  return (
    <div ref={card} className="gr-comment vw-note" data-id={comment.id} data-hot={hot ? "" : undefined} data-lost={lost ? "" : undefined} data-testid="passage-note">
      {p?.point ? (
        <button type="button" className="vw-note-quote vw-note-place" title={lost ? "页面上找不到这个位置了（可能已改写）" : `在页面上找到这个位置（源码第 ${comment.line} 行）`} onClick={onGo}>
          <PlaceLabel n={n ?? ""} where={p.point.where} />
        </button>
      ) : p ? (
        <button type="button" className="vw-note-quote" title={lost ? "文件里找不到这段话了（可能已改写）" : "在文中找到这段话"} onClick={onGo}>
          {p.quote}
        </button>
      ) : (
        <div className="vw-note-line" title="在「源码」里按行写的批注">
          源码第 {comment.line} 行 · <code>{comment.lineText.trim() || "（空行）"}</code>
        </div>
      )}
      {lost && <span className="vw-note-lost">{p?.point ? "位置找不到了" : "原文找不到了"}</span>}
      <span className="gr-comment-note">{comment.note}</span>
      {editing && at && (
        <FloatBox className="vw-float" style={at} width={FLOAT_W} title="修改这条批注" label="修改这条批注" testId="passage-edit">
          <CommentDraft busy={busy} store={editKey} anchor={`passage:${comment.id}`} initial={comment.note} label="修改批注" placeholder="对这段话的意见或问题（Ctrl+Enter 保存）" onSave={(note) => onEdit(comment.id, note)} onCancel={() => dropDraft(editKey)} />
        </FloatBox>
      )}
      {!editing && (
        <div className="anno-actions">
          <button type="button" className="link-btn" onClick={() => setDraftText(editKey, comment.note)}>
            编辑
          </button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => onDelete(comment.id)}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}
