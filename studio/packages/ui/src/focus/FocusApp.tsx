import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Session, SessionItem, StateSnapshot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { needsPerson, relativeTime, SESSION_LOOK, type StatusLook } from "../lib/status.js";
import { noteSeen, unseenSessions, useSessionSeen } from "../lib/sessionSeen.js";
import { planTitle } from "../chat/questions/flow.js";
import { DecisionCard, useOpenDecisions } from "../collab/DecisionPanel.js";
import { usePendingProposals } from "../planning/ProposalsPanel.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { ANGRY_AFTER_MS, attentionKeys, longestWait, PASSTHROUGH_INTERACTIVE, pruneSeen, trackFirstSeen, readFocusLocked, readFocusPassthrough, shapeRects, shouldAlert, writeFocusLocked, writeFocusPassthrough } from "./attention.js";
import { PixelBot, type BotMood } from "./PixelBot.js";
import { FocusQuota } from "./FocusQuota.js";
import { usePetSkin } from "./petSkin.js";
import "./focus.css";

// The Focus window: "what needs me right now". Lists sessions waiting for approval or review, newest first; one entry
// opens to show its latest content, approvals can be granted in place, everything else goes back to the workbench.
// S14-J: while something new needs the person the panel glows and a pixel robot dances above it until they look.
// 2026-10-15: the window takes clicks wherever Focus draws (it tells the main process its shape); 「Focus 设置」 (the
// gear, or a right-click) is a small box with × — 移动位置 / 锁定位置 / 点击穿透 / 收起 / 打开 Studio / 隐藏.
// 2026-10-15 evening: also sessions whose reply ended (「回复完了」) or that failed since the person last looked at them
// in the main window (lib/sessionSeen.ts); clicking one here counts as looking too.
// Later that evening: two kinds only — 事 (approvals, questions, decisions, proposals, failures) and 完成待审核 (a reply
// that ended unseen, or a session waiting for review). The robot says how many of each; it is green when all that is
// new is finished work. Left unacknowledged for 5 minutes it gets angry and flies about the screen in a window of its
// own (app/src/bot-window.ts) until clicked or dealt with; 「Focus 设置」→「机器人动作测试」 plays every mood once.

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
  const [pop, setPop] = useState(false);
  const [passthrough, setPassthrough] = useState(readFocusPassthrough);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const decisions = useOpenDecisions(host.kind === "ready" ? host.link : NO_LINK);
  const pending = usePendingProposals(host.kind === "ready" ? host.link : NO_LINK);
  const settings = useSettings(host.kind === "ready" ? host.link : NO_LINK);
  // Scheduler proposals belong to the planning feature (设置 → 功能).
  const proposals = settings?.disabledFeatures.includes("planning") ? [] : pending;

  useWindowShape();
  const skin = usePetSkin();
  // Each press the page sees, so the main process knows no click was dropped (app/src/focus-clicks.ts).
  useEffect(() => {
    const pressed = () => window.amo?.focus?.pressed?.();
    document.addEventListener("pointerdown", pressed, true);
    return () => document.removeEventListener("pointerdown", pressed, true);
  }, []);
  // 点击穿透: the window lets clicks through, and takes them back while the pointer is over a button (the pointer's
  // moves still reach the page). Moving and the settings box always take clicks.
  const through = passthrough && !moving && !pop;
  useEffect(() => {
    const set = (ignore: boolean) => window.amo?.focus?.setIgnoreMouse(ignore);
    if (!through) {
      set(false);
      return;
    }
    set(true);
    const onOver = (e: PointerEvent) => set(!(e.target as Element | null)?.closest?.(PASSTHROUGH_INTERACTIVE));
    document.addEventListener("pointerover", onOver);
    return () => {
      document.removeEventListener("pointerover", onOver);
      set(false);
    };
  }, [through]);
  // A right-click on the title row (a window drag area) only reaches the main process, which passes it on.
  useEffect(() => window.amo?.focus?.onContextMenu?.(() => setPop(true)), []);

  const seenData = useSessionSeen();
  const live = host.kind === "ready" ? host.state : null;
  const waiting = live ? needsMe(live) : [];
  const finished = live ? unseenSessions(live.sessions, seenData).filter((s) => !waiting.includes(s)) : [];
  // A finished session opened here stays (seen) until it is closed or another one opens.
  const held = live && open ? live.sessions.find((s) => s.id === open && !s.archivedAt && FINISHED.has(s.status) && !waiting.includes(s) && !finished.includes(s)) : undefined;
  const list = [...waiting, ...finished, ...(held ? [held] : [])];
  const asks = live ? decisions.filter((d) => live.sessions.some((s) => s.id === d.sessionId && !s.archivedAt)) : [];
  const keys = attentionKeys([...waiting, ...finished], asks.map((d) => d.id), proposals.map((p) => p.id));
  const keysId = keys.join("|");
  // Forget what was handled, so it alerts again if it comes back.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the keys by content
  useEffect(() => setSeen((s) => pruneSeen(s, keys)), [keysId]);
  const alerting = shouldAlert(keys, seen);
  const toReview = [...waiting, ...finished].filter((s) => isToReview(s, waiting));
  const reviewKeys = new Set(attentionKeys(toReview, [], []));
  // Green when everything new is finished work to look at.
  const calm = alerting && keys.every((k) => seen.has(k) || reviewKeys.has(k));
  const things = waiting.length + finished.length + asks.length + proposals.length - toReview.length;

  // How long the oldest unacknowledged thing has waited; the clock ticks while something does.
  const firstSeen = useRef<Map<string, number>>(new Map());
  firstSeen.current = trackFirstSeen(firstSeen.current, keys, Date.now());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!alerting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [alerting]);
  const waited = longestWait(keys, seen, firstSeen.current, now);
  // 「机器人动作测试」: alert, calm, then angry and flying, a few seconds each.
  const [demo, setDemo] = useState<BotMood | null>(null);
  useEffect(() => {
    if (!demo) return;
    const t = setTimeout(() => setDemo(demo === "alert" ? "calm" : demo === "calm" ? "angry" : null), demo === "angry" ? 10_000 : 2500);
    return () => clearTimeout(t);
  }, [demo]);
  const flyMessage = moving
    ? ""
    : demo
      ? demo === "angry"
        ? "生气了！（测试，点我停下）"
        : ""
      : alerting && waited >= ANGRY_AFTER_MS
        ? `${summary(things, toReview.length)}，等你 ${Math.floor(waited / 60_000)} 分钟了！`
        : "";
  useEffect(() => {
    if (flyMessage) window.amo?.focus?.fly?.(flyMessage);
    else window.amo?.focus?.land?.();
  }, [flyMessage]);
  useEffect(() => () => window.amo?.focus?.land?.(), []);
  // The flying robot was clicked: it landed; open what needs the person (or end the test).
  const caught = useRef(() => {});
  useEffect(() => window.amo?.focus?.onBotCaught?.(() => caught.current()), []);
  const acknowledge = () => setSeen(new Set(keys));

  const togglePassthrough = () => {
    writeFocusPassthrough(!passthrough);
    setPassthrough(!passthrough);
  };
  const toggleLock = () => {
    writeFocusLocked(!locked);
    setLocked(!locked);
    if (!locked) setMoving(false);
  };

  if (host.kind !== "ready") {
    return (
      <div className="focus-root">
        <div className="focus-panel">
          <div className="focus-head">
            <span className="focus-name">Focus</span>
            <span className="focus-dim">{host.kind === "connecting" ? "正在连接 Host…" : "未连接 Host"}</span>
          </div>
        </div>
      </div>
    );
  }

  const { state, link } = host;
  const needs = waiting.length + finished.length + asks.length + proposals.length;
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
  caught.current = () => (demo ? setDemo(null) : openFirst());
  const slotMood: BotMood = demo && demo !== "angry" ? demo : calm ? "calm" : "alert";
  const slotSay = demo === "alert" ? "1 件事（测试）" : demo === "calm" ? "1 个完成待审核（测试）" : summary(things, toReview.length);
  const rootCalm = demo ? demo === "calm" : calm;

  const panelClass = ["focus-panel", locked ? "locked" : "", moving ? "moving" : "", alerting ? "alerting" : "", passthrough ? "passthrough" : ""].filter(Boolean).join(" ");
  return (
    <div className={rootCalm ? "focus-root calm" : "focus-root"}>
      {(alerting || demo) && !moving && !flyMessage && (
        <div className="focus-bot-slot">
          <PixelBot mood={slotMood} skin={skin} message={slotSay} onClick={demo ? () => setDemo(null) : openFirst} />
        </div>
      )}
      {pop && (
        <FocusSettings
          onClose={() => setPop(false)}
          items={[
            { label: moving ? "完成移动" : "移动位置", icon: ICON.move, disabled: locked, hint: locked ? "先取消锁定位置" : "拖动 Focus 到别处", close: true, onPick: () => setMoving(!moving), testId: "focus-menu-move" },
            { label: "锁定位置", icon: ICON.lock, checked: locked, hint: "锁定后标题栏不能拖动", onPick: toggleLock, testId: "focus-menu-lock" },
            { label: "点击穿透", icon: ICON.through, checked: passthrough, hint: "点在 Focus 上会落到下面的窗口，只有按钮能点", onPick: togglePassthrough, testId: "focus-menu-through" },
            { label: compact ? "展开会话列表" : "收起成一行", icon: compact ? ICON.expand : ICON.collapse, close: true, onPick: () => setCompact(!compact), testId: "focus-menu-compact" },
            { label: "机器人动作测试", icon: ICON.bot, hint: "跳舞、变绿、生气乱飞各演一遍", close: true, onPick: () => setDemo("alert"), testId: "focus-menu-bot" },
            { label: "打开 Studio 主窗口", icon: ICON.window, close: true, onPick: () => void window.amo?.openInWorkbench?.({ show: true }), testId: "focus-menu-open" },
            { label: "隐藏 Focus", icon: ICON.hide, hint: "主窗口顶栏的 Focus 按钮可以再打开", close: true, onPick: () => void window.amo?.focus?.set(false), testId: "focus-menu-hide" },
          ]}
        />
      )}
      <div
        className={panelClass}
        data-testid="focus-panel"
        data-locked={locked}
        data-passthrough={passthrough}
        onContextMenu={(e) => {
          e.preventDefault();
          setPop(true);
        }}
      >
        <div className="focus-head">
          {/* Always takes clicks (a button, even under 点击穿透): brings the main window forward, where it is. */}
          <button type="button" className="focus-home" aria-label="打开 AMO 主窗口" title="打开 AMO 主窗口" onClick={() => void window.amo?.openInWorkbench?.({ show: true })} data-testid="focus-home">
            <img src="./icon.svg" alt="" aria-hidden="true" />
          </button>
          <span className="focus-name">Focus</span>
          <span className={needs ? "focus-needs" : "focus-dim"} data-testid="focus-needs">
            {needs ? `需要你 ${needs}` : "没有待处理"}
          </span>
          <span className="focus-dim">· 运行中 {running}</span>
          <span className="spacer" />
          {passthrough && (
            <span className="focus-lock" title="点击穿透：只有按钮能点（在 Focus 设置里关掉）" aria-label="点击穿透已开" data-testid="focus-passthrough">
              {ICON.through}
            </span>
          )}
          {locked && (
            <span className="focus-lock" title="位置已锁定（在 Focus 设置里解锁）" aria-label="位置已锁定" data-testid="focus-locked">
              {ICON.lock}
            </span>
          )}
          <button type="button" className="focus-icon" aria-label="Focus 设置" title="Focus 设置（右键也能打开）" aria-expanded={pop} onClick={() => setPop(!pop)} data-testid="focus-settings-toggle">
            {ICON.gear}
          </button>
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
        {!compact && (needs > 0 || held) && (
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
                finished={!waiting.includes(s)}
                toReview={isToReview(s, waiting)}
                onToggle={() => {
                  setOpen(s.id === openId ? "" : s.id);
                  if (!waiting.includes(s)) noteSeen([s.id]);
                }}
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
    </div>
  );
}

/**
 * Tells the main process which parts of the window are Focus — the panel, the robot, the settings box — so clicks
 * anywhere else go to the windows below. Sent when their boxes change.
 */
function useWindowShape() {
  const last = useRef("");
  const send = useRef(() => {});
  send.current = () => {
    const boxes = [...document.querySelectorAll<HTMLElement>(".focus-panel, .pixel-bot, .focus-pop")].map((el) => el.getBoundingClientRect());
    const rects = shapeRects(boxes, { width: window.innerWidth, height: window.innerHeight });
    const key = JSON.stringify(rects);
    if (!rects.length || key === last.current) return;
    last.current = key;
    window.amo?.focus?.setShape?.(rects);
  };
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    observer.current = new ResizeObserver(() => send.current());
    const onResize = () => send.current();
    window.addEventListener("resize", onResize);
    return () => {
      observer.current?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);
  // After every render: watch the parts there are now, and send their boxes if they moved.
  useLayoutEffect(() => {
    for (const el of document.querySelectorAll(".focus-panel, .pixel-bot, .focus-pop")) observer.current?.observe(el);
    send.current();
    // Once the robot's pop-in (a scale animation, which no observer sees) is over.
    const t = setTimeout(() => send.current(), 300);
    return () => clearTimeout(t);
  });
}

interface SettingItem {
  label: string;
  icon: ReactNode;
  onPick(): void;
  /** A switch (stays open, shows its state); otherwise an action. */
  checked?: boolean;
  /** Close the box after the action. */
  close?: boolean;
  disabled?: boolean;
  hint?: string | undefined;
  testId: string;
}

/** 「Focus 设置」: a small box above the panel with ×. Switches stay open; actions close it. */
function FocusSettings({ items, onClose }: { items: SettingItem[]; onClose(): void }) {
  return (
    <div className="focus-pop" role="dialog" aria-label="Focus 设置" onContextMenu={(e) => e.preventDefault()} data-testid="focus-menu">
      <div className="focus-pop-head">
        <span className="focus-pop-title">Focus 设置</span>
        <button type="button" className="focus-pop-x" aria-label="关闭" title="关闭" onClick={onClose} data-testid="focus-menu-close">
          {ICON.x}
        </button>
      </div>
      {items.map((it) => (
        <button
          key={it.testId}
          type="button"
          className="focus-pop-row"
          role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={it.checked}
          disabled={it.disabled}
          title={it.hint}
          onClick={() => {
            if (it.close) onClose();
            it.onPick();
          }}
          data-testid={it.testId}
        >
          <span className="focus-menu-icon">{it.icon}</span>
          <span className="focus-menu-label">
            {it.label}
            {it.checked !== undefined && it.hint && <span className="focus-pop-hint">{it.hint}</span>}
          </span>
          {it.checked !== undefined && <span className={it.checked ? "focus-switch on" : "focus-switch"} aria-hidden="true" />}
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
  gear: svg(
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </>,
  ),
  // A pointer passing through a sheet.
  through: svg(
    <>
      <path d="M2.5 9.5h11" strokeDasharray="2 1.6" />
      <path d="M8 2v10.5M5.6 10.1 8 12.5l2.4-2.4" />
    </>,
  ),
  x: svg(<path d="M4 4l8 8M12 4l-8 8" />),
  bot: svg(
    <>
      <rect x="3" y="4.5" width="10" height="7.5" rx="1.5" />
      <path d="M8 4.5V2.2M6 8h.01M10 8h.01M6.5 10.2h3M1.8 7.5v2.5M14.2 7.5v2.5" />
    </>,
  ),
  hide: svg(
    <>
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" />
      <path d="M3 13 13 3" />
    </>,
  ),
};

const FINISHED: ReadonlySet<string> = new Set(["idle", "completed", "error"]);
/** Finished work to look at: a reply that ended unseen, or a session waiting for review. */
const TO_REVIEW: StatusLook = { label: "完成待审核", dot: "var(--running)", text: "var(--running-text)" };

/** 完成待审核 rather than a 事: a reply that ended (not failed) unseen, or a session waiting for review. */
export function isToReview(s: Session, waiting: readonly Session[]): boolean {
  return s.status === "awaiting-review" || (!waiting.includes(s) && s.status !== "error");
}

/** The robot's words: how many 事 and how many 完成待审核. */
export function summary(things: number, toReview: number): string {
  return [things ? `${things} 件事` : "", toReview ? `${toReview} 个完成待审核` : ""].filter(Boolean).join(" · ") || "没有待处理";
}

function FocusEntry({ link, session, title, open, finished, toReview, onToggle }: { link: HostLink; session: Session; title: string; open: boolean; finished: boolean; toReview: boolean; onToggle(): void }) {
  const look = toReview ? TO_REVIEW : SESSION_LOOK[session.status];
  return (
    <div className={open ? "focus-entry open" : "focus-entry"} data-testid="focus-entry" data-finished={finished || undefined} data-review={toReview || undefined}>
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
