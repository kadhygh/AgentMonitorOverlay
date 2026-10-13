import { useEffect, useRef, useState } from "react";
import { absolutePath, highlightRuns, type ProjectFiles } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { formatBytes, formatWhen } from "./refs.js";

const LIMIT = 100;

/**
 * 找文件 (Ctrl+P in a session, or "找文件…" in the @ list): fuzzy search over the project's files. Arrow keys move,
 * Enter references the file in the composer, Esc closes.
 */
export function FileSelector({ link, workspaceId, initialQuery = "", onPick, onClose }: { link: HostLink; workspaceId: string; initialQuery?: string; onPick(path: string): void; onClose(): void }) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<ProjectFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // The first listing goes at once; typing waits a moment so every key does not ask the Host.
  const first = useRef(true);

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(
      () =>
        void call(link, "GET /api/workspaces/:id/files", { id: workspaceId }, undefined, { q: query, limit: String(LIMIT) })
          .then((r) => {
            if (stale) return;
            setResult(r);
            setError(null);
            setHighlight(0);
          })
          .catch((err: unknown) => !stale && setError(err instanceof HostApiError ? err.message : String(err))),
      first.current ? 0 : 100,
    );
    first.current = false;
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [link, workspaceId, query]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const files = result?.files ?? [];
  const pick = (i: number) => {
    const f = files[i];
    if (!f || !result) return;
    onPick(absolutePath(result.root, f.path));
    onClose();
  };

  return (
    <div className="file-picker-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="file-picker" role="dialog" aria-label="找文件" data-testid="file-picker">
        <input
          className="file-picker-input"
          autoFocus
          value={query}
          placeholder="输入文件名或路径的一部分，空格分开多个词"
          aria-label="找文件"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (files.length) setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : files.length - 1)) % files.length);
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
        <div className="file-picker-list" role="listbox" aria-label="文件" ref={list}>
          {files.map((f, i) => (
            <button
              key={f.path}
              type="button"
              role="option"
              data-index={i}
              data-testid="file-row"
              aria-selected={i === highlight}
              className={i === highlight ? "hl" : undefined}
              title={result ? absolutePath(result.root, f.path) : f.path}
              onMouseMove={() => setHighlight(i)}
              onClick={() => pick(i)}
            >
              <span className="file-row-path">
                {highlightRuns(f.path, f.match ?? []).map((r, k) => (r.hit ? <mark key={k}>{r.text}</mark> : <span key={k}>{r.text}</span>))}
              </span>
              <span className="file-row-meta">{f.size === null ? "" : formatBytes(f.size)}</span>
              <span className="file-row-meta when">{f.modifiedAt ? formatWhen(f.modifiedAt) : ""}</span>
            </button>
          ))}
          {result && !files.length && <div className="file-picker-empty">{query.trim() ? "没有匹配的文件" : "这个项目里没有文件"}</div>}
          {error && <div className="file-picker-empty error">{error}</div>}
        </div>
        <div className="file-picker-foot">
          <span>{result ? (query.trim() ? `${result.total} 个匹配` : `共 ${result.total} 个文件`) : "正在读取文件列表…"}</span>
          {result?.source === "walk" && <span>{result.partial ? "不是 git 仓库，只扫描了一部分文件" : "不是 git 仓库，按目录扫描（跳过 node_modules 等）"}</span>}
          <span className="spacer" />
          <span>↑↓ 选择 · 回车引用 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
