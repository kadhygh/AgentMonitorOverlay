import { useCallback, useEffect, useState } from "react";
import type { ChannelBalance, ModelProfile } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";

// Balances of the channels whose site tells them (设置 → 模型, 左下角额度, Focus), and the profile list kept live.

/** "$12.30", "¥8.05", "1200 次". */
export function money(n: number | null, unit: string): string {
  if (n === null) return "—";
  const v = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2);
  if (unit === "USD") return `$${v}`;
  if (unit === "CNY" || unit === "RMB") return `¥${v}`;
  return `${v} ${unit}`;
}

/** One line: "余额 $12.30" or "已用 $3.10 / $20.00"; the failure reason when it failed. */
export function balanceText(b: ChannelBalance): string {
  if (!b.ok) return b.message ?? "查询失败";
  if (b.remaining !== null) return `余额 ${money(b.remaining, b.unit)}${b.total !== null ? ` / ${money(b.total, b.unit)}` : ""}`;
  if (b.used !== null) return `已用 ${money(b.used, b.unit)}${b.total !== null ? ` / ${money(b.total, b.unit)}` : ""}`;
  return "没有数字";
}

/** The profile's balance; `refresh()` asks the site again. Nothing is asked for a profile without a balance query. */
export function useBalance(link: HostLink, profile: ModelProfile | undefined): { balance: ChannelBalance | null; loading: boolean; refresh(): void } {
  const [balance, setBalance] = useState<ChannelBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const id = profile?.balance ? profile.id : null;
  const load = useCallback(
    (refresh: boolean) => {
      if (!id || !link.url) return;
      setLoading(true);
      call(link, "GET /api/profiles/:id/balance", { id }, undefined, refresh ? { refresh: "1" } : {})
        .then(setBalance)
        .catch((err: unknown) =>
          setBalance({ profileId: id, ok: false, remaining: null, used: null, total: null, unit: "USD", planName: null, message: err instanceof HostApiError ? err.message : String(err), checkedAt: new Date().toISOString() }),
        )
        .finally(() => setLoading(false));
    },
    [link, id],
  );
  useEffect(() => {
    setBalance(null);
    load(false);
  }, [load]);
  return { balance, loading, refresh: () => load(true) };
}

/** This computer's own profiles: not the (hidden) models of remote tasks' computers (远程 step 2), only there for names. */
const own = (list: readonly ModelProfile[]): ModelProfile[] => list.filter((p) => p.runtime !== "remote");

/** Every model profile of this computer, following `profiles.updated`. */
export function useProfiles(link: HostLink): ModelProfile[] | null {
  const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
  useEffect(() => {
    let live = true;
    call(link, "GET /api/state")
      .then((s) => live && setProfiles(own(s.profiles)))
      .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type === "profiles.updated") setProfiles(own(e.profiles));
    });
    return () => {
      live = false;
      off();
    };
  }, [link]);
  return profiles;
}
