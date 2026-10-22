import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GitLog } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { formatWhen } from "../attach/refs.js";
import { filterCommits, markWords, queryWords, shortSha } from "./history.js";

// A window's last history by project (2026-10-16): 历史 opens on it at once and reads the log again behind it (a git
// start costs about 100 ms on the person's machine). The review window reads it ahead, once its own files are in.
const logs = new Map<string, GitLog>();
const reading = new Map<string, Promise<GitLog>>();

// One formatter for the rows' tooltips (toLocaleString makes a new one each call: slow over 500 rows).
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
/** Rows drawn in the first frame (and as far as the current commit); the rest come right after. */
const FIRST_ROWS = 100;

/** The project's history, read again; the same object when nothing changed (the list keeps its place). */
export function readHistory(link: HostLink, workspaceId: string): Promise<GitLog> {
  const pending = reading.get(workspaceId);
  if (pending) return pending;
  const read = call(link, "GET /api/workspaces/:id/git/log", { id: workspaceId })
    .then((l) => {
      const had = logs.get(workspaceId);
      const same = had && had.head === l.head && had.branch === l.branch && had.commits.length === l.commits.length;
      const kept = same ? had : l;
      logs.set(workspaceId, kept);
      return kept;
    })
    .finally(() => reading.delete(workspaceId));
  reading.set(workspaceId, read);
  return read;
}

/**
 * 历史 (S13-B): the branch's latest commits, found like files in 找文件 (Ctrl+P): one box that matches the subject,
 * the hash and the author. Enter (or a click) opens the commit in a window of its own.
 * 2026-10-16: opened from a commit's window, that commit is marked [CURRENT] and the list starts there, so the person
 * can go on from where they were. In a commit's window a pick switches that window; a right click opens a new one.
 * Opened with h (`keys`), the list has the keys like the review: j / k (or ↓ / ↑) pick, Enter or Space opens, h or Esc close;
 * / or any other letter starts a search in the box.
 */
export function CommitPicker({
  link,
  workspaceId,
  current,
  onPick,
  onPickNew,
  keys = false,
  onClose,
}: {
  link: HostLink;
  workspaceId: string;
  current?: string | null;
  onPick(sha: string): void;
  /** Right click: in a new window. */
  onPickNew?(sha: string): void;
  /** Opened with h: the list takes the keys until a search starts. */
  keys?: boolean;
  onClose(): void;
}) {
  const [log, setLog] = useState<GitLog | null>(() => logs.get(workspaceId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => (keys ? box : input).current?.focus(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    readHistory(link, workspaceId)
      .then((l) => live && setLog(l))
      .catch((err: unknown) => {
        if (!live) return;
        logs.delete(workspaceId);
        setLog(null);
        setError(err instanceof HostApiError ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [link, workspaceId]);

  const words = useMemo(() => queryWords(query), [query]);
  const commits = useMemo(() => filterCommits(log?.commits ?? [], query), [log, query]);
  const isCurrent = (sha: string) => !!current && (sha.startsWith(current) || current.startsWith(sha));
  // The commit shown now, when it is listed: where the highlight starts, scrolled to the middle of the list.
  const startAt = query.trim() ? 0 : Math.max(0, commits.findIndex((c) => isCurrent(c.sha)));
  const [allRows, setAllRows] = useState(false);
  useEffect(() => {
    if (allRows || !log) return;
    const t = setTimeout(() => setAllRows(true), 0);
    return () => clearTimeout(t);
  }, [allRows, log]);
  const drawn = allRows ? commits : commits.slice(0, Math.max(FIRST_ROWS, startAt + 50));
  useEffect(() => setHighlight(startAt), [query, log]); // eslint-disable-line react-hooks/exhaustive-deps
  const centred = useRef(false);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    if (!row) return;
    // Once, when the highlight first lands on the current commit: in the middle of the list.
    const centre = !centred.current && startAt > 0 && highlight === startAt;
    if (centre) centred.current = true;
    row.scrollIntoView({ block: centre ? "center" : "nearest" });
  }, [highlight, log]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (i: number, fresh = false) => {
    const c = commits[i];
    if (!c) return;
    (fresh && onPickNew ? onPickNew : onPick)(c.sha);
    onClose();
  };
  const move = (by: 1 | -1) => commits.length && setHighlight((h) => (h + by + commits.length) % commits.length);
  // The keys of the list itself (h): j / k like the review's files; a letter goes on into the search box.
  const onListKey = (e: KeyboardEvent) => {
    if (e.target === input.current || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
    const k = e.key;
    if (k === "j" || k === "k" || k === "ArrowDown" || k === "ArrowUp") move(k === "j" || k === "ArrowDown" ? 1 : -1);
    else if (k === "Enter" || k === " ") pick(highlight);
    else if (k === "Escape" || k === "h") onClose();
    else if (k === "/") input.current?.focus();
    else if (k.length === 1 && k !== " ") {
      setQuery((q) => q + k);
      input.current?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const marked = (text: string) => markWords(text, words).map((r, k) => (r.hit ? <mark key={k}>{r.text}</mark> : <span key={k}>{r.text}</span>));

  return (
    <div className="file-picker-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="file-picker commit-picker" role="dialog" aria-label="提交历史" data-testid="commit-picker" tabIndex={-1} ref={box} onKeyDown={onListKey}>
        <input
          className="file-picker-input"
          ref={input}
          value={query}
          placeholder="搜索提交说明、hash 或作者，空格分开多个词"
          aria-label="搜索提交"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
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
          {drawn.map((c, i) => (
            <button
              key={c.sha}
              type="button"
              role="option"
              data-index={i}
              data-testid="commit-row"
              data-sha={c.sha}
              aria-selected={i === highlight}
              aria-current={isCurrent(c.sha) || undefined}
              className={[i === highlight ? "hl" : "", isCurrent(c.sha) ? "current" : ""].filter(Boolean).join(" ") || undefined}
              title={`${c.sha}\n${c.author} <${c.email}>\n${fullDate.format(new Date(c.date))}\n\n${c.subject}`}
              onMouseMove={() => setHighlight(i)}
              onClick={() => pick(i)}
              onContextMenu={(e) => {
                e.preventDefault();
                pick(i, true);
              }}
            >
              <span className="commit-sha">{marked(shortSha(c.sha))}</span>
              <span className="commit-subject">{marked(c.subject || "（没有说明）")}</span>
              {isCurrent(c.sha) && (
                <span className="commit-current" title="这个窗口正在看的提交" data-testid="commit-current">
                  [CURRENT]
                </span>
              )}
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
          <span>{keys ? "j / k 选择 · 空格同回车 · / 搜索 · " : ""}{onPickNew ? "↑↓ 选择 · 回车在本窗口切换 · 右键在新窗口打开 · Esc 关闭" : "↑↓ 选择 · 回车在新窗口查看 · Esc 关闭"}</span>
        </div>
      </div>
    </div>
  );
}
