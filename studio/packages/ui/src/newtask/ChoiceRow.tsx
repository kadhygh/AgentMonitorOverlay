import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { filterChoices, GROUP_HEADINGS, rowChoices, type Choice } from "./choices.js";

/**
 * A row of the new-task page (专题 or 项目, 2026-10-29): 「不选」, at most six chips, then 「更多… N」 opening the search
 * picker. Typing a letter while a chip has the focus opens the picker with it.
 */
export function ChoiceRow({
  label,
  noun,
  noneLabel = "不选",
  choices,
  selected,
  onPick,
  children,
}: {
  /** The row's name ("专题"). */
  label: string;
  /** What is picked, for the picker ("项目"). */
  noun: string;
  noneLabel?: string;
  choices: readonly Choice[];
  selected: string | null;
  onPick(id: string | null): void;
  /** After 「更多…」 (+ 添加项目). */
  children?: ReactNode;
}) {
  const [picker, setPicker] = useState<{ query: string } | null>(null);
  const { shown, more } = rowChoices(choices, selected);
  return (
    <div
      className="pick-row"
      role="group"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey && e.target instanceof HTMLButtonElement) {
          e.preventDefault();
          setPicker({ query: e.key });
        }
      }}
    >
      <span className="pick-lab">{label}</span>
      <button type="button" className="chip none" aria-pressed={selected === null} onClick={() => onPick(null)}>
        {noneLabel}
      </button>
      {shown.map((c) => (
        <button key={c.id} type="button" className="chip" aria-pressed={selected === c.id} title={c.hint} onClick={() => onPick(c.id)}>
          {c.name}
          {c.group === "topic" && <span className="chip-tag">{GROUP_HEADINGS.topic}</span>}
        </button>
      ))}
      {more > 0 && (
        <button type="button" className="chip more" onClick={() => setPicker({ query: "" })} title={`在全部${noun}里搜索`} data-testid={`more-${noun}`}>
          更多… <span className="chip-count">{more}</span>
        </button>
      )}
      {children}
      {picker && (
        <ChoicePicker
          noun={noun}
          choices={choices}
          selected={selected}
          initialQuery={picker.query}
          onPick={(id) => {
            setPicker(null);
            onPick(id);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** A long folder cut at its start: the end tells projects apart, the start is the same for all of them. */
function tail(hint: string, max = 56): string {
  return hint.length > max && /[\\/]/.test(hint) ? `…${hint.slice(-(max - 1))}` : hint;
}

/**
 * 「更多…」 (2026-10-29): like the top bar's search and 找文件 — type to filter, grouped (专题常用 / 置顶 / 最近 / 全部),
 * ↑↓ to move, Enter picks, Esc closes. `noneLabel`: 「不选」 is offered first (the quick bar has no row for it).
 */
export function ChoicePicker({
  noun,
  choices,
  selected,
  initialQuery = "",
  noneLabel,
  onPick,
  onClose,
}: {
  noun: string;
  choices: readonly Choice[];
  selected: string | null;
  initialQuery?: string;
  noneLabel?: string;
  onPick(id: string | null): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const list = useRef<HTMLDivElement>(null);
  const none: Choice | null = noneLabel && !query.trim() ? { id: "", name: noneLabel, hint: "", group: "all" } : null;
  const found = filterChoices(choices, query);
  const rows = none ? [none, ...found] : found;
  const [highlight, setHighlight] = useState(() => Math.max(0, rows.findIndex((c) => c.id === (selected ?? ""))));
  const hl = Math.min(highlight, Math.max(rows.length - 1, 0));
  // Typing starts again from the best match (opening starts on the current one).
  const typed = useRef(query);
  useEffect(() => {
    if (typed.current !== query) setHighlight(0);
    typed.current = query;
  }, [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${hl}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hl]);
  const pick = (i: number) => {
    const c = rows[i];
    if (c) onPick(c.id || null);
  };

  return createPortal(
    <div className="file-picker-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="file-picker choice-picker" role="dialog" aria-label={`选${noun}`} data-testid="choice-picker">
        <input
          className="file-picker-input"
          autoFocus
          value={query}
          placeholder={`搜索${noun}…`}
          aria-label={`搜索${noun}`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (rows.length) setHighlight((hl + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              pick(hl);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="file-picker-list" role="listbox" aria-label={noun} ref={list}>
          {rows.map((c, i) => (
            <Fragment key={c.id || "none"}>
              {c !== none && (i === 0 || rows[i - 1] === none || rows[i - 1]!.group !== c.group) && <div className="choice-picker-h">{GROUP_HEADINGS[c.group]}</div>}
              <button
                type="button"
                role="option"
                data-index={i}
                aria-selected={i === hl}
                className={[i === hl ? "hl" : "", (c.id || null) === selected ? "current" : ""].filter(Boolean).join(" ") || undefined}
                onMouseMove={() => setHighlight(i)}
                onClick={() => pick(i)}
              >
                <span className="choice-name">{c.name}</span>
                {(c.id || null) === selected && <span className="choice-current">✓ 当前</span>}
                <span className="choice-hint" title={c.hint}>
                  {tail(c.hint)}
                </span>
              </button>
            </Fragment>
          ))}
          {!rows.length && <div className="file-picker-empty">没有匹配的{noun}</div>}
        </div>
        <div className="file-picker-foot">
          <span>{query.trim() ? `${found.length} 个匹配` : `共 ${choices.length} 个${noun}`}</span>
          <span className="spacer" />
          <span>↑↓ 选择 · 回车确定 · Esc 关闭</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
