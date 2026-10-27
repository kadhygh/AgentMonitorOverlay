import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { anchorOf, findAnchor, flatten, HIGHLIGHT_CSS, paint } from "./anchors.js";
import { timeText } from "./bits.js";
import { Dialog } from "./Dialog.js";
import { copyText } from "./env.js";
import { Markdown } from "./Markdown.js";
import { errorText } from "./Messages.js";
import type { Session } from "./session.js";
import { MAX_FILE_BYTES, notesAsText, type FileNote, type RelayFile } from "./shared.js";

// Files (stage 2c) and their notes (2d): a task's or a session's attachments, uploaded by button or by dropping them
// in, kept by version; opened in a large modal — Markdown rendered, HTML without its scripts (so passages can be
// selected and noted; 运行脚本 shows it live, without notes), text as is, images — with the notes on the right. A
// note keeps the words it is about; other versions' notes follow along when their words are still there.

export type Where = { taskId: string } | { threadId: string };

const kindOf = (f: Pick<RelayFile, "name" | "type">): "md" | "html" | "text" | "image" | "other" => {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown" || f.type.includes("markdown")) return "md";
  if (ext === "html" || ext === "htm" || f.type.startsWith("text/html")) return "html";
  if (f.type.startsWith("image/")) return "image";
  if (f.type.startsWith("text/") || /json|xml|yaml|csv|javascript/.test(f.type) || /^(txt|json|csv|ya?ml|xml|js|ts|lua|ini|toml|log)$/.test(ext)) return "text";
  return "other";
};
export const canNote = (f: Pick<RelayFile, "name" | "type">) => ["md", "html", "text"].includes(kindOf(f));
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Uploads dropped or picked files; returns what came. */
export function useUpload(session: Session, where: Where | null, toast: (t: string) => void) {
  const [busy, setBusy] = useState(false);
  const upload = useCallback(
    async (files: FileList | File[]) => {
      if (!where) return [];
      const list = [...files];
      const big = list.find((f) => f.size > MAX_FILE_BYTES);
      if (big) return toast(`「${big.name}」太大了（最多 20 MB）`), [];
      setBusy(true);
      const out: RelayFile[] = [];
      try {
        for (const f of list) out.push(await session.client.upload(where, f.name, f, f.type));
        toast(out.length === 1 ? `已上传 ${out[0]!.name} v${out[0]!.version}` : `已上传 ${out.length} 个文件`);
      } catch (err) {
        toast(errorText(err));
      } finally {
        setBusy(false);
      }
      return out;
    },
    [session, where, toast],
  );
  return { upload, busy };
}

