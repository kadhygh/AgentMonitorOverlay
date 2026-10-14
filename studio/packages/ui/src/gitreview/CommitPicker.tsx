import { useEffect, useMemo, useRef, useState } from "react";
import type { GitLog } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { formatWhen } from "../attach/refs.js";
import { filterCommits, markWords, queryWords, shortSha } from "./history.js";

/**
 * 历史 (S13-B): the branch's latest commits, found like files in 找文件 (Ctrl+P): one box that matches the subject,
 * the hash and the author. Enter (or a click) opens the commit in a window of its own.
 */
export function CommitPicker({ link, workspaceId, onPick, onClose }: { link: HostLink; workspaceId: string; onPick(sha: string): void; onClose(): void }) {
  const [log, setLog] = useState<GitLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    call(link, "GET /api/workspaces/:id/git/log", { id: workspaceId })
      .then((l) => live && setLog(l))
      .catch((err: unknown) => live && setError(err instanceof HostApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [link, workspaceId]);

  const words = useMemo(() => queryWords(query), [query]);
  const commits = useMemo(() => filterCommits(log?.commits ?? [], query), [log, query]);
  useEffect(() => setHighlight(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = (i: number) => {
    const c = commits[i];
    if (!c) return;
    onPick(c.sha);
    onClose();
  };
  const marked = (text: string) => markWords(text, words).map((r, k) => (r.hit ? <mark key={k}>{r.text}</mark> : <span key={k}>{r.text}</span>));

  return (
    <div className="file-picker-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="file-picker commit-picker" role="dialog" aria-label="提交历史" data-testid="commit-picker">
        <input
          className="file-picker-input"
          autoFocus
          value={query}
          placeholder="搜索提交说明、hash 或作者，空格分开多个词"
          aria-label="搜索提交"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (commits.length) setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : commits.length - 1)) % commits.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              pick(highlight);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="file-picker-list" role="listbox" aria-label="提交" ref={list}>
          {commits.map((c, i) => (
            <button
              key={c.sha}
              type="button"
              role="option"
              data-index={i}
              data-testid="commit-row"
              data-sha={c.sha}
              aria-selected={i === highlight}
              className={i === highlight ? "hl" : undefined}
              title={`${c.sha}\n${c.author} <${c.email}>\n${new Date(c.date).toLocaleString()}\n\n${c.subject}`}
              onMouseMove={() => setHighlight(i)}
              onClick={() => pick(i)}
            >
              <span className="commit-sha">{marked(shortSha(c.sha))}</span>
              <span className="commit-subject">{marked(c.subject || "（没有说明）")}</span>
              <span className="commit-author">{marked(c.author)}</span>
              <span className="file-row-meta when">{formatWhen(c.date)}</span>
            </button>
          ))}
          {log && !commits.length && <div className="file-picker-empty">{query.trim() ? "没有匹配的提交" : "还没有提交"}</div>}
          {error && <div className="file-picker-empty error">{error}</div>}
        </div>
        <div className="file-picker-foot">
          <span>
            {log
              ? query.trim()
                ? `${commits.length} 个匹配`
                : `${log.branch ?? "分离的 HEAD"} 最近 ${log.commits.length} 个提交${log.truncated ? "（更早的没有列出）" : ""}`
              : error
                ? ""
                : "正在读取提交…"}
          </span>
          <span className="spacer" />
          <span>↑↓ 选择 · 回车在新窗口查看 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
