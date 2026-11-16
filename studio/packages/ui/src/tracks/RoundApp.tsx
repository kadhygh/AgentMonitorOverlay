import { useEffect, useRef, useState } from "react";
import type { Session, StateSnapshot, Task } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { useSettings } from "../settings/useSettings.js";
import { useOpenDecisions } from "../collab/DecisionPanel.js";
import { copyStatus, useRemote } from "../remote/remote.js";
import { showToast } from "../lib/toast.js";
import { openViewer } from "../viewer/open.js";
import { WindowPlaceholder } from "../shell/WindowControls.js";
import { IconX } from "../chat/icons.js";
import { SessionThread, sessionRuntime, useSessionData } from "../task/SessionThread.js";
import { ForkDialog } from "../task/ForkDialog.js";
import { revealRow } from "../task/revealRow.js";
import type { PreviewTarget } from "../files/FileLinks.js";
import { parseRoundHash, type RoundAsk } from "./rounds.js";

// 会话弹窗 as a window of its own (2026-11-16, the user: 脉络点击的弹窗要独立弹窗，不然会被限制拖动范围; plans/tracks.md): the
// conversation of a card picked in 脉络's building, loaded with #round?task=…&session=…&tower=…&item=…, scrolled to that
// round, with its composer — the task page's own SessionThread, so sending, approving, answering, annotating and Ctrl+F
// are the same here. The head drags the window and has 固定 (the next card opens another window; this one stays),
// 到对话里看 (the workbench shows the conversation there, at the row read here) and ×; Esc closes it while not pinned.
// The window is reused for the next card (the shell sets a new address): the session may change with it.

