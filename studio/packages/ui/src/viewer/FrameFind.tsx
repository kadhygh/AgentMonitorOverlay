import { useEffect, useRef, useState, type RefObject } from "react";
import { matchLabel } from "../gitreview/find.js";
import type { FrameMessage, ToFrame } from "./passages.js";

// Ctrl+F on a rendered HTML page (2026-11-06; the user: 查看渲染时，无法用 ctrl+f 搜索具体的文字). The page is in a
// sandboxed frame this window cannot read, so this is FindBar's bar (same look, same keys) with the search done by the
// frame's script (passages.ts): the bar sends what to find and which way to step, the frame paints the matches,
// scrolls to the current one and says how many there are. Ctrl+F opens it from the window or from inside the page.

export function FrameFind({ active, frame }: { active: boolean; frame: RefObject<HTMLIFrameElement | null> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ count: number; current: number }>({ count: 0, current: -1 });
  const input = useRef<HTMLInputElement>(null);
  // Each Ctrl+F puts the focus in the box (after the render; not by a frame callback, which a covered window skips).
  const [asked, setAsked] = useState(0);
  const toFrame = (m: ToFrame) => frame.current?.contentWindow?.postMessage({ amoPassage: m }, "*");
  const latest = useRef({ open, query, caseSensitive, toFrame });
  latest.current = { open, query, caseSensitive, toFrame };

  const show = (text: string) => {
    if (text) setQuery(text);
    setOpen(true);
    setAsked((n) => n + 1);
  };

  useEffect(() => {
    if (!open || !asked) return;
    input.current?.focus();
    input.current?.select();
  }, [open, asked]);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  // Ctrl+F with the focus outside the page (the window's buttons, the comments).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      const picked = window.getSelection()?.toString() ?? "";
      show(picked && !picked.includes("\n") && picked.length <= 200 ? picked : "");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // From the frame: Ctrl+F pressed in the page, what a search found, and a reloaded page (searched again).
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = (e.data as { amoPassage?: FrameMessage } | null)?.amoPassage;
      if (!m) return;
      if (m.type === "find-open") show(m.text);
      else if (m.type === "found") setResult({ count: m.count, current: m.current });
      else if (m.type === "ready" && latest.current.open && latest.current.query) latest.current.toFrame({ type: "find", query: latest.current.query, caseSensitive: latest.current.caseSensitive, step: 0 });
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [frame]);

  // A new search (or case) starts from what is in view.
  useEffect(() => {
    if (!open) return;
    if (query) toFrame({ type: "find", query, caseSensitive, step: 0 });
    else {
      toFrame({ type: "find-clear" });
      setResult({ count: 0, current: -1 });
    }
  }, [open, query, caseSensitive]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const go = (step: 1 | -1) => query && toFrame({ type: "find", query, caseSensitive, step });
  const close = () => {
    setOpen(false);
    toFrame({ type: "find-clear" });
    setResult({ count: 0, current: -1 });
  };
  return (
    <div className="find-bar" role="search" data-testid="find-bar">
      <input
        ref={input}
        className="field"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        placeholder="查找"
        aria-label="查找"
        data-testid="find-input"
      />
      <span className="find-count" data-testid="find-count">
        {query ? matchLabel(result.count, result.current) : ""}
      </span>
      <button type="button" className="icon-btn" aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCaseSensitive((v) => !v)} data-testid="find-case">
        Aa
      </button>
      <button type="button" className="icon-btn" title="上一个（Shift+Enter）" aria-label="上一个" disabled={!result.count} onClick={() => go(-1)}>
        ↑
      </button>
      <button type="button" className="icon-btn" title="下一个（Enter）" aria-label="下一个" disabled={!result.count} onClick={() => go(1)} data-testid="find-next">
        ↓
      </button>
      <button type="button" className="icon-btn" title="关闭（Esc）" aria-label="关闭查找" onClick={close}>
        ×
      </button>
    </div>
  );
}
