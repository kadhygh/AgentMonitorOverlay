import { useState } from "react";
import type { ModelProfile, Session, Task } from "@amo-studio/protocol";
import type { CopyStatus } from "../remote/remote.js";
import { SESSION_LOOK, taskStatus } from "../lib/status.js";

// 远程 (step 2, 2026-10-29) under the head of a copy of another computer's task. 2026-10-30 (the user): one line by
// default — the 远程 mark, where it runs and how its models are doing; the explanation folds out beneath, under the
// title (not under the mark). Open or folded is remembered for every copy.

const OPEN_KEY = "amo.remoteBannerOpen";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(on: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, on ? "1" : "0");
  } catch {
    // per-window convenience only
  }
}

/** The task's models there (those of its sessions, not subagents) and the status that most needs the person. */
export function remoteWatch(sessions: readonly Session[], profiles: readonly ModelProfile[]): { models: string[]; status: Session["status"] | null } {
  const live = sessions.filter((s) => !s.archivedAt && s.kind !== "sub");
  const models = [...new Set(live.map((s) => profiles.find((p) => p.id === s.profileId)?.label ?? "").filter(Boolean))];
  return { models, status: taskStatus(live) };
}

export function RemoteBanner({ task, copy, sessions, profiles }: { task: Task; copy: CopyStatus; sessions: readonly Session[]; profiles: readonly ModelProfile[] }) {
  const [open, setOpenState] = useState(readOpen);
  const setOpen = (on: boolean) => {
    setOpenState(on);
    writeOpen(on);
  };
  const remote = task.remote!;
  const title = copy.state === "revoked" ? "授权已收回" : copy.state === "offline" ? copy.label : `在 ${copy.name} 上运行`;
  const detail =
    copy.state === "revoked"
      ? `${remote.reason && remote.reason !== "授权已收回" ? `${remote.reason}。` : `${copy.name} 收回了这个任务的授权。`}已经同步的记录还能看，不会再连回去。归档会清掉这台电脑上的副本。`
      : copy.state === "offline"
        ? `记录能看；现在不能发消息、不能审批，写好的消息留在输入框里。${copy.self ? "这台电脑连上团队服务器后" : `${copy.name} 回来后`}会自动重连，补齐这段时间的记录。`
        : `这是 ${remote.account} 的「${copy.name}」授权给这台电脑的任务：模型调用和命令都在那台电脑上。对话里的 HTML、Markdown 和图片可以点开看（从那台电脑取过来）；其他文件、Git Review、终端要在那边用。`;
  const watch = copy.state === "revoked" ? null : remoteWatch(sessions, profiles);
  const look = watch?.status ? SESSION_LOOK[watch.status] : null;
  return (
    <div className={`remote-banner ${copy.state}${open ? " open" : ""}`} role="status" data-testid="remote-banner" data-state={copy.state}>
      <button type="button" className="remote-banner-head" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="remote-banner-toggle">
        <span className="remote-badge">远程</span>
        <b className="remote-banner-title">{title}</b>
        {watch && watch.models.length > 0 && (
          <span className="remote-banner-watch" data-testid="remote-banner-watch">
            <span className="remote-banner-models">{watch.models.join("、")}</span>
            {look && copy.state === "online" && (
              <span className="remote-banner-status" style={{ color: look.text }}>
                <span className="remote-banner-dot" style={{ background: look.dot }} />
                {look.label}
              </span>
            )}
          </span>
        )}
        {copy.syncing && (
          <span className="remote-banner-sync" data-testid="remote-banner-sync">
            <span className="starting-spin" aria-hidden="true" />
            {copy.syncing}
          </span>
        )}
        <span className="remote-banner-more">{open ? "收起说明" : "说明"}</span>
        <span className={`remote-banner-caret${open ? " open" : ""}`} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <p className="remote-banner-detail" data-testid="remote-banner-detail">
          {detail}
        </p>
      )}
    </div>
  );
}
