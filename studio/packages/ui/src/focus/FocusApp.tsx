import { useEffect, useRef, useState } from "react";
import type { Session, StateSnapshot } from "@amo-studio/protocol";
import { useHostState } from "../host/useHostState.js";
import { needsPerson } from "../lib/status.js";
import { noteSeen, unseenSessions, useSessionSeen } from "../lib/sessionSeen.js";
import { DecisionCard, useOpenDecisions } from "../collab/DecisionPanel.js";
import { usePendingProposals } from "../planning/ProposalsPanel.js";
import { useTaskPlans } from "../taskplans/TaskPlans.js";
import { RelayCard, useRelays } from "../relays/Relays.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { ANGRY_AFTER_MS, attentionKeys, longestWait, PASSTHROUGH_INTERACTIVE, pruneSeen, trackFirstSeen, readFocusLocked, readFocusPassthrough, shouldAlert, writeFocusLocked, writeFocusPassthrough } from "./attention.js";
import { PixelBot, type BotMood } from "./PixelBot.js";
import { FocusQuota } from "./FocusQuota.js";
import { usePetSkin } from "./petSkin.js";
import { FocusEntry, isToReview, summary } from "./FocusEntry.js";
import { FocusSettings, ICON, type SettingItem } from "./FocusSettings.js";
import { useWindowShape } from "./windowShape.js";
import "./focus.css";

export { isToReview, latestSnippet, summary } from "./FocusEntry.js";

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

export function needsMe(state: StateSnapshot): Session[] {
  return state.sessions
    .filter((s) => !s.archivedAt && needsPerson(s.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

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
  // 拆任务提案 (stage 16): a 主控 waits for the person to accept or dismiss them.
  const plans = useTaskPlans(host.kind === "ready" ? host.link : NO_LINK).filter((p) => p.state === "open");
  // 传话 (stage 16): answered here in place, like an approval.
  const relays = useRelays(host.kind === "ready" ? host.link : NO_LINK).filter((r) => r.state === "pending");

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
  const keys = attentionKeys([...waiting, ...finished], asks.map((d) => d.id), [...proposals.map((p) => p.id), ...plans.map((p) => p.id), ...relays.map((r) => r.id)]);
  const keysId = keys.join("|");
  // Forget what was handled, so it alerts again if it comes back.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the keys by content
  useEffect(() => setSeen((s) => pruneSeen(s, keys)), [keysId]);
  const alerting = shouldAlert(keys, seen);
  const toReview = [...waiting, ...finished].filter((s) => isToReview(s, waiting));
  const reviewKeys = new Set(attentionKeys(toReview, [], []));
  // Green when everything new is finished work to look at.
  const calm = alerting && keys.every((k) => seen.has(k) || reviewKeys.has(k));
  const things = waiting.length + finished.length + asks.length + proposals.length + plans.length + relays.length - toReview.length;

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
  const needs = waiting.length + finished.length + asks.length + proposals.length + plans.length + relays.length;
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
            { label: "主窗口回到屏幕中央", icon: ICON.center, hint: "主窗口拖到屏幕外找不到时：放回 Focus 所在屏幕的正中", close: true, onPick: () => void window.amo?.focus?.centerMain?.(), testId: "focus-menu-center" },
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
          {/* Always takes clicks (a button, even under 点击穿透): brings the main window forward, where it is. The icon
              and the name are one button (2026-10-19). */}
          <button type="button" className="focus-home" aria-label="打开 AMO 主窗口" title="打开 AMO 主窗口" onClick={() => void window.amo?.openInWorkbench?.({ show: true })} data-testid="focus-home">
            <img src="./icon.svg" alt="" aria-hidden="true" />
            <span className="focus-name">Focus</span>
          </button>
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
            {relays.map((r) => (
              <div key={r.id} className="focus-entry open" data-testid="focus-relay">
                <RelayCard link={link} relay={r} tasks={state.tasks} className="focus-detail focus-relay" />
              </div>
            ))}
            {plans.map((p) => (
              // Read and changed on the 主控's task page (or its topic's canvas): here only that it waits.
              <div key={p.id} className="focus-entry" data-testid="focus-plan">
                <button type="button" className="focus-row" onClick={() => void window.amo?.openInWorkbench?.({ ...(p.fromTaskId ? { taskId: p.fromTaskId } : {}), sessionId: p.fromSessionId })}>
                  <span className="dot" style={{ background: "var(--attention)" }} />
                  <span className="focus-row-text">
                    <span className="focus-title">拆任务提案 · {p.tasks.length} 个任务</span>
                    <span className="focus-sub">{state.tasks.find((t) => t.id === p.fromTaskId)?.title || "主控"} · {p.summary.split("\n")[0]}</span>
                  </span>
                </button>
              </div>
            ))}
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
                onDone={() => {
                  noteSeen([s.id]);
                  setOpen("");
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

const FINISHED: ReadonlySet<string> = new Set(["idle", "completed", "error"]);
