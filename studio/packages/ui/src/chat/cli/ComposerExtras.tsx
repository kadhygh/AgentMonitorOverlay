import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BackgroundOutput, SessionItem } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../../host/client.js";
import { formatDuration } from "../turns.js";
import { IconChevronDown, IconChevronRight, IconTerminal, IconX } from "../icons.js";

// Above the composer (stage 12, S12-E): the commands the agent left running in the background, and the next message
// Claude suggests after a reply.

type BackgroundItem = Extract<SessionItem, { type: "background" }>;

/** How long a finished command stays listed (until dismissed). */
const KEEP_FINISHED_MS = 10 * 60_000;
const STATE_LABEL: Record<BackgroundItem["state"], string> = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止" };

/** Background commands to list: running ones, and ones that ended a little while ago. */
export function backgroundToShow(items: readonly SessionItem[], now: number, dismissed: ReadonlySet<string>): BackgroundItem[] {
  return items.filter(
    (i): i is BackgroundItem =>
      i.type === "background" && !dismissed.has(i.id) && (i.state === "running" || (!!i.endedAt && now - Date.parse(i.endedAt) < KEEP_FINISHED_MS)),
  );
}

export function BackgroundTasks({ link, sessionId, items, readOnly, onError }: { link: HostLink; sessionId: string; items: readonly SessionItem[]; readOnly: boolean; onError(text: string): void }) {
  const [now, setNow] = useState(Date.now);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setDismissed(new Set()), [sessionId]);
  const list = useMemo(() => backgroundToShow(items, now, dismissed), [items, now, dismissed]);
  const running = list.some((b) => b.state === "running");
  useEffect(() => {
    if (!list.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [list.length]);
  const [folded, setFolded] = useState(readFolded);
  if (!list.length) return null;
  const runningCount = list.filter((b) => b.state === "running").length;
  const endedCount = list.length - runningCount;
  const toggle = () =>
    setFolded((v) => {
      try {
        localStorage.setItem(FOLD_KEY, v ? "0" : "1");
      } catch {
        // per-viewer convenience only
      }
      return !v;
    });
  return (
    <div className={`bg-tasks${folded ? " folded" : ""}`} data-testid="background-tasks" aria-label="后台运行">
      <button type="button" className="bg-tasks-head" aria-expanded={!folded} title={folded ? "展开后台运行" : "折叠后台运行"} onClick={toggle} data-testid="background-tasks-toggle">
        <span className="bg-tasks-chevron" aria-hidden="true">{folded ? <IconChevronRight /> : <IconChevronDown />}</span>
        <IconTerminal />
        <span>后台运行</span>
        {running && !folded && <span className="bg-tasks-count">{runningCount}</span>}
        {folded && (
          <span className="bg-tasks-summary">
            {[runningCount ? `${runningCount} 个在跑` : "", endedCount ? `${endedCount} 个已结束` : ""].filter(Boolean).join(" · ")}
          </span>
        )}
      </button>
      {!folded && (
        <div className="bg-tasks-list">
          {list.map((b) => (
            <BackgroundRow
              key={b.id}
              link={link}
              sessionId={sessionId}
              item={b}
              now={now}
              readOnly={readOnly}
              onError={onError}
              onDismiss={() => setDismissed((cur) => new Set(cur).add(b.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 2026-11-02 问题 #12: with many background commands the list covered the conversation; it folds to one line now,
// remembered for every session (the person folds it because it is in the way, not for one session).
const FOLD_KEY = "amo.backgroundTasksFolded";
function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

function BackgroundRow({
  link,
  sessionId,
  item,
  now,
  readOnly,
  onError,
  onDismiss,
}: {
  link: HostLink;
  sessionId: string;
  item: BackgroundItem;
  now: number;
  readOnly: boolean;
  onError(text: string): void;
  onDismiss(): void;
}) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const running = item.state === "running";
  const ended = item.endedAt ? Date.parse(item.endedAt) : now;
  const elapsed = formatDuration(Math.max(1000, ended - Date.parse(item.startedAt)));
  async function stop() {
    setStopping(true);
    try {
      await call(link, "POST /api/sessions/:id/background/:taskId/stop", { id: sessionId, taskId: item.taskId });
    } catch (err) {
      onError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }
  return (
    <div className="bg-task" data-testid="background-task" data-state={item.state}>
      <div className="bg-task-row">
        <span className={`bg-dot ${item.state}`} aria-hidden="true" />
        <code className="bg-task-cmd" title={item.command}>
          {item.command}
        </code>
        <span className="bg-task-meta">
          {running ? elapsed : `${STATE_LABEL[item.state]} · ${elapsed}`}
        </span>
        <button type="button" className="link-btn small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "收起输出" : "输出"}
        </button>
        {running && !readOnly && (
          <button type="button" className="link-btn small danger" disabled={stopping} onClick={() => void stop()}>
            {stopping ? "停止中…" : "停止"}
          </button>
        )}
        {!running && (
          <button type="button" className="icon-btn small" aria-label="不再显示" title="不再显示" onClick={onDismiss}>
            <IconX />
          </button>
        )}
      </div>
      {item.summary && !running && <div className="bg-task-summary">{item.summary}</div>}
      {open && <BackgroundOutputView link={link} sessionId={sessionId} taskId={item.taskId} running={running} />}
    </div>
  );
}

/** The tail of the command's output, read again every two seconds while it runs. */
function BackgroundOutputView({ link, sessionId, taskId, running }: { link: HostLink; sessionId: string; taskId: string; running: boolean }) {
  const [out, setOut] = useState<BackgroundOutput | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      call(link, "GET /api/sessions/:id/background/:taskId/output", { id: sessionId, taskId })
        .then((r) => live && setOut(r))
        .catch(() => live && setOut({ text: "", truncated: false, missing: true }));
    void read();
    const t = running ? setInterval(() => void read(), 2000) : null;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [link, sessionId, taskId, running]);
  useLayoutEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [out?.text]);
  if (!out) return <div className="bg-task-out empty">读取中…</div>;
  if (out.missing || !out.text.trim()) return <div className="bg-task-out empty">（还没有输出）</div>;
  return (
    <pre className="bg-task-out" ref={pre} data-testid="background-output">
      {out.truncated ? "…\n" : ""}
      {out.text.replace(/\r\n/g, "\n").replace(/\n$/, "")}
    </pre>
  );
}

/** The suggestion after the latest reply, while nothing has come after it. */
export function latestSuggestion(items: readonly SessionItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === "turn" || it.type === "background") continue;
    return it.type === "suggestion" ? it.text : null;
  }
  return null;
}

export function SuggestionChips({ text, onPick }: { text: string; onPick(text: string): void }) {
  return (
    <div className="suggestions" data-testid="suggestions" aria-label="建议的下一句">
      <span className="suggestions-label">建议</span>
      <button type="button" className="suggestion-chip" title="填进输入框（可以先改再发）" onClick={() => onPick(text)}>
        {text}
      </button>
    </div>
  );
}
