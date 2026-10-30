import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PROMPT_TEMPLATE_LIMITS, type PromptTemplate, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { usePromptTemplates } from "./usePromptTemplates.js";

// 提示词模板 (2026-10-31): from the composer's @ list (AMO 扩展功能 → 提示词模板…). Search on top, the templates on the
// left (global ones and this project's), the picked one on the right; 粘进输入框 (or Enter) puts its text where @ was
// typed, to be read over and sent by the person. Templates are written here too (新建, 编辑, 删除), or by an agent through
// AMO's MCP when the person asks — those show「AI 写的」.

interface Editing {
  id: string | null;
  title: string;
  body: string;
  workspaceId: string | null;
}

export function PromptTemplateDialog({ link, workspaceId, projects, onDone }: { link: HostLink; workspaceId: string | null; projects: readonly Workspace[]; onDone(text: string | null): void }) {
  const templates = usePromptTemplates(link, workspaceId);
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  // Esc wherever the focus is (after 删除 it may be nowhere in the window): leaves the form, else closes.
  const editingNow = !!editing;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (editingNow) closeEdit();
      else onDone(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const projectName = (id: string | null) => (id ? (projects.find((w) => w.id === id)?.name ?? "某个项目") : "全局");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (templates ?? []).filter((t) => !q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q));
  }, [templates, query]);
  const picked = shown.find((t) => t.id === pickedId) ?? shown[0] ?? null;

  const move = (step: number) => {
    if (!shown.length) return;
    const at = picked ? shown.indexOf(picked) : -1;
    setPickedId(shown[(at + step + shown.length) % shown.length]!.id);
  };
  const edit = (next: Editing) => {
    setError("");
    setEditing(next);
    requestAnimationFrame(() => title.current?.focus());
  };
  const closeEdit = () => {
    setEditing(null);
    setError("");
    requestAnimationFrame(() => search.current?.focus());
  };

  async function save() {
    if (!editing || busy) return;
    if (!editing.title.trim()) return setError("写个标题。");
    if (!editing.body.trim()) return setError("写上模板的内容。");
    setBusy(true);
    setError("");
    try {
      const input = { title: editing.title, body: editing.body, workspaceId: editing.workspaceId };
      const saved: PromptTemplate = editing.id ? await call(link, "PATCH /api/prompt-templates/:id", { id: editing.id }, input) : await call(link, "POST /api/prompt-templates", {}, input);
      setQuery("");
      setPickedId(saved.id);
      closeEdit();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: PromptTemplate) {
    if (busy || !window.confirm(`删除模板「${t.title}」？`)) return;
    setBusy(true);
    setError("");
    try {
      await call(link, "DELETE /api/prompt-templates/:id", { id: t.id });
      setPickedId(null);
      requestAnimationFrame(() => search.current?.focus());
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // The scopes a template can have: everywhere, or one project (this one first).
  const scopes = [...projects].sort((a, b) => Number(b.id === workspaceId) - Number(a.id === workspaceId));

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <div className="modal prompt-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-title" data-testid="prompt-dialog">
        <span className="modal-title" id="prompt-title">
          提示词模板
        </span>
        <div className="prompt-body">
          <div className="prompt-side">
            <input
              ref={search}
              className="field"
              value={query}
              placeholder="搜索标题或内容"
              aria-label="搜索模板"
              disabled={!!editing}
              onChange={(e) => {
                setQuery(e.target.value);
                setPickedId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(e.key === "ArrowDown" ? 1 : -1);
                } else if (e.key === "Enter" && !e.nativeEvent.isComposing && picked) {
                  e.preventDefault();
                  onDone(picked.body);
                }
              }}
            />
            <div className="prompt-list" role="listbox" aria-label="模板">
              {shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={t.id === picked?.id}
                  className="prompt-item"
                  disabled={!!editing}
                  onClick={() => setPickedId(t.id)}
                  onDoubleClick={() => onDone(t.body)}
                  data-testid="prompt-item"
                >
                  <span className="prompt-item-title">{t.title}</span>
                  <span className="prompt-item-sub">
                    {projectName(t.workspaceId)}
                    {t.by === "agent" ? " · AI 写的" : ""}
                  </span>
                </button>
              ))}
              {templates && !shown.length && <span className="settings-hint prompt-empty">{templates.length ? "没有符合的模板。" : "还没有模板。点「新建模板」写一条，或者在对话里让 AI 帮你存：「把下面这段存成提示词模板」。"}</span>}
            </div>
          </div>
          <div className="prompt-main">
            {editing ? (
              <div className="prompt-form" data-testid="prompt-form">
                <input ref={title} className="field" value={editing.title} maxLength={PROMPT_TEMPLATE_LIMITS.title} placeholder="标题，比如：每日巡检" aria-label="模板标题" onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                <label className="settings-row">
                  <span className="settings-label">在哪里出现</span>
                  <select value={editing.workspaceId ?? ""} aria-label="在哪里出现" onChange={(e) => setEditing({ ...editing, workspaceId: e.target.value || null })}>
                    <option value="">全局：所有项目</option>
                    {scopes.map((w) => (
                      <option key={w.id} value={w.id}>
                        只在「{w.name}」
                      </option>
                    ))}
                  </select>
                </label>
                <textarea
                  className="field prompt-text"
                  value={editing.body}
                  maxLength={PROMPT_TEMPLATE_LIMITS.body}
                  placeholder="选中后粘进输入框的内容"
                  aria-label="模板内容"
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
              </div>
            ) : picked ? (
              <div className="prompt-preview" data-testid="prompt-preview">
                <div className="prompt-preview-head">
                  <span className="prompt-item-title">{picked.title}</span>
                  <span className="prompt-item-sub">
                    {projectName(picked.workspaceId)}
                    {picked.by === "agent" ? " · AI 写的" : ""}
                  </span>
                  <span className="prompt-preview-actions">
                    <button type="button" className="link-btn" disabled={busy} onClick={() => edit({ id: picked.id, title: picked.title, body: picked.body, workspaceId: picked.workspaceId })}>
                      编辑
                    </button>
                    <button type="button" className="link-btn danger" disabled={busy} onClick={() => void remove(picked)}>
                      删除
                    </button>
                  </span>
                </div>
                <pre className="prompt-preview-text">{picked.body}</pre>
              </div>
            ) : (
              <span className="settings-hint prompt-empty">{templates ? "选一条模板看内容。" : "正在读取…"}</span>
            )}
          </div>
        </div>
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <div className="settings-row end">
          {editing ? (
            <>
              <span className="settings-hint prompt-keys">Ctrl+Enter 保存</span>
              <button type="button" className="btn-ghost small" onClick={closeEdit}>
                取消
              </button>
              <button type="button" className="btn-primary small" disabled={busy} onClick={() => void save()} data-testid="prompt-save">
                保存
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost small prompt-new" onClick={() => edit({ id: null, title: "", body: "", workspaceId: null })} data-testid="prompt-new">
                新建模板
              </button>
              <span className="settings-hint prompt-keys">↑↓ 选，回车粘进输入框</span>
              <button type="button" className="btn-ghost small" onClick={() => onDone(null)}>
                取消
              </button>
              <button type="button" className="btn-primary small" disabled={!picked} onClick={() => picked && onDone(picked.body)} data-testid="prompt-ok">
                粘进输入框
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
