import type { ReactNode } from "react";
import { shell } from "./env.js";
import { useSession, type Session } from "./session.js";
import type { RelayFile } from "./shared.js";
import type { ShellUpdate } from "./ShellUpdate.js";
import { spanText, useSecondTick, type Updates } from "./update.js";

// What wants me, at the foot of the list column (the layout redesign, 2026-10-27; moved under layout A's list column
// 2026-11-23, plans/cowork.md 第 8 条): offline, a newer version, a newer desktop program — as strips to click, in
// every view; what waits on me (or that nothing does) under 待处理's list, where it is handled (the rail's badge says it
// everywhere else). The shortcuts (复制用法; 团队流程 and 流程速查 only with flowShortcuts, hidden since the tightening,
// features.ts) sit under 待处理's list too. The connection moved to the title bar, me and 设置 to the rail.

const FLOW_SEEN = "amo-relay.flowSeen";

/** Whether the flow document has a version I have not opened (one I uploaded counts as seen). */
export function flowIsNew(doc: RelayFile | null | undefined, me: string, server: string): boolean {
  if (!doc || doc.by === me) return false;
  try {
    return localStorage.getItem(`${FLOW_SEEN}:${server}`) !== doc.id;
  } catch {
    return false;
  }
}

export function markFlowSeen(doc: RelayFile, server: string): void {
  try {
    localStorage.setItem(`${FLOW_SEEN}:${server}`, doc.id);
  } catch {
    // storage blocked: it shows again next time
  }
}

/** Offline, a newer version, a newer desktop program: the strips every view's list ends with. */
export function StatusStrips(props: { session: Session; updates: Updates; shellUpdate: ShellUpdate | null; onShellUpdate: () => void }) {
  const { session, updates, shellUpdate } = props;
  const { connection, offlineSince, retryAt } = useSession(session);
  const now = useSecondTick(connection === "offline");
  const offline = connection === "offline" && !!offlineSince && now - offlineSince >= 1500;
  const strips: ReactNode[] = [];
  if (offline)
    strips.push(
      <Strip key="off" tone="error" mark="!" title={`服务器离线 · 已 ${spanText(now - offlineSince!)}`} sub={retryAt && retryAt > now ? `${spanText(retryAt - now)}后重试 · 这段时间发不出消息` : "正在重连…"} action="重试" onClick={() => session.reconnectNow()} />,
    );
  const u = updates.update;
  if (u) {
    // Installed by AMO 平台: the newer desktop program comes from there, not from the download page.
    if (u.needShell && u.updatedBy === "platform") strips.push(<Strip key="u" tone="info" mark="↑" title="有新版本" sub={`${u.latest} 要新的桌面程序，在 AMO 平台的「工具」里更新 AMO 中转`} />);
    else if (u.needShell) strips.push(<Strip key="u" tone="info" mark="↑" title="有新版本" sub={`${u.latest} 要换新的桌面程序`} action="下载" onClick={() => shell?.openExternal(session.me.server)} />);
    else if (updates.progress) strips.push(<Strip key="u" tone="info" mark="↑" title={`正在更新到 ${u.latest}…`} sub={`${Math.round((updates.progress.done / Math.max(updates.progress.total, 1)) * 100)}%`} />);
    else strips.push(<Strip key="u" tone="info" mark="↑" title="有新版本" sub={updates.error ? `更新失败：${updates.error}` : `${u.latest} · 点一下更新，正在看的会保留`} action="立即更新" onClick={() => void updates.apply()} />);
  }
  if (shellUpdate)
    strips.push(
      <Strip key="s" tone="info" mark="↑" title="桌面程序可更新" sub={shellUpdate.kind === "auto" ? `新版 ${shellUpdate.target?.build ?? ""}，点一下更新并重启` : "换新的桌面程序才有新标题栏等功能"} action="更新" onClick={props.onShellUpdate} />,
    );
  return strips.length ? <div className="strips">{strips}</div> : null;
}

/** 待处理's own strip: how many wait on me, or that nothing does (and what waits on others). */
export function QueueStrip(props: { mine: number; handed: number; waiting: number; onQueue: () => void; onWaiting: () => void }) {
  const { mine, handed, waiting } = props;
  const pending = mine + handed;
  if (pending) return <Strip tone="attn" mark="!" title={`${pending} 件等你处理`} sub={[mine && `${mine} 个会话`, handed && `${handed} 个任务`].filter(Boolean).join("、") + "交给你"} action="去处理" onClick={props.onQueue} />;
  return <Strip tone="calm" mark="✓" title="没有等你处理的" sub={waiting ? `等别人回复的 ${waiting} 件` : "等别人的也没有"} action={waiting ? "查看" : undefined} onClick={waiting ? props.onWaiting : undefined} />;
}

/** 复制用法 (and, with the full UI, 团队流程 / 流程速查). */
export function Shortcuts(props: { session: Session; flowNew: boolean; flowShortcuts: boolean; onFlow: () => void; onQuick: () => void; onCopyUsage: () => void }) {
  const doc = useSession(props.session).settings.flowDoc ?? null;
  return (
    <div className="shortcuts">
      {props.flowShortcuts && (
        <>
          <button type="button" className="shortcut" onClick={props.onFlow} title={doc ? `打开团队流程（第 ${doc.version} 版 · ${doc.by} 更新）` : "还没有上传团队流程，点一下去设置里上传"}>
            <Ico d="M4 2.5 H11 L14 5.5 V15.5 H4 Z M11 2.5 V5.5 H14 M6.5 9 H11.5 M6.5 12 H10" />
            <span className="grow">团队流程</span>
            {props.flowNew && <span className="chip attn">有更新</span>}
            {!doc && <span className="muted tiny">未上传</span>}
          </button>
          <button type="button" className="shortcut" onClick={props.onQuick} title="推进方式、常用指令，点开可以复制">
            <Ico d="M3 4.5 H15 M3 9 H15 M3 13.5 H10" />
            <span className="grow">流程速查</span>
          </button>
        </>
      )}
      <button type="button" className="shortcut" onClick={props.onCopyUsage} title="复制本机用法文档的位置，贴给 agent，它会自己去读，用命令行收发会话；不占它平时的上下文">
        <Ico d="M6 6 H14.5 V14.5 H6 Z M3.5 11.5 V3.5 H11.5" />
        <span className="grow">复制用法</span>
      </button>
    </div>
  );
}

/** The title bar's 「服务器在线 · 地址」. */
export function ConnChip({ session }: { session: Session }) {
  const { connection } = useSession(session);
  let host = session.me.server;
  try {
    host = new URL(session.me.server).host;
  } catch {
    // not a URL: shown as it is
  }
  return (
    <span className={`conn-chip ${connection}`} title={`服务器 ${session.me.server}`}>
      <span className="conn-dot" />
      <span className="conn-text">{{ online: "服务器在线", connecting: "正在连接服务器", offline: "服务器离线" }[connection]}</span>
      <span className="conn-host">· {host}</span>
    </span>
  );
}

function Strip({ tone, mark, title, sub, action, onClick }: { tone: "attn" | "calm" | "info" | "error"; mark: string; title: string; sub?: string; action?: string; onClick?: () => void }) {
  return (
    <button type="button" className={`strip ${tone}`} onClick={onClick} disabled={!onClick}>
      <span className="strip-mark">{mark}</span>
      <span className="strip-text">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </span>
      {action && <span className="strip-act">{action}</span>}
    </button>
  );
}

function Ico({ d }: { d: string }) {
  return (
    <svg className="ico" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
