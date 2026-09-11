import { useEffect, useRef, useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { CardRequestError } from "../api/cardClient";
import { addSessionToFocus, loadFocusGroups, type AddSessionToFocusOperation } from "../api/sessionFocusClient";
import type { TaskGroupSnapshot } from "../api/taskGroupClient";
import { focusFrameworkId } from "../runtime/focusCommandRouter";
import type { AgentSession } from "../types";
import "./task-card-focus-picker.css";

export interface TaskCardFocusPickerProps {
  session: AgentSession;
  focusPanelBusy: boolean;
  onOpenFocus: () => void;
  onClose: () => void;
  onAdded: (groupName: string) => void;
}

/** Mounted only when the user asks to add a task; does not subscribe to sessions or poll. */
export function TaskCardFocusPicker({ session, focusPanelBusy, onOpenFocus, onClose, onAdded }: TaskCardFocusPickerProps) {
  const [snapshot, setSnapshot] = useState<TaskGroupSnapshot | null>(null);
  const [groupId, setGroupId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [retry, setRetry] = useState<AddSessionToFocusOperation | null>(null);
  const inFlight = useRef(false);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void loadFocusGroups(controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setSnapshot(next);
      setGroupId(current => next.groups.some(group => group.groupId === current) ? current : "");
    }).catch(reason => {
      if (!controller.signal.aborted) setError(`无法加载分组：${(reason as Error).message}`);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  async function submit() {
    if (inFlight.current || (!retry && !snapshot?.groups.some(group => group.groupId === groupId))) return;
    const operation = retry ?? { operationId: crypto.randomUUID(), sessionRef: { frameworkId: focusFrameworkId(session.tool), sessionId: session.sessionId }, groupId };
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await addSessionToFocus(operation);
      setRetry(null);
      onAdded(snapshot?.groups.find(group => group.groupId === operation.groupId)?.name ?? "所选分组");
      onClose();
    } catch (reason) {
      // A transport/5xx error can arrive after persistence. Keep the exact operation for retry.
      const uncertain = !(reason instanceof CardRequestError) || reason.status >= 500;
      setRetry(uncertain ? operation : null);
      if (!uncertain) setGroupId("");
      setError(uncertain ? "请求结果尚未确认。请重试同一请求，确认卡片是否已加入；重试不会重复创建。" : `未能加入分组：${(reason as Error).message} 请刷新后重新选择分组。`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <div className="task-focus-picker-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <section ref={dialog} tabIndex={-1} className="task-focus-picker" role="dialog" aria-modal="true" aria-labelledby="task-focus-picker-title"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); if (!busy) onClose(); }
        if (event.key === "Tab") {
          const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)');
          if (!nodes?.length) { event.preventDefault(); return; }
          const first = nodes[0]; const last = nodes[nodes.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header><strong id="task-focus-picker-title">加入 Focus 分组</strong><button type="button" aria-label="关闭分组选择" disabled={busy} onClick={onClose}><X size={15} /></button></header>
      <p className="task-focus-picker-title">{session.taskTitle || session.title || session.sessionId}</p>
      {loading ? <p role="status">正在加载分组…</p> : snapshot?.groups.length ? <label>选择分组
        <select value={groupId} disabled={busy || !!retry} onChange={event => setGroupId(event.target.value)}>
          <option value="">请选择分组</option>
          {snapshot.groups.map(group => <option key={group.groupId} value={group.groupId}>{group.name}{group.dragOnly ? "（仅拖拽时显示）" : ""}</option>)}
        </select>
      </label> : snapshot ? <p>先在 Focus 分组设置创建分组。</p> : null}
      {error ? <p className="task-focus-picker-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" disabled={busy || loading || !!retry} onClick={() => setRefresh(value => value + 1)}>刷新分组</button>
        {snapshot && !snapshot.groups.length ? <button type="button" disabled={busy || focusPanelBusy} onClick={onOpenFocus}>打开 Focus Panel</button> : null}
        {snapshot?.groups.length || retry ? <button type="button" className="task-focus-picker-submit" disabled={busy || loading || (!retry && !groupId)} onClick={() => void submit()}><FolderPlus size={14} />{busy ? "正在加入…" : retry ? "重试同一请求" : "加入分组"}</button> : null}
      </footer>
    </section>
  </div>;
}
