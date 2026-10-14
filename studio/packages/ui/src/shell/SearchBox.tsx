import { useEffect, useMemo, useRef, useState } from "react";
import type { StateSnapshot } from "@amo-studio/protocol";
import { relativeTime } from "../lib/status.js";
import { markParts, searchAll, searchTokens, type SearchHit } from "./search.js";

/**
 * 搜索 (stage 14), left of "+ 新任务": finds a task or a session by name, project or topic and opens it. Ctrl K from
 * anywhere puts the cursor here; ↑ ↓ choose, Enter opens, Esc clears and leaves.
 */
export function SearchBox({ state, onOpen, disabled = false }: { state: StateSnapshot | null; onOpen(hit: SearchHit): void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => (state && open ? searchAll(state, query) : []), [state, open, query]);
  const tokens = searchTokens(query);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A click elsewhere closes the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpen(hit);
    setOpen(false);
    setQuery("");
    input.current?.blur();
  };

  return (
    <div className="search-box" ref={box}>
      <svg className="search-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </svg>
      <input
        ref={input}
        className="search-input"
        type="search"
        value={query}
        disabled={disabled}
        placeholder="搜索任务或会话"
        aria-label="搜索任务或会话"
        title="搜索任务或会话（Ctrl K）"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls="search-results"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            pick(hits[active]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (query) setQuery("");
            else {
              setOpen(false);
              input.current?.blur();
            }
          }
        }}
        data-testid="search-input"
      />
      <kbd className="search-kbd" aria-hidden="true">
        Ctrl K
      </kbd>
      {open && state && (
        <div className="search-pop" id="search-results" role="listbox" aria-label="搜索结果" data-testid="search-results">
          {!tokens.length && hits.length > 0 && <div className="search-heading">最近</div>}
          {hits.map((hit, i) => (
            <button
              key={`${hit.kind}:${hit.id}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={hit.archived ? "search-row is-archived" : "search-row"}
              data-index={i}
              data-kind={hit.kind}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(hit)}
              data-testid="search-row"
            >
              <span className="search-kind">{hit.kind === "task" ? "任务" : "会话"}</span>
              <span className="search-main">
                <span className="search-title">
                  {markParts(hit.title, tokens).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                </span>
                <span className="search-where">
                  {[hit.kind === "session" ? hit.owner : "", hit.where].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="search-side">{hit.archived ? "已归档" : relativeTime(hit.updatedAt)}</span>
            </button>
          ))}
          {tokens.length > 0 && hits.length === 0 && <div className="search-empty">没有找到「{query.trim()}」</div>}
          {!tokens.length && hits.length === 0 && <div className="search-empty">还没有任务</div>}
        </div>
      )}
    </div>
  );
}