export function RoundApp() {
  const host = useHostState();
  const [ask, setAsk] = useState<RoundAsk | null>(() => parseRoundHash(location.hash));
  useEffect(() => {
    const onHash = () => setAsk(parseRoundHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (host.kind !== "ready") return <WindowPlaceholder title="会话弹窗">{host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}</WindowPlaceholder>;
  if (!ask) return <WindowPlaceholder title="会话弹窗">没有指定会话。</WindowPlaceholder>;
  const task = host.state.tasks.find((t) => t.id === ask.taskId);
  const session = host.state.sessions.find((s) => s.id === ask.sessionId && s.taskId === ask.taskId);
  if (!task || !session) return <WindowPlaceholder title="会话弹窗">这个会话不在了（任务或会话被删掉了）。</WindowPlaceholder>;
  return <RoundWindow key={session.id} link={host.link} state={host.state} ask={ask} task={task} session={session} />;
}

/** The row read at the top of the conversation (else the card's), for 到对话里看. */
function readingRow(fallback: string | null): string | null {
  const scroller = document.querySelector<HTMLElement>(".thread");
  const top = scroller?.getBoundingClientRect().top ?? 0;
  const rows = scroller ? [...scroller.querySelectorAll<HTMLElement>("[data-row-id], [data-item-id]")] : [];
  const reading = rows.find((r) => r.getBoundingClientRect().bottom > top + 8);
  return reading?.dataset.rowId ?? reading?.dataset.itemId ?? fallback;
}

/** 在侧栏预览 has no side here: the viewer shows the file (its changes, when the link was to a diff). */
function previewInViewer(t: PreviewTarget, workspaceId: string, sessionId: string): void {
  const ws = t.file.workspaceId ?? workspaceId;
  openViewer({ path: t.file.path, workspaceId: ws, sessionId, ...(t.line ? { line: t.line, ...(t.endLine ? { endLine: t.endLine } : {}) } : {}), ...(t.diff ? { mode: "changes" as const } : {}) });
}

function RoundWindow({ link, state, ask, task, session }: { link: HostLink; state: StateSnapshot; ask: RoundAsk; task: Task; session: Session }) {
  const settings = useSettings(link);
  const remote = useRemote(link);
  const copy = copyStatus(task, remote);
  const decisions = useOpenDecisions(link);
  const data = useSessionData(link, session.id);
  const [busy, setBusy] = useState(false);
  const showError = (text: string) => showToast({ text, error: true });
  async function run<T>(fn: () => Promise<T>): Promise<void> {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const [forking, setForking] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    void window.amo?.round?.state().then((s) => setPinned(s.pinned));
  }, []);

  // A session the building's started says which one it is; the card's own words follow.
  const title = ask.sessionId === ask.towerFor ? session.title || "会话" : `子会话「${session.title || "未命名"}」`;
  useEffect(() => {
    document.title = ask.title ? `${title} · ${ask.title}` : title;
  }, [title, ask.title]);

  // At the card's row once the rows are in, and again each time a card is picked (the address's nonce): the
  // conversation is drawn a moment after the rows arrive (and sticks to its end until then).
  const shownFor = useRef<string | null>(null);
  const loaded = data.items.length > 0;
  useEffect(() => {
    if (!ask.itemId || !loaded || shownFor.current === ask.nonce) return;
    shownFor.current = ask.nonce;
    const at = ask.itemId;
    const timer = window.setTimeout(() => revealRow(at, 12), 120);
    return () => window.clearTimeout(timer);
  }, [ask.nonce, ask.itemId, loaded]);

  const close = () => window.amo?.windowControls?.close();
  // Esc closes it while not pinned — not while something else takes Esc: a text box being written in, a dialog or menu.
  useEffect(() => {
    if (pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as Element | null;
      if (t?.closest?.("textarea, input, select, [contenteditable], [role='dialog'], [role='menu']") || document.querySelector('[role="dialog"], [role="menu"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned]);

  const forkRuntime = sessionRuntime(task, session);
  return (
    <div className="round-win" data-testid="round-window">
      <div className="round-win-head titlebar" data-testid="round-head">
        <span className="round-win-title" data-testid="round-title">
          <b>{title}</b>
          {ask.title && <span className="round-win-sub">{ask.title}</span>}
        </span>
        <button
          type="button"
          className={`round-win-btn${pinned ? " on" : ""}`}
          aria-pressed={pinned}
          disabled={pinned}
          title={pinned ? "已固定：点楼里别的卡片会另开一个窗口，这个留着；点 × 关掉它" : "固定：这个窗口留着不动，点楼的空白处、按 Esc 都不关；再点楼里的卡片会另开一个窗口"}
          onClick={() => void window.amo?.round?.pin().then(setPinned)}
          data-testid="round-pin"
        >
          {pinned ? "已固定" : "固定"}
        </button>
        <button type="button" className="round-win-btn" title="在工作台里切回对话视图，停在这里看到的地方；这个窗口关掉" onClick={() => void window.amo?.round?.toChat(readingRow(ask.itemId) ?? undefined)} data-testid="round-chat">
          到对话里看
        </button>
        <button type="button" className="round-win-btn icon" aria-label="关闭弹窗" title="关闭" onClick={close} data-testid="round-close">
          <IconX />
        </button>
      </div>
      <div className="round-win-body thread-col">
        <SessionThread
          link={link}
          task={task}
          session={session}
          sessions={state.sessions}
          tasks={state.tasks}
          workspaces={state.workspaces}
          topics={state.topics}
          profiles={state.profiles}
          settings={settings}
          copy={copy}
          data={data}
          decisions={decisions}
          busy={busy}
          run={run}
          onError={showError}
          // Another session of the building (a sub-session's row): shown here, as a card of it would be; elsewhere, the workbench.
          onJump={(id) => {
            const to = state.sessions.find((s) => s.id === id);
            if (to?.taskId === task.id) void window.amo?.round?.open({ taskId: task.id, sessionId: id, towerFor: ask.towerFor });
            else if (to?.taskId) void window.amo?.openInWorkbench?.({ taskId: to.taskId, sessionId: id });
          }}
          onForkTurn={(_sessionId, turnId) => setForking(turnId)}
          onPreview={(t) => previewInViewer(t, session.workspaceId, session.id)}
          shortView
          atPassage={!!ask.itemId}
        />
      </div>
      {forking && (
        <ForkDialog
          link={link}
          session={session}
          profile={state.profiles.find((p) => p.id === session.profileId)}
          turnId={forking}
          {...(copy ? { remote: { name: copy.name, ...(forkRuntime ? { runtime: forkRuntime } : {}), mcp: !!task.remote?.mcp } } : {})}
          onClose={() => setForking(null)}
          // The branch is a session of its own: the workbench opens it (the building goes, and this window with it).
          onForked={(s) => {
            setForking(null);
            void window.amo?.openInWorkbench?.({ taskId: task.id, sessionId: s.id });
          }}
        />
      )}
    </div>
  );
}
