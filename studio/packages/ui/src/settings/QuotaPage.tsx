import { useEffect, useState } from "react";
import type { AccountUsage, ModelProfile, QuotaDisplay, StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Mark } from "../chat/pickers.js";
import { balanceText, useBalance, useProfiles } from "../lib/balance.js";
import { quotaOf } from "../lib/quota.js";

// 设置 → 额度 (2026-10-15): every account whose quota Studio can follow — the subscriptions' use (GPT, Claude) and the
// balance of channels whose site tells it (设置 → 模型) — and where each shows: the bottom of the left column, Focus.

export function QuotaPage({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const profiles = useProfiles(link);
  const [usage, setUsage] = useState<AccountUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call(link, "GET /api/usage")
      .then(setUsage)
      .catch(() => setUsage([]));
  }, [link]);

  async function save(profileId: string, next: QuotaDisplay) {
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { quotaDisplay: { [profileId]: next } });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  }

  const rows = (profiles ?? []).filter((p) => p.balance || usage?.some((u) => u.profileId === p.id));
  return (
    <section className="settings-section" aria-label="额度">
      <span className="settings-heading">额度</span>
      <span className="settings-hint">Studio 能跟踪的额度：GPT、Claude 订阅的用量，和设置了余额查询的渠道（在 设置 → 模型 里给渠道选查询方式）。左下角点开能看每个窗口剩多少、什么时候重置。</span>
      {profiles && usage && rows.length === 0 && <span className="settings-hint">还没有能跟踪的额度。</span>}
      <div className="quota-list">
        {rows.map((p) => (
          <QuotaRow key={p.id} link={link} profile={p} usage={usage?.find((u) => u.profileId === p.id)} display={quotaOf(settings, p.id)} onChange={(d) => void save(p.id, d)} />
        ))}
      </div>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}

function usageText(u: AccountUsage): string {
  const parts = u.windows.flatMap((w) => (w.usedPercent === null ? [] : [`${w.label} 剩 ${Math.max(0, 100 - w.usedPercent)}%`]));
  return parts.length ? parts.join(" · ") : (u.note ?? "还没有读到用量");
}

function QuotaRow({ link, profile, usage, display, onChange }: { link: HostLink; profile: ModelProfile; usage: AccountUsage | undefined; display: QuotaDisplay; onChange(d: QuotaDisplay): void }) {
  const { balance } = useBalance(link, profile);
  const now = usage ? usageText(usage) : balance ? balanceText(balance) : profile.balance ? "正在查询…" : "—";
  return (
    <div className="quota-row" data-testid="quota-row" data-id={profile.id}>
      <Mark profile={profile} small />
      <span className="quota-name">
        <b>{profile.label}</b>
        <span className="channel-sub" title={now}>
          {usage ? "订阅用量" : "余额"} · {now}
        </span>
      </span>
      <label className="channel-hide">
        <input type="checkbox" checked={display.footer} onChange={(e) => onChange({ ...display, footer: e.target.checked })} aria-label={`在左下角显示 ${profile.label} 的额度`} data-testid="quota-footer" />
        左下角
      </label>
      {/* Focus no longer shows 额度 (2026-10-29 evening, the user); the setting's `focus` stays in the data, unused. */}
    </div>
  );
}
