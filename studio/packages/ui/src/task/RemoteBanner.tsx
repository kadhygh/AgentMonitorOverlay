import { useState } from "react";
import type { AccountUsage, ChannelBalance, Id, ModelProfile, RemotePeerUsage, Session, Task } from "@amo-studio/protocol";
import type { CopyStatus } from "../remote/remote.js";
import { SESSION_LOOK, relativeTime, taskStatus } from "../lib/status.js";
import { readStored, writeStored } from "../lib/stored.js";
import { balanceText, money } from "../lib/balance.js";
import { UsageAccount, resetIn, useNow } from "../board/UsageFooter.js";

// 远程 (step 2, 2026-10-29) under the head of a copy of another computer's task. 2026-10-30 (the user): one line by
// default — the 远程 mark, where it runs and how its models are doing; the explanation folds out beneath, under the
// title (not under the mark). Open or folded is remembered for every copy.

const OPEN_KEY = "amo.remoteBannerOpen";

const readOpen = (): boolean => readStored(OPEN_KEY) === "1";

const writeOpen = (on: boolean): void => writeStored(OPEN_KEY, on ? "1" : "0");

/** The task's models there (those of its sessions, not subagents) and the status that most needs the person. */
export function remoteWatch(sessions: readonly Session[], profiles: readonly ModelProfile[]): { models: Array<{ id: Id; label: string }>; status: Session["status"] | null } {
  const live = sessions.filter((s) => !s.archivedAt && s.kind !== "sub");
  const models = [...new Set(live.map((s) => s.profileId))].flatMap((id) => {
    const label = profiles.find((p) => p.id === id)?.label;
    return label ? [{ id, label }] : [];
  });
  return { models, status: taskStatus(live) };
}

/**
 * 远程额度 (2026-11-06, the user: 被控端追踪了这个模型的额度，就直接显示被控端的信息): what A last read of a model's
 * quota (pushed by A, never asked for here). Nothing when A has no numbers for it — no 「未知」.
 */
export function remoteQuota(usage: RemotePeerUsage | undefined, profileId: Id): { usage?: AccountUsage; balance?: ChannelBalance } | null {
  const found = usage?.usage.find((x) => x.profileId === profileId);
  // A model's own weekly limit (Fable 每周…) stays out of this line (2026-11-13: shown only where 设置 → 额度 turns it on).
  const u = found ? { ...found, windows: found.windows.filter((w) => !w.model) } : undefined;
  const b = usage?.balances.find((x) => x.profileId === profileId);
  return u || b ? { ...(u ? { usage: u } : {}), ...(b ? { balance: b } : {}) } : null;
}

/**
 * The folded line's word on a model's quota (2026-11-06, the user: Claude 的 5 小时和周限额都要显示，用进度条): every
 * window with the left column's bar and how much is used (「5 小时 ▬▭ 37% · 每周 ▬▭ 12%」), or, without windows, the
 * balance (「余额 ¥88.10」). A narrow page drops the bars first, then clips (as the left column's folded line does).
 */
function QuotaInline({ usage, balance, from, now }: { usage?: AccountUsage; balance?: ChannelBalance; from: string; now: Date }) {
  const windows = usage?.windows ?? [];
  if (!windows.length && !balance) return null;
  return (
    <span className="remote-banner-quota" data-testid="remote-banner-quota">
      {windows.map((w) => {
        const used = w.usedPercent;
        const hot = used !== null && used >= 80;
        const title = `${from} 上的数据：${w.label}${used === null ? "用量未知" : `已用 ${used}%，剩 ${Math.max(0, 100 - used)}%`}${w.resetsAt ? `，${resetIn(w.resetsAt, now)} 后重置` : ""}`;
        return (
          <span key={w.label} className="remote-banner-win" title={title} data-testid="remote-banner-win">
            <span className="remote-banner-win-label">{w.label}</span>
            <span className="usage-bar" aria-hidden="true">
              {used !== null && <span className={hot ? "hot" : undefined} style={{ width: `${Math.min(100, used)}%` }} />}
            </span>
            <span className={hot ? "remote-banner-win-pct hot" : "remote-banner-win-pct"}>{used === null ? "—" : `${used}%`}</span>
          </span>
        );
      })}
      {!windows.length && balance && (
        <span className="remote-banner-win" title={`${from} 上的数据：${balanceText(balance)}`} data-testid="remote-banner-win">
          <span className="remote-banner-win-pct">{balance.remaining !== null ? `余额 ${money(balance.remaining, balance.unit)}` : balanceText(balance)}</span>
        </span>
      )}
    </span>
  );
}

