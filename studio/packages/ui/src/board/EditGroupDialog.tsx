import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HostApiError } from "../host/client.js";

/**
 * 新建分组 / 编辑分组 (项目分组, 2026-10-22): the group's name and the person's own note on it. `onSave` stores it; the
 * dialog stays open with the Host's message when that fails.
 */
export function EditGroupDialog({ creating, name: initialName = "", description: initialDescription = "", onSave, onClose }: {
  creating: boolean;
  name?: string;
  description?: string;
  onSave(name: string, description: string): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.select(), []);

  async function save() {
    if (!name.trim()) return setError("名字不能为空");
    setBusy(true);
    setError("");
    try {
      await onSave(name.trim(), description.trim());
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
        aria-labelledby="edit-group-title"
        data-testid="edit-group"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <span className="modal-title" id="edit-group-title">
          {creating ? "新建分组" : "编辑分组"}
        </span>
        <label className="stack-field">
          名字
          <input ref={first} className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="edit-group-name" />
        </label>
        <label className="stack-field">
          说明（只给自己看，可以留空）
          <textarea
            className="field"
            rows={3}
            value={description}
            maxLength={2000}
            placeholder="例如：Unity 客户端和它的资源仓库；发版前一起看改动。"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
            data-testid="edit-group-description"
          />
        </label>
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <div className="settings-row end">
          <button type="button" className="btn-ghost small" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary small" disabled={busy || !name.trim()} data-testid="edit-group-save">
            {creating ? "建立" : "保存"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
