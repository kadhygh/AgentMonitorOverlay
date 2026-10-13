import { useMemo, useState, type KeyboardEvent } from "react";
import type { Topic, Workspace } from "@amo-studio/protocol";
import { mentionAt, withoutMention } from "./draft.js";

// Typing @ picks a project, # a topic, right in the text field (design/ui-directions/new-task.html).

interface Item {
  kind: "project" | "topic";
  id: string;
  name: string;
  hint: string;
}

export function useMentions({
  text,
  setText,
  projects,
  topics,
  onPick,
}: {
  text: string;
  setText(next: string): void;
  projects: readonly Workspace[];
  topics: readonly Topic[];
  onPick(kind: "project" | "topic", id: string): void;
}) {
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const mention = caret === null ? null : mentionAt(text, caret);
  const items = useMemo<Item[]>(() => {
    if (!mention || dismissedAt === mention.start) return [];
    const q = mention.query.toLowerCase();
    const list: Item[] =
      mention.sign === "@"
        ? projects.map((w) => ({ kind: "project", id: w.id, name: w.name, hint: w.path }))
        : topics.map((t) => ({ kind: "topic", id: t.id, name: t.title, hint: "专题" }));
    return list.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, dismissedAt, projects, topics]);

  const choose = (item: Item) => {
    if (!mention) return;
    setText(withoutMention(text, mention));
    setCaret(mention.start);
    onPick(item.kind, item.id);
  };

  return {
    open: items.length > 0,
    items,
    highlight: Math.min(highlight, Math.max(items.length - 1, 0)),
    sign: mention?.sign ?? "@",
    choose,
    /** Keep the caret known (typing, clicking, arrow keys). */
    track: (el: HTMLTextAreaElement | HTMLInputElement) => setCaret(el.selectionStart),
    /** Handles the list's keys; true when the key was used. */
    onKeyDown(e: KeyboardEvent): boolean {
      if (!items.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
        return true;
      }
      if ((e.key === "Enter" && !e.ctrlKey && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        choose(items[Math.min(highlight, items.length - 1)]!);
        setHighlight(0);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedAt(mention?.start ?? null);
        return true;
      }
      return false;
    },
  };
}

export function SuggestList({ mentions, inline = false }: { mentions: ReturnType<typeof useMentions>; inline?: boolean }) {
  if (!mentions.open) return null;
  return (
    <div className={inline ? "suggest inline" : "suggest"} role="listbox" aria-label={mentions.sign === "@" ? "选项目" : "选专题"} data-testid="suggest">
      <div className="suggest-h">{mentions.sign === "@" ? "项目" : "专题"}</div>
      {mentions.items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === mentions.highlight}
          className={i === mentions.highlight ? "hl" : undefined}
          // mousedown keeps the focus (and caret) in the text field.
          onMouseDown={(e) => {
            e.preventDefault();
            mentions.choose(item);
          }}
        >
          <span className="suggest-name">{item.name}</span>
          <span className="suggest-hint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}
