import { useEffect, useState } from "react";
import type { AccountUsage, ModelProfile, StudioSettings } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { balanceText, money, useBalance } from "../lib/balance.js";
import { quotaOf } from "../lib/quota.js";

// Focus's 额度 line (2026-10-15): the accounts 设置 → 额度 marks for Focus — what is left of each subscription (its
// tightest window) and each channel's balance — read again every few minutes.

const REFRESH_MS = 5 * 60_000;

/** The tightest window: "5 小时 剩 38%". */
function left(u: AccountUsage): { text: string; hot: boolean } {
  const known = u.windows.filter((w) => w.usedPercent !== null);
  if (!known.length) return { text: "—", hot: false };
  const w = known.reduce((a, b) => (b.usedPercent! > a.usedPercent! ? b : a));
  return { text: `剩 ${Math.max(0, 100 - w.usedPercent!)}%`, hot: w.usedPercent! >= 80 };
}

export function FocusQuota({ link, settings, profiles }: { link: HostLink; settings: StudioSettings | null; profiles: readonly ModelProfile[] }) {
  const shown = profiles.filter((p) => quotaOf(settings, p.id).focus);
  const [usage, setUsage] = useState<AccountUsage[]>([]);
  const any = shown.some((p) => !p.balance);
  useEffect(() => {
    if (!any || !link.url) return;
    const load = () =>
      void call(link, "GET /api/usage")
        .then(setUsage)
        .catch(() => undefined);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [link, any]);
  if (!shown.length) return null;
  return (
    <div className="focus-quota" data-testid="focus-quota">
      {shown.map((p) => {
        if (p.balance) return <BalanceItem key={p.id} link={link} profile={p} />;
        const u = usage.find((x) => x.profileId === p.id);
        if (!u) return null;
        const l = left(u);
        return (
          <span key={p.id} className={l.hot ? "focus-quota-item hot" : "focus-quota-item"} title={u.windows.map((w) => `${w.label} 已用 ${w.usedPercent ?? "—"}%`).join("\n") || (u.note ?? "")}>
            {p.label} {l.text}
          </span>
        );
      })}
    </div>
  );
}

function BalanceItem({ link, profile }: { link: HostLink; profile: ModelProfile }) {
  const { balance, refresh } = useBalance(link, profile);
  useEffect(() => {
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per profile
  }, [profile.id]);
  return (
    <span className={balance && !balance.ok ? "focus-quota-item bad" : "focus-quota-item"} title={balance ? balanceText(balance) : undefined}>
      {profile.label} {balance?.ok ? money(balance.remaining ?? balance.used, balance.unit) : "—"}
    </span>
  );
}
