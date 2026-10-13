import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SLASH_GROUP_LABEL, type Session, type SlashCommand } from "@amo-studio/protocol";
import { call, type HostLink } from "../../host/client.js";
import { matchSlash, slashAt, slashGroups } from "./slash.js";

// `/` in a session's composer (stage 12, S12-E): the command menu. The list comes from the Host (Studio's commands,
// then the runtime's and its skills) the first time `/` is typed, and again after a minute.

const STALE_MS = 60_000;

export function useSlashCommands(input: {
  link: HostLink;
  session: Session | null;
  text: string;
  setText(next: string): void;
  /** A command was picked that runs without arguments (or the person pressed Enter on it). */
  onRun(command: SlashCommand, args: string): void;
}) {
  const { link, session, text, setText } = input;
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [list, setList] = useState<{ sessionId: string; at: number; commands: SlashCommand[]; note?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const typing = caret === null ? null : slashAt(text, caret);
  const query = typing && dismissed !== text ? typing.query : null;
  const sessionId = session?.id ?? null;
  const fresh = !!list && list.sessionId === sessionId && Date.now() - list.at < STALE_MS;

  const load = useCallback(async (): Promise<SlashCommand[]> => {
    if (!sessionId) return [];
    setLoading(true);
    try {
      const r = await call(link, "GET /api/sessions/:id/commands", { id: sessionId });
      setList({ sessionId, at: Date.now(), commands: r.commands, ...(r.note ? { note: r.note } : {}) });
      return r.commands;
    } catch {
      // Not again at once: the menu says so, and the next `/` after a minute asks again.
      setList({ sessionId, at: Date.now(), commands: [], note: "读不到命令列表" });
      return [];
    } finally {
      setLoading(false);
    }
  }, [link, sessionId]);

  useEffect(() => {
    if (query !== null && !fresh && !loading) void load();
  }, [query, fresh, loading, load]);
  useEffect(() => {
    setDismissed(null);
    setHighlight(0);
  }, [sessionId]);

  const commands = list?.sessionId === sessionId ? list.commands : [];
  const groups = useMemo(() => (query === null ? [] : slashGroups(commands, query)), [commands, query]);
  const flat = groups.flatMap((g) => g.commands);
  const hl = Math.min(highlight, Math.max(flat.length - 1, 0));
  useEffect(() => setHighlight(0), [query]);

  /** Tab, or Enter on a command that needs arguments ("<…>"): complete the name and let the person type them. */
  const complete = (c: SlashCommand) => {
    const next = `/${c.name} ${typing ? text.slice(typing.end).replace(/^\s+/, "") : ""}`;
    setText(next);
    setCaret(next.length);
  };
  const choose = (c: SlashCommand, how: "enter" | "tab" | "click") => {
    if (how === "tab" || (c.argumentHint?.trim().startsWith("<") && !c.local)) return complete(c);
    setText("");
    setCaret(null);
    input.onRun(c, "");
  };

  return {
    open: query !== null && (flat.length > 0 || loading || (!!list && fresh)),
    loading: loading && !commands.length,
    note: list?.note,
    groups,
    highlight: hl,
    choose,
    track: (el: HTMLTextAreaElement) => setCaret(el.selectionStart),
    /** The command a message runs, from the list as loaded (loading it first if it is not yet). */
    async match(message: string): Promise<{ command: SlashCommand; args: string } | null> {
      if (!message.startsWith("/")) return null;
      const known = fresh ? commands : await load();
      return matchSlash(message, known);
    },
    onKeyDown(e: KeyboardEvent): boolean {
      if (query === null) return false;
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(text);
        return true;
      }
      if (!flat.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (Math.min(h, flat.length - 1) + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
        e.preventDefault();
        choose(flat[hl]!, e.key === "Tab" ? "tab" : "enter");
        return true;
      }
      return false;
    },
  };
}

export type SlashCommands = ReturnType<typeof useSlashCommands>;

/** The menu above the composer: grouped rows of name, what it takes, and what it does. */
export function SlashMenu({ slash }: { slash: SlashCommands }) {
  const box = useRef<HTMLDivElement>(null);
  // Keep the highlighted row in view while moving with the keys.
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [slash.highlight]);
  if (!slash.open) return null;
  let index = 0;
  return (
    <div className="suggest slash-menu" role="listbox" aria-label="命令" data-testid="slash-menu" ref={box}>
      {slash.loading && <div className="slash-empty">正在读取命令…</div>}
      {!slash.loading && !slash.groups.length && <div className="slash-empty">没有匹配的命令{slash.note ? `（${slash.note}）` : ""}</div>}
      {slash.groups.map((g) => (
        <Fragment key={g.group}>
          <div className="suggest-h">{SLASH_GROUP_LABEL[g.group]}</div>
          {g.commands.map((c) => {
            const i = index++;
            return (
              <button
                key={`${g.group}-${c.name}`}
                type="button"
                role="option"
                data-group={g.group}
                aria-selected={i === slash.highlight}
                className={i === slash.highlight ? "hl" : undefined}
                title={c.description}
                // mousedown keeps the focus (and caret) in the text field.
                onMouseDown={(e) => {
                  e.preventDefault();
                  slash.choose(c, "click");
                }}
              >
                <span className="slash-main">
                  <span className="slash-name">/{c.name}</span>
                  {c.argumentHint && <span className="slash-args">{c.argumentHint}</span>}
                </span>
                <span className="slash-desc">{c.description}</span>
              </button>
            );
          })}
        </Fragment>
      ))}
      <div className="slash-keys" aria-hidden="true">
        ↑↓ 选择 · 回车 运行 · Tab 补全 · Esc 关闭
      </div>
    </div>
  );
}
