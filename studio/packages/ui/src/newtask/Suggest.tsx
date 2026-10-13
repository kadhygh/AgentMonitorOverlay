import { useMemo, useState, type KeyboardEvent } from "react";
import type { Task, Topic, Workspace } from "@amo-studio/protocol";
import { mentionAt, withoutMention } from "./draft.js";
import { pinnedFirst, usePins } from "../lib/pins.js";

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
  const pins = usePins();
  const mention = caret === null ? null : mentionAt(text, caret);
  const items = useMemo<Item[]>(() => {
    if (!mention || dismissedAt === mention.start) return [];
    const q = mention.query.toLowerCase();
    const list: Item[] =
      mention.sign === "@"
        ? pinnedFirst(projects, pins.project, (w) => w.id).map((w) => ({ kind: "project", id: w.id, name: w.name, hint: pins.has("project", w.id) ? "已置顶" : w.path }))
        : pinnedFirst(topics, pins.topic, (t) => t.id).map((t) => ({ kind: "topic", id: t.id, name: t.title, hint: pins.has("topic", t.id) ? "已置顶" : "专题" }));
    return list.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, dismissedAt, projects, topics, pins]);

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
    heading: mention?.sign === "#" ? "专题" : "项目",
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

interface SuggestState {
  open: boolean;
  items: ReadonlyArray<{ id: string; name: string; hint: string }>;
  highlight: number;
  /** The list's heading, e.g. "项目". */
  heading: string;
  choose(item: never): void;
}

export function SuggestList({ mentions, inline = false }: { mentions: SuggestState; inline?: boolean }) {
  if (!mentions.open) return null;
  return (
    <div className={inline ? "suggest inline" : "suggest"} role="listbox" aria-label={`选${mentions.heading}`} data-testid="suggest">
      <div className="suggest-h">{mentions.heading}</div>
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
            mentions.choose(item as never);
          }}
        >
          <span className="suggest-name">{item.name}</span>
          <span className="suggest-hint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * @ in a session's composer: pick a task; the text keeps "@任务名", and the message sent says which AMO task that is,
 * so the agent can look it up (task_get).
 */
export function useTaskMentions({ text, setText, tasks }: { text: string; setText(next: string): void; tasks: readonly Task[] }) {
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<ReadonlyMap<string, Task>>(new Map());
  const pins = usePins();
  const mention = caret === null ? null : mentionAt(text, caret);
  const items = useMemo(() => {
    if (!mention || mention.sign !== "@") return [];
    const q = mention.query.toLowerCase();
    // Tasks of pinned topics and projects come first.
    const pinnedTask = (t: Task) => (t.topicId && pins.has("topic", t.topicId)) || pins.has("project", t.workspaceId);
    return [...tasks]
      .sort((a, b) => Number(pinnedTask(b)) - Number(pinnedTask(a)))
      .filter((t) => !t.archivedAt && (t.title || "未命名任务").toLowerCase().includes(q))
      .slice(0, 8)
      .map((t) => ({ id: t.id, name: t.title || "未命名任务", hint: t.column === "done" ? "完成" : "" }));
  }, [mention, tasks, pins]);

  const choose = (item: { id: string; name: string }) => {
    if (!mention) return;
    const task = tasks.find((t) => t.id === item.id);
    if (!task) return;
    const inserted = `@${item.name} `;
    setText(text.slice(0, mention.start) + inserted + text.slice(mention.end));
    setCaret(mention.start + inserted.length);
    setPicked((cur) => new Map(cur).set(item.name, task));
    setHighlight(0);
  };

  return {
    open: items.length > 0,
    items,
    highlight: Math.min(highlight, Math.max(items.length - 1, 0)),
    heading: "任务",
    choose,
    track: (el: HTMLTextAreaElement) => setCaret(el.selectionStart),
    onKeyDown(e: KeyboardEvent): boolean {
      if (!items.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        choose(items[Math.min(highlight, items.length - 1)]!);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCaret(null);
        return true;
      }
      return false;
    },
    /** The message as sent: the text, then which AMO tasks its @ names are. Forgets the picks. */
    expand(message: string): string {
      const refs = [...picked.entries()].filter(([name]) => message.includes(`@${name}`));
      setPicked(new Map());
      if (!refs.length) return message;
      const lines = refs.map(([name, t]) => `- @${name}：AMO 任务 ${t.id}（可以用 AMO 的 task_get 查看）`);
      return `${message}\n\n提到的任务：\n${lines.join("\n")}`;
    },
  };
}
