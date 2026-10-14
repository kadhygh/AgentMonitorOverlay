import { useCallback, useEffect, useState } from "react";
import { DATA_KIND_LABEL, type ArchivedEntry, type DataKind, type PurgeSummary } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { formatDay } from "../task/Archived.js";

// 设置 → 数据管理 (2026-10-14): what is archived (projects, topics, tasks, sessions), restored to where it was or
// deleted for good. Deleting asks first and says what goes with it.

const FILTERS: { id: DataKind | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "workspace", label: "项目" },
  { id: "topic", label: "专题" },
  { id: "task", label: "任务" },
  { id: "session", label: "会话" },
];

/** Events after which the list may have changed. */
const REFRESH = new Set(["workspace.upserted", "topic.upserted", "task.upserted", "session.upserted", "data.purged"]);

function restore(link: HostLink, e: ArchivedEntry): Promise<unknown> {
  if (e.kind === "workspace") return call(link, "POST /api/workspaces/:id/unarchive", { id: e.id });
  if (e.kind === "topic") return call(link, "POST /api/topics/:id/unarchive", { id: e.id });
  if (e.kind === "task") return call(link, "POST /api/tasks/:id/unarchive", { id: e.id });
  return call(link, "POST /api/sessions/:id/unarchive", { id: e.id });
}

/** "3 个任务、5 个会话、120 条对话记录". */
function takes(s: PurgeSummary): string {
  const parts = [
    s.kind !== "topic" && s.topics ? `${s.topics} 个专题` : "",
    s.kind !== "task" && s.tasks ? `${s.tasks} 个任务` : "",
    s.sessions ? `${s.sessions} 个会话` : "",
    s.items ? `${s.items} 条对话记录` : "",
    s.attachments ? `${s.attachments} 张贴进对话的图片` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "没有别的内容";
}

export function DataPage({ link }: { link: HostLink }) {
  const [entries, setEntries] = useState<ArchivedEntry[] | null>(null);
  const [filter, setFilter] = useState<DataKind | "all">("all");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ entry: ArchivedEntry; summary: PurgeSummary } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    call(link, "GET /api/data/archived")
      .then(setEntries)
      .catch((err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true }));
  }, [link]);

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onHostEvent((e) => {
      if (!REFRESH.has(e.type)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load]);

  const fail = (err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });

  async function onRestore(e: ArchivedEntry) {
    setBusy(e.id);
    setMessage(null);
    try {
      await restore(link, e);
      setMessage({ text: `已恢复${DATA_KIND_LABEL[e.kind]}「${e.title}」` });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function askDelete(e: ArchivedEntry) {
    setBusy(e.id);
    setMessage(null);
    try {
      const summary = await call(link, "GET /api/data/purge", {}, undefined, { kind: e.kind, id: e.id });
      setConfirm({ entry: e, summary });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!confirm) return;
    setBusy(confirm.entry.id);
    try {
      const done = await call(link, "POST /api/data/purge", {}, { kind: confirm.entry.kind, id: confirm.entry.id });
      setConfirm(null);
      setMessage({ text: `已彻底删除${DATA_KIND_LABEL[done.kind]}「${done.title}」` });
    } catch (err) {
      setConfirm(null);
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const shown = (entries ?? []).filter((e) => filter === "all" || e.kind === filter);
  const count = (k: DataKind | "all") => (entries ?? []).filter((e) => k === "all" || e.kind === k).length;

  return (
    <section className="settings-section" aria-label="数据管理">
      <span className="settings-heading">数据管理</span>
      <span className="settings-hint">
        已归档的项目、专题、任务和会话。恢复后回到原处；彻底删除后找不回来。项目文件夹里的文件，以及 Codex、Claude Code 自己保存的对话记录，都不会被删除。
      </span>
      <div role="radiogroup" aria-label="类型" className="chips">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="radio" className="chip" aria-checked={filter === f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} {count(f.id)}
          </button>
        ))}
      </div>
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="data-message">
          {message.text}
        </span>
      )}
      {entries === null ? (
        <span className="settings-hint">读取中…</span>
      ) : shown.length === 0 ? (
        <span className="settings-hint" data-testid="data-empty">
          {filter === "all" ? "没有已归档的内容。" : `没有已归档的${DATA_KIND_LABEL[filter]}。`}
        </span>
      ) : (
        <ul className="data-list" data-testid="data-list">
          {shown.map((e) => (
            <li key={`${e.kind}:${e.id}`} className="data-row" data-testid="data-row" data-kind={e.kind}>
              <span className="data-kind">{DATA_KIND_LABEL[e.kind]}</span>
              <span className="data-main">
                <span className="data-title">{e.title}</span>
                <span className="data-meta">{[e.context, `${formatDay(e.archivedAt)} 归档`].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="data-actions">
                <button type="button" className="btn-ghost small" disabled={busy === e.id} onClick={() => void onRestore(e)} data-testid="data-restore">
                  恢复
                </button>
                <button type="button" className="btn-ghost small danger" disabled={busy === e.id} onClick={() => void askDelete(e)} data-testid="data-delete">
                  彻底删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog
          title={`彻底删除${DATA_KIND_LABEL[confirm.entry.kind]}「${confirm.entry.title}」？`}
          action="彻底删除"
          danger
          busy={busy === confirm.entry.id}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void onDelete()}
          testId="data-delete-confirm"
        >
          <ul className="confirm-risks">
            <li>一起删除：{takes(confirm.summary)}。</li>
            {confirm.entry.kind === "workspace" && <li>只删除 Studio 里的记录（任务、会话、批注、文件标记），项目文件夹本身和里面的文件不动。</li>}
            <li>Codex、Claude Code 自己保存的对话记录不会被删除。</li>
            <li>删除后不能恢复。</li>
          </ul>
        </ConfirmDialog>
      )}
    </section>
  );
}
