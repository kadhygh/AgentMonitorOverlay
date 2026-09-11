import { useEffect, useRef, useState } from "react";
import { CardRequestError, executeCardCommands, loadCard, type Card, type CardCommandOperation } from "../api/cardClient";
import type { FocusCardView, TaskGroup } from "./model";
import { componentOf, groupCommand, groupOf, noteOf } from "./manualGroups";
import { FocusDialog } from "./FocusDialog";
import { FocusSessionDetail } from "./FocusSessionDetail";

type Draft = { base: Card; title: string; note: string; groupId: string | null };
const draftFor = (base: Card): Draft => ({ base, title: base.title, note: noteOf(base), groupId: groupOf(base) });
const dirty = (d: Draft) => d.title !== d.base.title || d.note !== noteOf(d.base) || d.groupId !== groupOf(d.base);

// Kept mounted by the panel, so closing a dialog or hiding the window retains its draft/replay.
export function FocusCardEditor({ cardId, card, groups, open, onClose, onChanged, onList }: {
  cardId: string; card?: FocusCardView; groups: TaskGroup[]; open: boolean; onClose: () => void; onChanged: () => void; onList: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null), [latest, setLatest] = useState<Card | null>(null);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<CardCommandOperation | null>(null), inFlight = useRef(false);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void loadCard(cardId, abort.signal).then(({ card: value }) => {
      if (abort.signal.aborted) return;
      setLatest(previous => !previous || value.revision >= previous.revision ? value : previous);
      setDraft(previous => !previous || !dirty(previous) && !request.current ? draftFor(value) : previous);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取卡片"); });
    return () => abort.abort();
  }, [cardId, open, card?.revision]);
  const stale = !!draft && !!latest && draft.base.revision !== latest.revision;
  async function save(action: "save" | "archive" | "restore" = "save") {
    if (!draft || inFlight.current || !draft.title.trim()) return;
    const commands: Record<string, unknown>[] = [];
    if (action === "save") {
      if (draft.title !== draft.base.title) commands.push({ type: "set-title", title: draft.title.trim() });
      if (draft.note !== noteOf(draft.base)) {
        const notes = componentOf(draft.base, "amo.notes");
        commands.push(notes ? { type: "set-note", componentId: notes.componentId, text: draft.note } : { type: "set-component", component: { componentId: crypto.randomUUID(), type: "amo.notes", schemaVersion: 1, data: { text: draft.note } } });
      }
      if (draft.groupId !== groupOf(draft.base)) commands.push(groupCommand(draft.base, draft.groupId));
    } else commands.push({ type: action });
    if (!commands.length && !request.current) return;
    const operation = request.current ?? { operationId: crypto.randomUUID(), expectedRevision: draft.base.revision, commands };
    request.current = operation; inFlight.current = true; setSaving(true); setError(""); setMessage("");
    try {
      const result = await executeCardCommands(cardId, operation);
      request.current = null; setUncertain(false); setConflict(false);
      setLatest(result.card);
      setDraft(draftFor(result.card));
      setMessage("已保存"); onChanged();
    } catch (reason) {
      const certain = reason instanceof CardRequestError && reason.status >= 400 && reason.status < 500;
      if (certain) { request.current = null; setConflict(reason.status === 409); }
      setUncertain(!certain); setError(reason instanceof Error ? reason.message : "保存失败，草稿已保留"); onChanged();
    } finally { inFlight.current = false; setSaving(false); }
  }
  if (!open) return null;
  const locked = saving || uncertain;
  const groupMissing = !!draft?.groupId && !groups.some(g => g.groupId === draft.groupId);
  return <FocusDialog title="任务详情" onClose={onClose}>
    {!draft && <p role="status">{error || "正在读取卡片…"}</p>}
    {draft && <>
      <label className="amo-focus-field">标题<input aria-label="卡片标题" maxLength={2000} value={draft.title} disabled={locked} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      <label className="amo-focus-field">Task group<select aria-label="Task group" value={draft.groupId ?? ""} disabled={locked} onChange={e => setDraft({ ...draft, groupId: e.target.value || null })}><option value="">不加入面板分组</option>{groupMissing && <option value={draft.groupId!} disabled>分组已删除，请重新选择</option>}{groups.map(group => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}</select></label>
      {card ? <FocusSessionDetail card={card} /> : <p>此卡片已离开 Focus 队列，草稿仍保留。</p>}
      <label className="amo-focus-field">工作备注 <small>{draft.note.length}/2000</small><textarea aria-label="工作备注" maxLength={2000} value={draft.note} disabled={locked} onChange={e => setDraft({ ...draft, note: e.target.value })} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!locked && !stale && !conflict) void save(); } }} /></label>
      {(stale || conflict) && <div className="amo-focus-error" role="status">卡片已更新。当前草稿已保留，请核对最新内容。
        {latest && <><div className="amo-focus-latest"><strong>最新保存内容</strong><p>{latest.title}</p><p>{noteOf(latest) || "（无备注）"}</p><p>分组：{groups.find(g => g.groupId === groupOf(latest))?.name || "无面板分组引用"}</p></div><button disabled={locked} onClick={() => { setDraft({ ...draft, base: latest }); setConflict(false); setError(""); }}>保留草稿并使用最新版本</button><button disabled={locked} onClick={() => { setDraft(draftFor(latest)); setConflict(false); setError(""); }}>使用最新保存内容</button></>}
      </div>}
      {error && <p className="amo-focus-error" role="alert">{error}</p>}
      {uncertain && <button disabled={saving} onClick={() => void save()}>Retry same request</button>}
      <div className="amo-focus-dialog-actions"><button disabled={locked || stale || conflict || dirty(draft)} onClick={() => void save(draft.base.archivedAt ? "restore" : "archive")}>{draft.base.archivedAt ? "恢复 Card" : "归档 Card"}</button><button onClick={onList}>全部分组</button><button className="amo-focus-primary" disabled={locked || stale || conflict || groupMissing || !draft.title.trim() || !dirty(draft)} onClick={() => void save()}>{saving ? "保存中…" : "保存卡片"}</button></div>
      <p className="amo-focus-caption" role="status">{dirty(draft) ? "有未保存内容；关闭详情或隐藏面板会保留草稿。" : message || (draft.base.archivedAt ? "Card 已归档，Session 执行不受影响。" : "已保存")}</p>
    </>}
  </FocusDialog>;
}
