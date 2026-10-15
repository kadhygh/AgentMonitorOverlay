import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Session, SessionItem, StateSnapshot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { needsPerson, relativeTime, SESSION_LOOK } from "../lib/status.js";
import { planTitle } from "../chat/questions/flow.js";
import { DecisionCard, useOpenDecisions } from "../collab/DecisionPanel.js";
import { usePendingProposals } from "../planning/ProposalsPanel.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { attentionKeys, pruneSeen, readFocusLocked, shouldAlert, writeFocusLocked } from "./attention.js";
import { PixelBot } from "./PixelBot.js";
import { FocusQuota } from "./FocusQuota.js";
import "./focus.css";

// The Focus window: "what needs me right now". Lists sessions waiting for approval or review, newest first; one entry
// opens to show its latest content, approvals can be granted in place, everything else goes back to the workbench.
// S14-J: a right-click menu (移动位置 / 锁定位置 / 收起 / 打开 Studio / 隐藏), and while something new needs the person
// the panel glows and a pixel robot dances above it until they look.

type Approval = Extract<SessionItem, { type: "approval" }>;
const SNIPPET_MAX = 300;

export function needsMe(state: StateSnapshot): Session[] {
  return state.sessions
    .filter((s) => !s.archivedAt && needsPerson(s.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Latest content worth showing: the pending approval, else a pending question (answered in the workbench), else the last agent reply. */
export function latestSnippet(items: readonly SessionItem[]): { text: string; approval: Approval | null } {
  const question = items.find((i): i is Extract<SessionItem, { type: "question" }> => i.type === "question" && i.state === "pending");
  if (question && !items.some((i) => i.type === "approval" && i.state === "pending")) {
    const text =
      question.source === "plan-review"
        ? `计划待审：${planTitle(question.plan ?? "")}`
        : question.source === "mcp-form"
          ? `等你填写：${question.message ?? ""}`
          : (question.questions ?? []).map((q) => q.question).join("\n");
    return { text: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text, approval: null };
  }
  const approval = [...items].reverse().find((i): i is Approval => i.type === "approval" && i.state === "pending") ?? null;
  if (approval) return { text: [approval.summary, approval.detail].filter(Boolean).join("\n"), approval };
  const reply = [...items].reverse().find((i) => i.type === "agent");
  const text = reply && reply.type === "agent" ? reply.markdown.trim() : "";
  return { text: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text, approval: null };
}

/** Placeholder while the Host connects (the decision hook runs before the link exists). */
const NO_LINK = { url: "", token: "" };

export function FocusApp() {
  const host = useHostState();
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [locked, setLocked] = useState(readFocusLocked);
  const [moving, setMoving] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const decisions = useOpenDecisions(host.kind === "ready" ? host.link : NO_LINK);
  const pending = usePendingProposals(host.kind === "ready" ? host.link : NO_LINK);
  const settings = useSettings(host.kind === "ready" ? host.link : NO_LINK);
  // Scheduler proposals belong to the planning feature (设置 → 功能).
  const proposals = settings?.disabledFeatures.includes("planning") ? [] : pending;

  // Clicks pass through the transparent window except over the panel, its menu and the robot. While moving, the
  // whole window takes the mouse: it is never focused, so 完成 is the way out (Escape never reaches it).
  const catchMouse = (on: boolean) => window.amo?.focus?.setIgnoreMouse(!on);
  useEffect(() => () => window.amo?.focus?.setIgnoreMouse(true), []);
  useEffect(() => {
    if (moving) catchMouse(true);
    else catchMouse(pointerOverUi());
  }, [moving]);
  // A right-click on the title row (a window drag area) only reaches the main process, which passes it on.
  useEffect(() => window.amo?.focus?.onContextMenu?.((at) => setMenu(at)), []);

  const live = host.kind === "ready" ? host.state : null;
  const list = live ? needsMe(live) : [];
  const asks = live ? decisions.filter((d) => live.sessions.some((s) => s.id === d.sessionId && !s.archivedAt)) : [];
  const keys = attentionKeys(list, asks.map((d) => d.id), proposals.map((p) => p.id));
  const keysId = keys.join("|");
  // Forget what was handled, so it alerts again if it comes back.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the keys by content
  useEffect(() => setSeen((s) => pruneSeen(s, keys)), [keysId]);
  const alerting = shouldAlert(keys, seen);
  const acknowledge = () => setSeen(new Set(keys));

  const closeMenu = () => {
    setMenu(null);
    // The menu may have been under the pointer; leave click-through as the pointer is now.
    requestAnimationFrame(() => !moving && catchMouse(pointerOverUi()));
  };
  const toggleLock = () => {
    writeFocusLocked(!locked);
    setLocked(!locked);
    if (!locked) setMoving(false);
  };

  if (host.kind !== "ready") {
    return (
      <div className="focus-root">
        <div className="focus-panel" onMouseEnter={() => catchMouse(true)} onMouseLeave={() => catchMouse(false)}>
          <div className="focus-head">
            <span className="focus-name">Focus</span>
            <span className="focus-dim">{host.kind === "connecting" ? "正在连接 Host…" : "未连接 Host"}</span>
          </div>
        </div>
      </div>
    );
  }

  const { state, link } = host;
  const needs = list.length + asks.length + proposals.length;
  const running = state.sessions.filter((s) => !s.archivedAt && s.status === "running").length;
  const openId = open && list.some((s) => s.id === open) ? open : (list[0]?.id ?? null);
  const title = (s: Session) => state.tasks.find((t) => t.id === s.taskId)?.title || "未命名任务";

  /** The robot's click: the first thing that needs the person, in the workbench. */
  const openFirst = () => {
    acknowledge();
    const s = list[0];
    const d = asks[0];
    if (s) void window.amo?.openInWorkbench?.({ ...(s.taskId ? { taskId: s.taskId } : {}), sessionId: s.id });
    else if (d) void window.amo?.openInWorkbench?.({ ...(d.taskId ? { taskId: d.taskId } : {}), sessionId: d.sessionId });
    else void window.amo?.openInWorkbench?.({ taskId: "" });
  };

  const panelClass = ["focus-panel", locked ? "locked" : "", moving ? "moving" : "", alerting ? "alerting" : ""].filter(Boolean).join(" ");
  return (
    <div className="focus-root">
      {alerting && !moving && (
        <div className="focus-bot-slot" onMouseEnter={() => catchMouse(true)} onMouseLeave={() => catchMouse(false)}>
          <PixelBot message={`${needs} 件事等你`} onClick={openFirst} />
        </div>
      )}
      <div
        className={panelClass}
        data-testid="focus-panel"
        data-locked={locked}
        onMouseEnter={() => catchMouse(true)}
        onMouseLeave={() => !moving && !menu && catchMouse(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="focus-head">
          <span className="focus-name">Focus</span>
          <span className={needs ? "focus-needs" : "focus-dim"} data-testid="focus-needs">
            {needs ? `需要你 ${needs}` : "没有待处理"}
          </span>
          <span className="focus-dim">· 运行中 {running}</span>
          <span className="spacer" />
          {locked && (
            <span className="focus-lock" title="位置已锁定（右键可以解锁）" aria-label="位置已锁定" data-testid="focus-locked">
              {ICON.lock}
            </span>
          )}
          <button
            type="button"
            className="focus-icon"
            aria-label={compact ? "展开会话列表" : "收起成一行"}
            title={compact ? "展开会话列表" : "收起成一行"}
            onClick={() => setCompact(!compact)}
            data-testid="focus-compact"
          >
            {compact ? ICON.expand : ICON.collapse}
          </button>
        </div>
        <FocusQuota link={link} settings={settings} profiles={state.profiles} />
        {!compact && needs > 0 && (
          <div className="focus-list" onPointerDown={acknowledge}>
            {proposals.length > 0 && (
              // A proposal needs its prompt read (and maybe edited): only the count here, handled on the board.
              <div className="focus-entry" data-testid="focus-proposals">
                <button type="button" className="focus-row" onClick={() => void window.amo?.openInWorkbench?.({ taskId: "" })}>
                  <span className="dot" style={{ background: "var(--attention)" }} />
                  <span className="focus-row-text">
                    <span className="focus-title">{proposals.length} 条调度提案</span>
                    <span className="focus-sub">在工作台处理</span>
                  </span>
                </button>
              </div>
            )}
            {asks.map((d) => {
              const s = state.sessions.find((x) => x.id === d.sessionId)!;
              return (
                <div key={d.id} className="focus-entry open" data-testid="focus-decision">
                  <DecisionCard
                    link={link}
                    decision={d}
                    sessionTitle={`${title(s)} · ${s.title || "会话"}`}
                    className="focus-detail focus-decision"
                    onWriteElsewhere={() => void window.amo?.openInWorkbench?.({ ...(d.taskId ? { taskId: d.taskId } : {}), sessionId: d.sessionId })}
                  />
                </div>
              );
            })}
            {list.map((s) => (
              <FocusEntry
                key={s.id}
                link={link}
                session={s}
                title={title(s)}
                open={s.id === openId}
                onToggle={() => setOpen(s.id === openId ? "" : s.id)}
              />
            ))}
          </div>
        )}
        {moving && (
          // The whole panel is the window's drag area while moving; 完成 is the one thing that is not.
          <div className="focus-move" data-testid="focus-move">
            <span className="focus-move-badge">
              {ICON.move}
              拖动这里移动 Focus
            </span>
            <button type="button" className="focus-move-done" onClick={() => setMoving(false)} data-testid="focus-move-done">
              完成
            </button>
          </div>
        )}
      </div>
      {menu && (
        <FocusMenu
          at={menu}
          onClose={closeMenu}
          onMouseEnter={() => catchMouse(true)}
          items={[
            { label: moving ? "完成移动" : "移动位置", icon: ICON.move, disabled: locked, hint: locked ? "先取消锁定位置" : undefined, onPick: () => setMoving(!moving), testId: "focus-menu-move" },
            { label: "锁定位置", icon: ICON.lock, checked: locked, onPick: toggleLock, testId: "focus-menu-lock" },
            { label: compact ? "展开会话列表" : "收起成一行", icon: compact ? ICON.expand : ICON.collapse, onPick: () => setCompact(!compact), testId: "focus-menu-compact" },
            { label: "打开 Studio 主窗口", icon: ICON.window, onPick: () => void window.amo?.openInWorkbench?.({ taskId: "" }), testId: "focus-menu-open" },
            { label: "隐藏 Focus", icon: ICON.hide, hint: "主窗口顶栏的 Focus 按钮可以再打开", onPick: () => void window.amo?.focus?.set(false), testId: "focus-menu-hide" },
          ]}
        />
      )}
    </div>
  );
}

/** Whether the pointer is over something of Focus that takes clicks. */
const pointerOverUi = () => !!document.querySelector(".focus-panel:hover, .focus-bot-slot:hover, .focus-menu:hover");

interface MenuItem {
  label: string;
  icon: ReactNode;
  onPick(): void;
  checked?: boolean;
  disabled?: boolean;
  hint?: string | undefined;
  testId: string;
}

/** The right-click menu, kept inside the window (it cannot grow past it). */
function FocusMenu({ at, items, onClose, onMouseEnter }: { at: { x: number; y: number }; items: MenuItem[]; onClose(): void; onMouseEnter(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)), y: Math.max(4, Math.min(at.y, window.innerHeight - height - 4)) });
  }, [at]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !(e.target as Element | null)?.closest?.(".focus-menu") && onClose();
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div ref={box} className="ctx-menu focus-menu" role="menu" aria-label="Focus 设置" style={{ left: pos.x, top: pos.y }} onMouseEnter={onMouseEnter} onContextMenu={(e) => e.preventDefault()} data-testid="focus-menu">
      {items.map((it) => (
        <button
          key={it.testId}
          type="button"
          role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={it.checked}
          disabled={it.disabled}
          title={it.hint}
          onClick={() => {
            onClose();
            it.onPick();
          }}
          data-testid={it.testId}
        >
          <span className="focus-menu-icon">{it.icon}</span>
          <span className="focus-menu-label">{it.label}</span>
          {it.checked && <span className="focus-menu-check">✓</span>}
        </button>
      ))}
    </div>
  );
}

const svg = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

/** 16px stroke icons, as in the rest of Studio. */
const ICON = {
  // The panel grows up from its bottom edge: up opens the list, down folds it to one line.
  expand: svg(<path d="M4 10l4-4 4 4" />),
  collapse: svg(<path d="M4 6l4 4 4-4" />),
  move: svg(<path d="M8 1.8v12.4M1.8 8h12.4M6.3 3.5 8 1.8l1.7 1.7M6.3 12.5 8 14.2l1.7-1.7M3.5 6.3 1.8 8l1.7 1.7M12.5 6.3 14.2 8l-1.7 1.7" />),
  lock: svg(
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
  ),
  window: svg(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.2" />
      <path d="M2 6h12" />
    </>,
  ),
  hide: svg(
    <>
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" />
      <path d="M3 13 13 3" />
    </>,
  ),
};

function FocusEntry({ link, session, title, open, onToggle }: { link: HostLink; session: Session; title: string; open: boolean; onToggle(): void }) {
  const look = SESSION_LOOK[session.status];
  return (
    <div className={open ? "focus-entry open" : "focus-entry"} data-testid="focus-entry">
      <button type="button" className="focus-row" onClick={onToggle} aria-expanded={open}>
        <span className="dot" style={{ background: look.dot }} />
        <span className="focus-row-text">
          <span className="focus-title">{title}</span>
          <span className="focus-sub" style={{ color: look.text }}>
            {look.label}
            {session.title ? ` · ${session.title}` : ""}
          </span>
        </span>
        <span className="focus-time">{relativeTime(session.updatedAt)}</span>
      </button>
      {open && <FocusDetail link={link} session={session} />}
    </div>
  );
}

function FocusDetail({ link, session }: { link: HostLink; session: Session }) {
  const { items } = useSessionItems(link, session.id);
  const { text, approval } = latestSnippet(items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async (a: Approval) => {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/approvals/:approvalId", { approvalId: a.approvalId }, { sessionId: session.id, decision: "accept" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="focus-detail">
      <span className="focus-snippet" data-testid="focus-snippet">
        {text || "（还没有内容）"}
      </span>
      {error && (
        <span className="focus-error" role="alert">
          {error}
        </span>
      )}
      <div className="focus-actions">
        {approval && (
          <button type="button" className="focus-approve" disabled={busy} onClick={() => void approve(approval)}>
            批准
          </button>
        )}
        <button
          type="button"
          className="focus-btn"
          onClick={() => void window.amo?.openInWorkbench?.({ ...(session.taskId ? { taskId: session.taskId } : {}), sessionId: session.id })}
        >
          在工作台打开
        </button>
      </div>
    </div>
  );
}
