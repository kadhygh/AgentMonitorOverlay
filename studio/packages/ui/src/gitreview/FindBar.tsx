import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { findMatches, firstFrom, matchLabel, stepMatch, type FindMatch } from "./find.js";

// Ctrl+F (S14-A) in the viewer and the Review window: a bar over the view; Enter / Shift+Enter for the next and the
// previous match, Esc closes. Matches come from the rows' text (`texts`), so lines in chunks not drawn yet are found
// too; or, without `texts` (rendered Markdown), from the text on the page. They are painted with the CSS Custom
// Highlight API (`::highlight(amo-find)`), so the page itself is not changed.

const ALL = "amo-find";
const CURRENT = "amo-find-current";

export interface FindBarProps {
  /** Only the view in front listens to Ctrl+F (a hidden one keeps its bar closed). */
  active: boolean;
  /** The scrolling view the text is in. */
  container: RefObject<HTMLElement | null>;
  /** Each row's text; without it the text on the page is searched. */
  texts?: readonly string[];
  /** The elements holding a row's text (both sides of an unchanged line, side by side). */
  rowSelector?(row: number): string;
  /** The row the view is at, where the search starts. */
  fromRow?(): number;
  /** A match was made current (the view may mark its line). */
  onCurrent?(row: number): void;
}

const supported = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

function clearHighlights() {
  if (!supported()) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}

/** The text nodes under `el`, in order, with where each starts in the element's text. */
function textNodes(el: Node): { node: Text; at: number }[] {
  const out: { node: Text; at: number }[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    out.push({ node: n as Text, at });
    at += (n as Text).data.length;
  }
  return out;
}

/** A range over [start, end) of the element's text, or null when the element's text is shorter. */
function rangeIn(nodes: readonly { node: Text; at: number }[], start: number, end: number): Range | null {
  const s = nodes.find((n) => n.at <= start && start < n.at + n.node.data.length);
  const e = nodes.find((n) => n.at < end && end <= n.at + n.node.data.length);
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s.node, start - s.at);
  r.setEnd(e.node, end - e.at);
  return r;
}

export function FindBar({ active, container, texts, rowSelector, fromRow, onCurrent }: FindBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(-1);
  // Rendered text (no `texts`): the page's text nodes, read when the search changes.
  const [pageNodes, setPageNodes] = useState<Text[]>([]);
  const [redraws, setRedraws] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  // Ctrl+F opens the bar (with the selected text, when it is one line) and selects what it holds.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      const picked = window.getSelection()?.toString() ?? "";
      if (picked && !picked.includes("\n") && picked.length <= 200) setQuery(picked);
      setOpen(true);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  useEffect(() => {
    if (!open || texts) return;
    const el = container.current;
    setPageNodes(el ? textNodes(el).map((n) => n.node) : []);
  }, [open, texts, query, container, redraws]);

  const searched = useMemo(() => texts ?? pageNodes.map((n) => n.data), [texts, pageNodes]);
  const matches = useMemo(() => (open ? findMatches(searched, query, caseSensitive) : []), [open, searched, query, caseSensitive]);

  // A new search starts at the row in view; the same search over redrawn rows keeps its place.
  const lastSearch = useRef("");
  useEffect(() => {
    const key = `${query}\u0000${caseSensitive}`;
    if (key !== lastSearch.current) {
      lastSearch.current = key;
      setCurrent(firstFrom(matches, fromRow?.() ?? 0));
    } else setCurrent((c) => (matches.length ? Math.min(Math.max(c, 0), matches.length - 1) : -1));
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rows redraw (colours arrive, another layout): the painted ranges point at text that is gone, so paint again.
  useEffect(() => {
    const el = container.current;
    if (!open || !el) return;
    let frame = 0;
    const later = () => (frame ||= requestAnimationFrame(() => ((frame = 0), setRedraws((n) => n + 1))));
    const watch = new MutationObserver(later);
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, container]);

  const rangesOf = (m: FindMatch): Range[] => {
    const el = container.current;
    if (!el) return [];
    if (!texts) {
      const node = pageNodes[m.row];
      if (!node?.isConnected) return [];
      const r = document.createRange();
      r.setStart(node, m.start);
      r.setEnd(node, m.end);
      return [r];
    }
    if (!rowSelector) return [];
    return [...el.querySelectorAll(rowSelector(m.row))].flatMap((cell) => rangeIn(textNodes(cell), m.start, m.end) ?? []);
  };

  // Paint every match, and the current one on top.
  useLayoutEffect(() => {
    if (!open || !supported()) return;
    const all = matches.flatMap(rangesOf);
    CSS.highlights.set(ALL, new Highlight(...all));
    const cur = matches[current];
    if (cur) CSS.highlights.set(CURRENT, new Highlight(...rangesOf(cur)));
    else CSS.highlights.delete(CURRENT);
    return clearHighlights;
  }, [open, matches, current, redraws]); // eslint-disable-line react-hooks/exhaustive-deps

  // The current match scrolls into view: its row first (it may sit in a chunk not drawn yet), then the text itself.
  useEffect(() => {
    const el = container.current;
    const m = matches[current];
    if (!open || !el || !m) return;
    onCurrent?.(m.row);
    const target = texts ? (rowSelector ? el.querySelector<HTMLElement>(rowSelector(m.row)) : null) : pageNodes[m.row]?.parentElement;
    if (!target) return;
    target.scrollIntoView({ block: "nearest" });
    const r = rangesOf(m)[0];
    if (!r) return;
    const box = r.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    if (box.top < view.top + 24 || box.bottom > view.bottom - 24) el.scrollTop += box.top - (view.top + view.height / 3);
    if (box.left < view.left + 60 || box.right > view.right - 24) el.scrollLeft += box.left - (view.left + view.width / 3);
    // Not on redraws (the matches are worked out again then): only when the search or the current match changes.
  }, [current, query, caseSensitive, open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const go = (dir: 1 | -1) => setCurrent((c) => stepMatch(matches.length, c, dir));
  const close = () => {
    setOpen(false);
    clearHighlights();
  };
  return (
    <div className="find-bar" role="search" data-testid="find-bar">
      <input
        ref={input}
        className="field"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
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
        {query ? matchLabel(matches.length, current) : ""}
      </span>
      <button type="button" className="icon-btn" aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCaseSensitive((v) => !v)} data-testid="find-case">
        Aa
      </button>
      <button type="button" className="icon-btn" title="上一个（Shift+Enter）" aria-label="上一个" disabled={!matches.length} onClick={() => go(-1)}>
        ↑
      </button>
      <button type="button" className="icon-btn" title="下一个（Enter）" aria-label="下一个" disabled={!matches.length} onClick={() => go(1)} data-testid="find-next">
        ↓
      </button>
      <button type="button" className="icon-btn" title="关闭（Esc）" aria-label="关闭查找" onClick={close}>
        ×
      </button>
    </div>
  );
}
