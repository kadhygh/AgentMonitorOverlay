import { useEffect, useState } from "react";
import type { TopicDoc } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { Markdown } from "../lib/markdown.js";
import { formatWhen } from "../attach/refs.js";

/**
 * 文档 (stage 16): the topic's documents — only what driving its tasks needs (plans, decisions, how the parts fit).
 * Agents read them with topic_docs; a 主控 writes them with topic_doc_write. Specialised documents stay in the
 * projects, marked with 文件标记; a document here can name their paths.
 */
export function DocsTab({ link, topicId, readOnly = false }: { link: HostLink; topicId: string; readOnly?: boolean }) {
  const [docs, setDocs] = useState<TopicDoc[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      call(link, "GET /api/topics/:id/docs", { id: topicId })
        .then((d) => live && setDocs(d))
        .catch((err: unknown) => live && setError(err instanceof HostApiError ? err.message : String(err)));
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "topicdoc.upserted" && e.doc.topicId === topicId) setDocs((cur) => (cur ? (cur.some((d) => d.id === e.doc.id) ? cur.map((d) => (d.id === e.doc.id ? e.doc : d)) : [...cur, e.doc]) : cur));
      if (e.type === "topicdoc.removed" && e.topicId === topicId) setDocs((cur) => cur?.filter((d) => d.id !== e.docId) ?? cur);
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      live = false;
      off();
      offReconnect();
    };
  }, [link, topicId]);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const doc = editing.id
        ? await call(link, "PATCH /api/topic-docs/:id", { id: editing.id }, { title: editing.title, body: editing.body })
        : await call(link, "POST /api/topics/:id/docs", { id: topicId }, { title: editing.title, body: editing.body });
      setEditing(null);
      setOpen(doc.id);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (doc: TopicDoc) => {
    if (!window.confirm(`删除专题文档「${doc.title}」？`)) return;
    try {
      await call(link, "DELETE /api/topic-docs/:id", { id: doc.id });
      setOpen(null);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  };

  if (editing) {
    return (
      <div className="side-section docs-edit" role="group" aria-label={editing.id ? "编辑专题文档" : "新专题文档"}>
        <input className="field" aria-label="文档标题" placeholder="标题，例如「迁移计划」" value={editing.title} autoFocus onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
        <textarea className="side-textarea docs-body" aria-label="文档内容" placeholder="Markdown：计划、约定、决定……" value={editing.body} rows={14} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <div className="docs-actions">
          <button type="button" className="btn-ghost small" onClick={() => setEditing(null)}>
            取消
          </button>
          <button type="button" className="btn-primary small" disabled={busy || !editing.title.trim()} onClick={() => void save()} data-testid="doc-save">
            保存
          </button>
        </div>
      </div>
    );
  }

  const shown = open ? docs?.find((d) => d.id === open) : undefined;
  if (shown) {
    return (
      <div className="side-section" role="group" aria-label="专题文档">
        <button type="button" className="link-btn docs-back" onClick={() => setOpen(null)}>
          ‹ 全部文档
        </button>
        <span className="side-heading">{shown.title}</span>
        <span className="side-note">{formatWhen(shown.updatedAt)} 更新</span>
        <div className="docs-view md" data-testid="doc-view">
          {shown.body.trim() ? <Markdown source={shown.body} /> : <span className="side-note">（空）</span>}
        </div>
        {!readOnly && (
          <div className="docs-actions">
            <button type="button" className="btn-ghost small dim" onClick={() => void remove(shown)}>
              删除
            </button>
            <button type="button" className="btn-ghost small" onClick={() => setEditing({ id: shown.id, title: shown.title, body: shown.body })}>
              编辑
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="side-section" role="group" aria-label="专题文档">
      <span className="side-note">只放推进这个专题的任务要用的：计划、约定、决定。agent 用 topic_docs 读，主控可以写。很专门的文档放在项目里，用文件标记标出来，这里写上路径。</span>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      {docs?.map((d) => (
        <button key={d.id} type="button" className="docs-row" onClick={() => setOpen(d.id)} data-testid="doc-row">
          <span className="docs-title">{d.title}</span>
          <span className="side-note">{formatWhen(d.updatedAt)}</span>
        </button>
      ))}
      {docs && !docs.length && <span className="side-note">还没有文档。</span>}
      {!readOnly && (
        <button type="button" className="btn-ghost small" onClick={() => setEditing({ id: null, title: "", body: "" })} data-testid="doc-new">
          + 新文档
        </button>
      )}
    </div>
  );
}
