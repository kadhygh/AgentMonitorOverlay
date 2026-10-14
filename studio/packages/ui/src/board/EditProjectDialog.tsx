import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

/**
 * 编辑项目 (2026-10-14): the name a project has in Studio (two folders with the same name can be told apart; the folder
 * itself is not renamed) and a note on it, which agents read through project_context.
 */
export function EditProjectDialog({ link, workspace, onClose }: { link: HostLink; workspace: Workspace; onClose(): void }) {
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.select(), []);

  async function save() {
    if (!name.trim()) return setError("名字不能为空");
    setBusy(true);
    setError("");
    try {
      await call(link, "PATCH /api/workspaces/:id", { id: workspace.id }, { name: name.trim(), description: description.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (!busy) onClose();
        }
      }}
    >
      <form
        className="modal confirm-modal edit-project"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-project-title"
        data-testid="edit-project"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <span className="modal-title" id="edit-project-title">
          编辑项目
        </span>
        <label className="stack-field">
          在 AMO 里显示的名字
          <input ref={first} className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="edit-project-name" />
        </label>
        <label className="stack-field">
          说明（给自己和 agent 看，可以留空）
          <textarea
            className="field"
            rows={4}
            value={description}
            maxLength={2000}
            placeholder="例如：Unity 主工程；策划表在 Docs/，美术资源走 BatchTextureImporter。"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
            data-testid="edit-project-description"
          />
        </label>
        <div className="edit-project-folder">
          <span className="settings-hint">文件夹</span>
          <code>{workspace.path}</code>
          <span className="settings-hint">只改 AMO 里的名字，文件夹本身不会改名。</span>
        </div>
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <div className="settings-row end">
          <button type="button" className="btn-ghost small" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary small" disabled={busy || !name.trim()} data-testid="edit-project-save">
            保存
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