export function RemoteBanner({ task, copy, sessions, profiles, usage }: { task: Task; copy: CopyStatus; sessions: readonly Session[]; profiles: readonly ModelProfile[]; usage?: RemotePeerUsage }) {
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
        : `这是 ${remote.account} 的「${copy.name}」授权给这台电脑的任务：模型调用和命令都在那台电脑上。对话里的 HTML、Markdown 和图片可以点开看（从那台电脑取过来）；这台电脑发消息引出的那一轮里，agent 打开的查看包和 Review 在这里弹出来，可以看、批注；终端和其他操作要在那边用。`;
  const watch = copy.state === "revoked" ? null : remoteWatch(sessions, profiles);
  const look = watch?.status ? SESSION_LOOK[watch.status] : null;
  const quotas = (watch?.models ?? []).flatMap((m) => {
    const q = remoteQuota(usage, m.id);
    return q ? [{ ...m, ...q }] : [];
  });
  // Ticking for the reset times (the folded line's tooltips too).
  const now = useNow(quotas.length > 0);
  return (
    <div className={`remote-banner ${copy.state}${open ? " open" : ""}`} role="status" data-testid="remote-banner" data-state={copy.state}>
      <button type="button" className="remote-banner-head" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="remote-banner-toggle">
        <span className="remote-badge">远程</span>
        <b className="remote-banner-title">{title}</b>
        {watch && watch.models.length > 0 && (
          <span className="remote-banner-watch" data-testid="remote-banner-watch">
            <span className="remote-banner-models">
              {watch.models.map((m, i) => {
                const q = quotas.find((x) => x.id === m.id);
                return (
                  <span key={m.id} className="remote-banner-model">
                    {i > 0 && "、"}
                    <span className="remote-banner-model-name">{m.label}</span>
                    {q && <QuotaInline usage={q.usage} balance={q.balance} from={copy.name} now={now} />}
                  </span>
                );
              })}
            </span>
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
      {open && quotas.length > 0 && (
        <div className="remote-banner-usage usage-list" data-testid="remote-banner-usage">
          {quotas.map((q) => (
            <RemoteQuota key={q.id} label={q.label} usage={q.usage} balance={q.balance} from={copy.name} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One model's quota as A read it, in the left column's form, saying whose numbers they are and how old. */
function RemoteQuota({ label, usage, balance, from, now }: { label: string; usage?: AccountUsage; balance?: ChannelBalance; from: string; now: Date }) {
  const whose = (at: string | null) => `${from} 上的数据${at ? ` · ${relativeTime(at, now)}更新` : ""}`;
  return (
    <>
      {usage && <UsageAccount usage={{ ...usage, label, note: `${whose(usage.updatedAt)}${usage.note ? `（${usage.note}）` : ""}` }} now={now} />}
      {balance && (
        <div className="usage-acct" data-testid="usage-balance">
          <b className="usage-acct-name">{label}</b>
          <div className="usage-acct-body">
            <div className="usage-win-line">
              <span>{balanceText(balance)}</span>
            </div>
            <span className="usage-note">{whose(balance.checkedAt)}</span>
          </div>
        </div>
      )}
    </>
  );
}
