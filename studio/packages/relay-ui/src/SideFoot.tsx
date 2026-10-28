import type { ReactNode } from "react";
import { Avatar, Who } from "./bits.js";
import { shell } from "./env.js";
import { useSession, type Session } from "./session.js";
import type { RelayFile } from "./shared.js";
import type { ShellUpdate } from "./ShellUpdate.js";
import { spanText, useSecondTick, type Updates } from "./update.js";

// The bottom of the left column (the layout redesign, 2026-10-27, as AMO Studio's): what wants me first — offline,
// what waits on me (or that nothing does), a newer version — as strips to click; then the shortcuts (团队流程,
// 流程速查, 复制用法); then me, how the service is, and 设置. 团队流程 and 流程速查 only with flowShortcuts (hidden since the
// tightening, features.ts).

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

export interface FootActions {
  onQueue: () => void;
  onWaiting: () => void;
  onShellUpdate: () => void;
  onFlow: () => void;
  onQuick: () => void;
  onCopyUsage: () => void;
  onProfile: () => void;
  onSettings: () => void;
}

export function SideFoot(props: { session: Session; mine: number; handed: number; waiting: number; updates: Updates; shellUpdate: ShellUpdate | null; flowNew: boolean; flowShortcuts: boolean } & FootActions) {
  const { session, mine, handed, waiting, updates, shellUpdate } = props;
  const { connection, offlineSince, retryAt, settings } = useSession(session);
  const now = useSecondTick(connection === "offline");
  const offline = connection === "offline" && !!offlineSince && now - offlineSince >= 1500;
  const doc = settings.flowDoc ?? null;
  const pending = mine + handed;

  const strips: ReactNode[] = [];
  if (offline)
    strips.push(
      <Strip key="off" tone="error" mark="!" title={`服务器离线 · 已 ${spanText(now - offlineSince!)}`} sub={retryAt && retryAt > now ? `${spanText(retryAt - now)}后重试 · 这段时间发不出消息` : "正在重连…"} action="重试" onClick={() => session.reconnectNow()} />,
    );
  if (pending)
    strips.push(<Strip key="q" tone="attn" mark="!" title={`${pending} 件等你处理`} sub={[mine && `${mine} 个会话`, handed && `${handed} 个任务`].filter(Boolean).join("、") + "交给你"} action="去处理" onClick={props.onQueue} />);
  else strips.push(<Strip key="q" tone="calm" mark="✓" title="没有等你处理的" sub={waiting ? `等别人回复的 ${waiting} 件` : "等别人的也没有"} action={waiting ? "查看" : undefined} onClick={waiting ? props.onWaiting : undefined} />);
  const u = updates.update;
  if (u) {
    if (u.needShell) strips.push(<Strip key="u" tone="info" mark="↑" title="有新版本" sub={`${u.latest} 要换新的桌面程序`} action="下载" onClick={() => shell?.openExternal(session.me.server)} />);
    else if (updates.progress) strips.push(<Strip key="u" tone="info" mark="↑" title={`正在更新到 ${u.latest}…`} sub={`${Math.round((updates.progress.done / Math.max(updates.progress.total, 1)) * 100)}%`} />);
    else strips.push(<Strip key="u" tone="info" mark="↑" title="有新版本" sub={updates.error ? `更新失败：${updates.error}` : `${u.latest} · 点一下更新，正在看的会保留`} action="立即更新" onClick={() => void updates.apply()} />);
  }
  if (shellUpdate)
    strips.push(
      <Strip key="s" tone="info" mark="↑" title="桌面程序可更新" sub={shellUpdate.kind === "auto" ? `新版 ${shellUpdate.target?.build ?? ""}，点一下更新并重启` : "换新的桌面程序才有新标题栏等功能"} action="更新" onClick={props.onShellUpdate} />,
    );

  return (
    <div className="side-foot">
      <div className="strips">{strips}</div>
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
      <div className="me-row">
        <button type="button" className="me-chip" title={`编辑资料：昵称、头像、负责什么 · 服务器 ${session.me.server}`} onClick={props.onProfile}>
          <Avatar name={session.me.name} />
          <span className="me-lines">
            <span className="me-name">
              <Who name={session.me.name} />
            </span>
            <span className={`conn-chip ${connection}`}>
              <span className="conn-dot" />
              {{ online: "服务器在线", connecting: "正在连接服务器", offline: "服务器离线" }[connection]}
            </span>
          </span>
        </button>
        <button type="button" className="gear" aria-label="设置" title="设置：字体大小、主题、团队流程、接入 AI" onClick={props.onSettings}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </div>
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
