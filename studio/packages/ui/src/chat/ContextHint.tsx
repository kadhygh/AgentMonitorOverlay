import { useState } from "react";
import type { Session, SessionItem } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { formatTokens, type ContextUse } from "./turns.js";

// Above the composer (2026-10-17): a session whose context has grown large, where every model call reads the whole of
// it again. A 2-day Claude session grew to 460k and spent ~450k per call; after more than about an hour away its cache
// had expired and the next message read it all again at the uncached price (the 迁移任务 session of 10-15/16).

/** From here the bar shows. */
export const CONTEXT_HINT_AT = 150_000;
/** Claude's prompt cache on the subscription outlived ~1 hour gaps only partly (2026-10-15/16 sessions). */
const CACHE_GONE_MS = 60 * 60_000;
/** A dismissed bar comes back once the context has grown this much more. */
const AGAIN_AFTER = 50_000;

const dismissKey = (sessionId: string) => `amo.contextHint.${sessionId}`;

function dismissedAt(sessionId: string): number {
  try {
    return Number(localStorage.getItem(dismissKey(sessionId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function since(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 120 ? `${min} 分钟` : `${Math.round(min / 60)} 小时`;
}

export function ContextHint({
  link,
  session,
  context,
  items,
  busy,
  onCompact,
}: {
  link: HostLink;
  session: Session;
  context: ContextUse | null;
  items: readonly SessionItem[];
  busy: boolean;
  onCompact(): void;
}) {
  const settings = useSettings(link);
  const [dismissed, setDismissed] = useState(() => dismissedAt(session.id));
  if (!context || context.used < CONTEXT_HINT_AT || context.used < dismissed + AGAIN_AFTER) return null;
  const lastTurn = [...items].reverse().find((i): i is Extract<SessionItem, { type: "turn" }> => i.type === "turn" && !!i.endedAt);
  const idle = lastTurn?.endedAt ? Date.now() - Date.parse(lastTurn.endedAt) : 0;
  const cacheGone = session.runtime === "claude" && idle > CACHE_GONE_MS;
  // DSH compacts by itself at 80% of the model's window (stage 17) and has no command for it; the setting is the CLIs'.
  const dsh = session.runtime === "dsh";
  const auto = dsh ? (context.window ? Math.round(context.window * 0.8) : null) : (settings?.autoCompactTokens ?? null);
  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(session.id), String(context.used));
    } catch {
      // Shown again next time; nothing else depends on it.
    }
    setDismissed(context.used);
  };
  return (
    <div className="wake-bar context-hint" data-kind="limit" data-testid="context-hint" role="group" aria-label="上下文很大">
      <span className="wake-bar-dot" aria-hidden="true" />
      <span
        className="wake-bar-text"
        title={`每次模型调用都要把整个上下文读一遍：上下文越大，每一步越贵。${auto ? (dsh ? `DSH 到 ${formatTokens(auto)}（窗口的 80%）会自动压缩。` : `到 ${formatTokens(auto)} 会自动压缩（设置 → 模型）。`) : ""}换阶段时开新会话最省。`}
      >
        <b>上下文 {formatTokens(context.used)}</b>
        {cacheGone ? ` · 距上次回复 ${since(idle)}，缓存多半已过期，下一条要全价重读` : " · 每一步都要整个重读"}
        {auto && context.used < auto ? ` · 到 ${formatTokens(auto)} 自动压缩` : ""}
        {" · 换阶段可开新会话"}
      </span>
      {!dsh && (
        <button type="button" className="btn-ghost small" disabled={busy} onClick={onCompact} data-testid="context-hint-compact">
          现在压缩
        </button>
      )}
      <button type="button" className="btn-ghost small" onClick={dismiss} data-testid="context-hint-dismiss">
        知道了
      </button>
    </div>
  );
}
