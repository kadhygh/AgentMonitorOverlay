import { useRef, useState } from "react";
import { CardRequestError } from "../api/cardClient";
import { updateTaskGroups, type TaskGroupCommand, type TaskGroupOperation, type TaskGroupSnapshot } from "../api/taskGroupClient";
import type { TaskGroup } from "./model";
import { FocusDialog } from "./FocusDialog";

type GroupDraft = { name: string; revision: number };
export function TaskGroupSettings({ groups: feedGroups, revision: feedRevision, reviewGroupId: feedReviewGroupId, open, onClose, onChanged }: { groups: TaskGroup[]; revision: number; reviewGroupId: string | null; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(""), [drafts, setDrafts] = useState<Record<string, GroupDraft>>({});
  const [acknowledged, setAcknowledged] = useState<TaskGroupSnapshot | null>(null);
  // Keep the confirmed value visible while the Focus feed catches up after a write.
  const local = acknowledged && acknowledged.revision > feedRevision ? acknowledged : null;
  const groups = local?.groups ?? feedGroups, revision = local?.revision ?? feedRevision;
  const reviewGroupId = local ? local.reviewGroupId : feedReviewGroupId;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false), [conflict, setConflict] = useState(false);
  const pending = useRef<TaskGroupOperation | null>(null), inFlight = useRef(false);
  const pendingKind = useRef<"command" | "visibility">("command");
  async function submit(command?: TaskGroupCommand, expectedRevision = revision, kind: "command" | "visibility" = "command") {
    if (inFlight.current) return;
    const operation = pending.current ?? (command ? { operationId: crypto.randomUUID(), expectedRevision, commands: [command] } : null);
    if (!operation) return;
    if (!pending.current) pendingKind.current = kind;
    pending.current = operation; inFlight.current = true; setBusy(true); setError("");
    try {
      const saved = await updateTaskGroups(operation);
      setAcknowledged(saved);
      pending.current = null; setUncertain(false); setConflict(false);
      for (const item of operation.commands) {
        if (item.type === "create") setName("");
        else if (item.type === "update" && pendingKind.current === "visibility") {
          // A visibility-only write uses the saved name, never a pending rename.
          // It changes no names, so drafts based on its exact revision remain valid.
          setDrafts(previous => Object.fromEntries(Object.entries(previous).map(([id, draft]) => [id,
            draft.revision === operation.expectedRevision ? { ...draft, revision: saved.revision } : draft,
          ])));
        } else if (item.type === "update" || item.type === "delete") setDrafts(previous => { const next = { ...previous }; delete next[item.groupId]; return next; });
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
    setDrafts(previous => ({ ...previous, [group.groupId]: { ...(previous[group.groupId] ?? { name: group.name, revision }), ...changes } }));
  }
  if (!open) return null;
  return <FocusDialog title="分组设置" onClose={onClose}>
    <label className="amo-focus-field">Review 接收分组<select aria-label="Review 接收分组" value={reviewGroupId ?? ""} disabled={locked} onChange={e => void submit({ type: "set-review-group", groupId: e.target.value || null })}><option value="">不自动接收 Review</option>{groups.map(group => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}</select></label>
    <p className="amo-focus-caption">新的待审核回复放入此组；不回收历史回复，不自动恢复已归档 Card。</p>
    {groups.map(group => {
      const draft = drafts[group.groupId], value = draft ?? group;
      const visibility = pendingKind.current === "visibility" ? pending.current?.commands.find(command => command.type === "update" && command.groupId === group.groupId) : undefined;
      return <section key={group.groupId} data-testid="focus-group-setting" data-group-id={group.groupId} className="amo-focus-group-setting">
        <label className="amo-focus-field">分组名称<input aria-label="分组名称" maxLength={80} disabled={locked} value={value.name} onChange={e => edit(group, { name: e.target.value })} /></label>
        <small className="amo-focus-group-id">ID · {group.groupId}</small>
        <label className="amo-focus-checkbox"><input type="checkbox" checked={busy && visibility?.type === "update" ? visibility.dragOnly : group.dragOnly} aria-busy={busy && visibility?.type === "update"} disabled={locked} onChange={e => void submit({ type: "update", groupId: group.groupId, name: group.name, dragOnly: e.target.checked }, revision, "visibility")} />仅拖拽时显示（立即保存）</label>
        {draft && <p className="amo-focus-caption">名称尚未保存。</p>}
        {draft && draft.revision !== revision && <p className="amo-focus-caption">分组设置已有更新，请核对后保存。最新：{group.name} · {group.dragOnly ? "仅拖拽时显示" : "常驻显示"}</p>}
        <div className="amo-focus-dialog-actions"><button disabled={locked} onClick={() => void submit({ type: "delete", groupId: group.groupId })}>删除分组</button><button disabled={locked || !draft || !draft.name.trim() || draft.revision !== revision} onClick={() => void submit({ type: "update", groupId: group.groupId, name: value.name.trim(), dragOnly: group.dragOnly }, draft?.revision)}>保存名称</button></div>
      </section>;
    })}
    {!groups.length && <p className="amo-focus-caption">创建自己的分组。卡片分类由你手动安排。</p>}
    <form className="amo-focus-add-group" onSubmit={e => { e.preventDefault(); if (name.trim()) void submit({ type: "create", name: name.trim(), dragOnly: false }); }}><input aria-label="新分组名称" placeholder="新分组名称" maxLength={80} required value={name} disabled={locked} onChange={e => setName(e.target.value)} /><button type="submit" disabled={locked || !name.trim()}>添加分组</button></form>
    {busy && <p role="status" className="amo-focus-caption">正在保存分组设置…</p>}
    {error && <p role="alert" className="amo-focus-error">{error}</p>}
    {uncertain && <button disabled={busy} onClick={() => void submit()}>Retry same request</button>}
    {(conflict || Object.values(drafts).some(d => d.revision !== revision)) && <button disabled={locked} onClick={() => { setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => groups.some(g => g.groupId === id)).map(([id, draft]) => [id, { ...draft, revision }]))); setConflict(false); setError(""); }}>已核对最新分组 · 保留我的修改</button>}
    <p className="amo-focus-caption">删除分组会清除卡片的分组引用；卡片和备注保留，退出面板展示。</p>
  </FocusDialog>;
}
