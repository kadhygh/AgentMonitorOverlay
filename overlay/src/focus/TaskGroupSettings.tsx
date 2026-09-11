import { useRef, useState } from "react";
import { CardRequestError } from "../api/cardClient";
import { updateTaskGroups, type TaskGroupCommand, type TaskGroupOperation } from "../api/taskGroupClient";
import type { TaskGroup } from "./model";
import { FocusDialog } from "./FocusDialog";

type GroupDraft = { name: string; dragOnly: boolean; revision: number };
export function TaskGroupSettings({ groups, revision, open, onClose, onChanged }: { groups: TaskGroup[]; revision: number; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(""), [drafts, setDrafts] = useState<Record<string, GroupDraft>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false), [conflict, setConflict] = useState(false);
  const pending = useRef<TaskGroupOperation | null>(null), inFlight = useRef(false);
  async function submit(command?: TaskGroupCommand, expectedRevision = revision) {
    if (inFlight.current) return;
    const operation = pending.current ?? (command ? { operationId: crypto.randomUUID(), expectedRevision, commands: [command] } : null);
    if (!operation) return;
    pending.current = operation; inFlight.current = true; setBusy(true); setError("");
    try {
      await updateTaskGroups(operation);
      pending.current = null; setUncertain(false); setConflict(false);
      for (const item of operation.commands) {
        if (item.type === "create") setName("");
        else setDrafts(previous => { const next = { ...previous }; delete next[item.groupId]; return next; });
      }
      onChanged();
    } catch (reason) {
      const certain = reason instanceof CardRequestError && reason.status >= 400 && reason.status < 500;
      if (certain) pending.current = null;
      setUncertain(!certain); setConflict(certain && reason.status === 409);
      setError(reason instanceof Error ? reason.message : "分组保存失败"); onChanged();
    } finally { inFlight.current = false; setBusy(false); }
  }
  const locked = busy || uncertain;
  function edit(group: TaskGroup, changes: Partial<GroupDraft>) {
    setDrafts(previous => ({ ...previous, [group.groupId]: { ...(previous[group.groupId] ?? { name: group.name, dragOnly: group.dragOnly, revision }), ...changes } }));
  }
  if (!open) return null;
  return <FocusDialog title="分组设置" onClose={onClose}>
    {groups.map(group => {
      const draft = drafts[group.groupId], value = draft ?? group;
      return <section key={group.groupId} data-testid="focus-group-setting" data-group-id={group.groupId} className="amo-focus-group-setting">
        <label className="amo-focus-field">分组名称<input aria-label="分组名称" maxLength={80} disabled={locked} value={value.name} onChange={e => edit(group, { name: e.target.value })} /></label>
        <small className="amo-focus-group-id">ID · {group.groupId}</small>
        <label className="amo-focus-checkbox"><input type="checkbox" checked={value.dragOnly} disabled={locked} onChange={e => edit(group, { dragOnly: e.target.checked })} />仅拖拽时显示</label>
        {draft && draft.revision !== revision && <p className="amo-focus-caption">分组设置已有更新，请核对后保存。最新：{group.name} · {group.dragOnly ? "仅拖拽时显示" : "常驻显示"}</p>}
        <div className="amo-focus-dialog-actions"><button disabled={locked} onClick={() => void submit({ type: "delete", groupId: group.groupId })}>删除分组</button><button disabled={locked || !draft || !draft.name.trim() || draft.revision !== revision} onClick={() => void submit({ type: "update", groupId: group.groupId, name: value.name.trim(), dragOnly: value.dragOnly }, draft?.revision)}>保存分组</button></div>
      </section>;
    })}
    {!groups.length && <p className="amo-focus-caption">创建自己的分组。卡片分类由你手动安排。</p>}
    <form className="amo-focus-add-group" onSubmit={e => { e.preventDefault(); if (name.trim()) void submit({ type: "create", name: name.trim(), dragOnly: false }); }}><input aria-label="新分组名称" placeholder="新分组名称" maxLength={80} required value={name} disabled={locked} onChange={e => setName(e.target.value)} /><button type="submit" disabled={locked || !name.trim()}>添加分组</button></form>
    {error && <p role="alert" className="amo-focus-error">{error}</p>}
    {uncertain && <button disabled={busy} onClick={() => void submit()}>Retry same request</button>}
    {(conflict || Object.values(drafts).some(d => d.revision !== revision)) && <button disabled={locked} onClick={() => { setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => groups.some(g => g.groupId === id)).map(([id, draft]) => [id, { ...draft, revision }]))); setConflict(false); setError(""); }}>已核对最新分组 · 保留我的修改</button>}
    <p className="amo-focus-caption">删除分组会清除卡片的分组引用；卡片和备注保留，退出面板展示。</p>
  </FocusDialog>;
}
