import { useEffect, useMemo, useRef, useState } from "react";
import type { OutsideSession, OutsideSessionList, OutsideSessionPreview, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { relativeTime } from "../lib/status.js";
import { formatBytes } from "../lib/bytes.js";

// 接续已有会话 (2026-11-05, plans/done/resume-cli-sessions.md): the Claude sessions of a terminal or the Claude desktop app that
// Studio does not have, grouped by the project their folder is in (the new-task page's project first, those in no
// project last). Search on top, the list on the left, the end of the picked one's conversation on the right to know it
// by. 接续这个 (or Enter, or a double click) hands it back to the page, which fills in the task.

export const SOURCE_LABEL: Record<OutsideSession["source"], string> = { cli: "终端", desktop: "Claude 桌面版", other: "其他程序" };

export function ResumePicker({ link, projects, projectId, onPick, onClose }: { link: HostLink; projects: readonly Workspace[]; /** The page's project: its group first. */ projectId: string | null; onPick(s: OutsideSession): void; onClose(): void }) {
  const [list, setList] = useState<OutsideSessionList | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, OutsideSessionPreview | string>>({});
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  useEffect(() => {
    let live = true;
    call(link, "GET /api/claude/outside-sessions").then(
      (l) => live && setList(l),
      (err: unknown) => live && setError(err instanceof HostApiError ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [link]);

  const projectName = (id: string | null) => (id ? (projects.find((w) => w.id === id)?.name ?? "某个项目") : null);
  // Groups in order: the page's project, the other projects by name, then 不在已有项目里.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = (list?.sessions ?? []).filter((s) => !q || [s.title, s.firstPrompt ?? "", s.cwd, s.gitBranch ?? ""].some((t) => t.toLowerCase().includes(q)));
    const byProject = new Map<string | null, OutsideSession[]>();
    for (const s of shown) byProject.set(s.workspaceId, [...(byProject.get(s.workspaceId) ?? []), s]);
    const rank = (id: string | null) => (id === null ? 2 : id === projectId ? 0 : 1);
    return [...byProject.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || (projectName(a) ?? "").localeCompare(projectName(b) ?? ""))
      .map(([id, sessions]) => ({ id, name: projectName(id) ?? "不在已有项目里", sessions }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, query, projectId, projects]);
  const flat = groups.flatMap((g) => g.sessions);
  const picked = flat.find((s) => s.id === pickedId) ?? flat[0] ?? null;

  // The end of the picked one's conversation, read once per session.
  useEffect(() => {
    if (!picked || previews[picked.id] !== undefined) return;
    const id = picked.id;
    call(link, "GET /api/claude/outside-sessions/:id/preview", { id }).then(
      (p) => setPreviews((m) => ({ ...m, [id]: p })),
      (err: unknown) => setPreviews((m) => ({ ...m, [id]: err instanceof HostApiError ? err.message : String(err) })),
    );
  }, [link, picked, previews]);

  const move = (step: number) => {
    if (!flat.length) return;
    const at = picked ? flat.indexOf(picked) : -1;
    setPickedId(flat[(at + step + flat.length) % flat.length]!.id);
  };
  const preview = picked ? previews[picked.id] : undefined;

  return (
    <Modal portal className="prompt-modal resume-modal" labelledBy="resume-title" testId="resume-dialog" onClose={onClose}>
      <span className="modal-title" id="resume-title">
        接续已有会话
      </span>
      <span className="settings-hint">在终端或 Claude 桌面版里开的 Claude 会话。接过来的是一份副本：原会话不动，那边还开着也没关系。</span>
      <div className="prompt-body">
        <div className="prompt-side">
          <input
            ref={search}
            className="field"
            value={query}
            placeholder="搜索标题、目录或分支"
            aria-label="搜索会话"
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
                onPick(picked);
              }
            }}
          />
          <div className="prompt-list" role="listbox" aria-label="会话">
            {groups.map((g) => (
              <div key={g.id ?? "none"} className="resume-group" role="group" aria-label={g.name}>
                <span className="resume-group-name">{g.name}</span>
                {g.sessions.map((s) => (
                  <button key={s.id} type="button" role="option" aria-selected={s.id === picked?.id} className="prompt-item" onClick={() => setPickedId(s.id)} onDoubleClick={() => onPick(s)} data-testid="resume-item" data-id={s.id}>
                    <span className="prompt-item-title">{s.title}</span>
                    <span className="prompt-item-sub">
                      {SOURCE_LABEL[s.source]} · {relativeTime(s.lastModified)}
                      {s.bytes !== undefined ? ` · ${formatBytes(s.bytes)}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {error && <span className="form-error prompt-empty">{error}</span>}
            {list?.unavailable && <span className="settings-hint prompt-empty" data-testid="resume-unavailable">{list.unavailable}</span>}
            {list && !list.unavailable && !flat.length && (
              <span className="settings-hint prompt-empty" data-testid="resume-empty">
                {list.sessions.length ? "没有符合的会话。" : "没有可以接续的会话：终端和 Claude 桌面版里的 Claude 会话都已经在 Studio 里了，或者还没有。"}
              </span>
            )}
            {!list && !error && <span className="settings-hint prompt-empty">正在读取…</span>}
          </div>
        </div>
        <div className="prompt-main">
          {picked ? (
            <div className="prompt-preview" data-testid="resume-preview">
              <div className="prompt-preview-head">
                <span className="prompt-item-title">{picked.title}</span>
              </div>
              <dl className="resume-facts">
                <dt>来自</dt>
                <dd>{SOURCE_LABEL[picked.source]}</dd>
                <dt>目录</dt>
                <dd className="resume-path">{picked.cwd}</dd>
                {picked.gitBranch && (
                  <>
                    <dt>分支</dt>
                    <dd>{picked.gitBranch}</dd>
                  </>
                )}
                <dt>最后活动</dt>
                <dd>{relativeTime(picked.lastModified)}</dd>
                {typeof preview === "object" && (
                  <>
                    <dt>对话</dt>
                    <dd data-testid="resume-count">
                      {preview.total} 条{preview.compacted ? " · 压缩过上下文，只接最后一次压缩之后的" : ""}
                    </dd>
                  </>
                )}
              </dl>
              <div className="resume-tail" data-testid="resume-tail">
                {preview === undefined && <span className="settings-hint">正在读取最后几条…</span>}
                {typeof preview === "string" && <span className="form-error">{preview}</span>}
                {typeof preview === "object" &&
                  preview.messages.map((m, i) => (
                    <div key={i} className={`resume-msg ${m.role}`}>
                      <span className="resume-role">{m.role === "user" ? "你" : "Claude"}</span>
                      <span className="resume-text">{m.text}</span>
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            <span className="settings-hint prompt-empty">{list ? "选一个会话看它最后聊到哪。" : "正在读取…"}</span>
          )}
        </div>
      </div>
      <div className="settings-row end">
        <button type="button" className="btn-ghost small" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn-primary small" disabled={!picked} onClick={() => picked && onPick(picked)} data-testid="resume-pick">
          接续这个
        </button>
      </div>
    </Modal>
  );
}