/** A zone that takes dropped files. */
export function DropZone({ onFiles, children, className = "" }: { onFiles: (files: FileList) => void; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const has = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  return (
    <div
      className={`drop ${over ? "over" : ""} ${className}`}
      onDragOver={(e) => {
        if (!has(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!has(e)) return;
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
    >
      {children}
    </div>
  );
}

/** Pick files from disk. */
export function PickFiles({ onFiles, label = "上传文件", disabled = false, small = false }: { onFiles: (files: FileList) => void; label?: string; disabled?: boolean; small?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={small ? "small" : ""} disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function FileRow({ file, onOpen }: { file: RelayFile; onOpen: (id: string) => void }) {
  const ext = file.name.split(".").pop()?.slice(0, 4) ?? "";
  return (
    <button type="button" className="box-row file-row" onClick={() => onOpen(file.id)} title={`打开 ${file.name}`}>
      <span className="file-ico">{ext}</span>
      <b className="ellipsis">{file.name}</b>
      <span className="chip">v{file.version}</span>
      <span className="muted tiny">
        {file.by} · {timeText(file.at)} · {size(file.size)}
      </span>
      <span className="grow" />
      {file.notes > 0 && <span className="chip attn">{file.notes} 条批注</span>}
    </button>
  );
}

/** A file chip, for a session's attachments. */
export function FileChip({ file, onOpen }: { file: RelayFile; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="att" onClick={() => onOpen(file.id)} title={`打开 ${file.name}`}>
      <span className="file-ico">{file.name.split(".").pop()?.slice(0, 4)}</span>
      {file.name} · v{file.version}
      {file.notes > 0 && <span className="n">{file.notes} 条批注</span>}
    </button>
  );
}

/** A session's files (taken from its task, or uploaded into it), kept current. */
export function useThreadFiles(session: Session, threadId: string, updatedAt: number): RelayFile[] {
  const [files, setFiles] = useState<RelayFile[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => session.onNotes(() => setTick((n) => n + 1)), [session]);
  useEffect(() => {
    let alive = true;
    session.client
      .files({ threadId })
      .then((f) => alive && setFiles(f))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session, threadId, updatedAt, tick]);
  return files;
}

interface Placed {
  note: FileNote;
  range: Range | null;
}

/** The viewer: one file, its versions, its notes. */
export function FileViewer({ session, fileId, onClose, toast }: { session: Session; fileId: string; onClose: () => void; toast: (t: string) => void }) {
  const me = session.me.name;
  const [versions, setVersions] = useState<RelayFile[]>([]);
  const [shownId, setShownId] = useState(fileId);
  const [content, setContent] = useState<{ id: string; text?: string; url?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<FileNote[]>([]);
  const [live, setLive] = useState(false);
  const [draft, setDraft] = useState<{ quote: string; prefix: string; suffix: string } | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [hot, setHot] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [selBtn, setSelBtn] = useState<{ x: number; y: number; anchor: { quote: string; prefix: string; suffix: string } } | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const file = versions.find((v) => v.id === shownId) ?? null;
  const kind = file ? kindOf(file) : null;

  useEffect(() => {
    session.client
      .versions(fileId)
      .then(setVersions)
      .catch((err) => setError(errorText(err)));
  }, [session, fileId]);
  useEffect(() => {
    if (!file) return;
    let alive = true;
    let url: string | null = null;
    setContent(null);
    session.client
      .fileData(file.id)
      .then(async (blob) => {
        if (!alive) return;
        if (kindOf(file) === "image") setContent({ id: file.id, url: (url = URL.createObjectURL(blob)) });
        else if (kindOf(file) === "other") setContent({ id: file.id });
        else setContent({ id: file.id, text: await blob.text() });
      })
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [session, file?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadNotes = useCallback(() => {
    session.client
      .notes(fileId)
      .then(setNotes)
      .catch(() => undefined);
  }, [session, fileId]);
  useEffect(loadNotes, [loadNotes]);
  useEffect(() => session.onNotes((id) => versions.some((v) => v.id === id) && loadNotes()), [session, versions, loadNotes]);

  /** The shown document's root and window: the page's own, or the iframe's. */
  const root = (): { node: Node; win: Window } | null => {
    if (kind === "html") {
      const doc = frame.current?.contentDocument;
      return doc?.body && frame.current?.contentWindow ? { node: doc.body, win: frame.current.contentWindow } : null;
    }
    return docRef.current ? { node: docRef.current, win: window } : null;
  };

  // Place every note in what is shown: found (any version's, when its words are still there) or not.
  const place = useCallback(() => {
    const r = root();
    if (!r || live) return setPlaced(notes.map((note) => ({ note, range: null })));
    const flat = flatten(r.node);
    const out = notes.map((note) => ({ note, range: findAnchor(r.node, note, flat) }));
    setPlaced(out);
  }, [notes, kind, live, content?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (kind !== "html") place();
  }, [place, kind]);

  useEffect(() => {
    const r = root();
    if (!r) return;
    const hotRange = placed.find((p) => p.note.id === hot)?.range ?? null;
    paint(r.win, placed.flatMap((p) => (p.range ? [p.range] : [])), hotRange);
    hotRange?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [placed, hot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Selecting words in the document offers 写批注.
  const onSelect = () => {
    const r = root();
    const sel = r?.win.getSelection();
    if (!r || !sel || sel.isCollapsed || !sel.rangeCount || live) return setSelBtn(null);
    const range = sel.getRangeAt(0);
    if (!r.node.contains(range.commonAncestorContainer)) return setSelBtn(null);
    const anchor = anchorOf(r.node, range);
    if (!anchor) return setSelBtn(null);
    const rect = range.getBoundingClientRect();
    const off = kind === "html" ? frame.current!.getBoundingClientRect() : { left: 0, top: 0 };
    setSelBtn({ x: rect.left + off.left, y: rect.bottom + off.top + 6, anchor });
  };

  const save = async () => {
    if (!draft || !draftBody.trim() || !file) return;
    try {
      const n = await session.client.addNote(file.id, { ...draft, body: draftBody.trim() });
      setDraft(null);
      setDraftBody("");
      setHot(n.id);
      loadNotes();
    } catch (err) {
      toast(errorText(err));
    }
  };
  const remove = async (id: string) => {
    try {
      await session.client.deleteNote(id);
      loadNotes();
    } catch (err) {
      toast(errorText(err));
    }
  };

  const found = placed.filter((p) => p.range || p.note.version === file?.version);
  const lost = placed.filter((p) => !p.range && p.note.version !== file?.version);
  const copyNotes = async () => {
    if (!file) return;
    await copyText(notesAsText(file, found.map((p) => p.note)));
    toast(`已复制 ${found.length} 条批注，可以贴进回复或给 AI`);
  };
  const srcdoc = useMemo(() => {
    if (kind !== "html" || content?.text === undefined) return "";
    // Static: no scripts run (sandbox without allow-scripts); the highlight styles are ours.
    return live ? content.text : `${content.text}<style>${HIGHLIGHT_CSS}</style>`;
  }, [kind, content, live]);

  let body: ReactNode;
  if (error) body = <div className="notice error">{error}</div>;
  else if (!file || !content || content.id !== file.id) body = <div className="muted center">加载中…</div>;
  else if (kind === "md")
    body = (
      <div className="doc md-doc" ref={docRef} onMouseUp={onSelect}>
        <Markdown source={content.text ?? ""} />
      </div>
    );
  else if (kind === "html")
    body = (
      <iframe
        key={`${file.id}-${live}`}
        ref={frame}
        className="doc-frame"
        title={file.name}
        sandbox={live ? "allow-scripts" : "allow-same-origin"}
        srcDoc={srcdoc}
        onLoad={() => {
          place();
          frame.current?.contentDocument?.addEventListener("mouseup", onSelect);
        }}
      />
    );
  else if (kind === "text")
    body = (
      <div className="doc" ref={docRef} onMouseUp={onSelect}>
        <pre className="doc-pre">{content.text}</pre>
      </div>
    );
  else if (kind === "image") body = <img className="doc-img" src={content.url} alt={file.name} />;
  else
    body = (
      <div className="placeholder">
        <h2>{file.name}</h2>
        <p>这种文件没法在这里预览。</p>
        <a href={session.client.fileUrl(file.id, { download: true, withKey: true })} download={file.name}>
          下载
        </a>
      </div>
    );

  return (
    <Dialog
      className="viewer"
      onClose={onClose}
      title={
        <span className="viewer-title">
          {file?.name ?? "文件"}
          {versions.length > 1 ? (
            <select value={shownId} onChange={(e) => (setShownId(e.target.value), setHot(null), setDraft(null))} aria-label="版本">
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                  {v.id === versions[0]!.id ? "（最新）" : ""} · {v.by}
                </option>
              ))}
            </select>
          ) : (
            file && <span className="chip">v{file.version}</span>
          )}
          {kind === "html" && (
            <button type="button" className="small" onClick={() => setLive(!live)} title="不运行脚本时才能批注；运行脚本时看交互">
              {live ? "运行脚本中 · 回到可批注" : "不运行脚本 · 可批注"}
            </button>
          )}
        </span>
      }
    >
      <div className="viewer-body">
        <div className="doc-pane" onScroll={() => setSelBtn(null)}>
          {body}
        </div>
        <aside className="notes-pane">
          <div className="nav-label">
            批注<span className="count">{found.length}</span>
            <span className="rule" />
          </div>
          {draft && (
            <div className="note new">
              <span className="quote">{draft.quote}</span>
              <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={3} placeholder="写意见，比如：这里配成表更好调" autoFocus />
              <div className="acts">
                <button type="button" className="small" onClick={() => setDraft(null)}>
                  取消
                </button>
                <button type="button" className="small primary" disabled={!draftBody.trim()} onClick={() => void save()}>
                  保存
                </button>
              </div>
            </div>
          )}
          {found.map(({ note: n, range }) => (
            <div key={n.id} className={`note ${hot === n.id ? "hot" : ""}`} onClick={() => setHot(hot === n.id ? null : n.id)}>
              <span className="quote">{n.quote}</span>
              {n.body}
              <div className="by">
                {n.author} · {timeText(n.at)}
                {n.version !== file?.version ? ` · 写在 v${n.version} 上` : ""}
                {!range && " · 没找到原文"}
                {n.author === me && (
                  <button
                    type="button"
                    className="link tiny"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(n.id);
                    }}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
          {!found.length && !draft && <div className="hint">{file && canNote(file) ? "选中左边文档里的一段文字，就能写批注。" : "这种文件不能批注。"}</div>}
          {lost.length > 0 && (
            <>
              <div className="nav-label">
                原文已改<span className="count">{lost.length}</span>
                <span className="rule" />
              </div>
              {lost.map(({ note: n }) => (
                <div key={n.id} className="note lost">
                  <span className="quote">{n.quote}</span>
                  {n.body}
                  <div className="by">
                    {n.author} · 写在 v{n.version} 上
                  </div>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
      <div className="viewer-foot">
        <span className="muted tiny">{file ? `${file.by} 上传 · ${timeText(file.at)} · ${size(file.size)}` : ""}</span>
        <span className="grow" />
        {file && (
          <a className="link-btn" href={session.client.fileUrl(file.id, { download: true, withKey: true })} download={file.name}>
            下载
          </a>
        )}
        <button type="button" onClick={() => void copyNotes()} disabled={!found.length}>
          复制批注
        </button>
        <button type="button" className="primary" onClick={onClose}>
          完成
        </button>
      </div>
      {selBtn && (
        <button
          type="button"
          className="primary small selbtn"
          style={{ left: selBtn.x, top: selBtn.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setDraft(selBtn.anchor);
            setSelBtn(null);
          }}
        >
          写批注
        </button>
      )}
    </Dialog>
  );
}
