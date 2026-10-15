import type { BalanceConfig, ChannelBalance } from "@amo-studio/protocol";

// Asking a model site for its balance, the way CC Switch's 用量查询 templates do (src/components/UsageScriptModal.tsx
// there). Only GET requests to the address the person gave; the key goes in a header and never into a message.

export interface BalanceAsk {
  profileId: string;
  /** The channel's address (`{{baseUrl}}`). */
  baseUrl: string;
  config: BalanceConfig;
  key: string | null;
  /** New API's 系统访问令牌. */
  accessToken?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class BalanceError extends Error {}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");
/** The site without a trailing `/v1`, for endpoints that add their own. */
const siteOf = (url: string) => trimSlash(url).replace(/\/v1$/i, "");

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** `data.quota`, `balance_infos.0.total_balance`. */
export function pick(json: unknown, path: string | undefined): unknown {
  if (!path?.trim()) return undefined;
  let cur: unknown = json;
  for (const part of path.trim().split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

export async function askBalance(ask: BalanceAsk): Promise<ChannelBalance> {
  const at = new Date().toISOString();
  const base = { profileId: ask.profileId, checkedAt: at };
  try {
    const r = await query(ask);
    return { ...base, ok: true, remaining: round(r.remaining), used: round(r.used), total: round(r.total), unit: r.unit, planName: r.planName ?? null, message: null };
  } catch (err) {
    const message = err instanceof BalanceError ? err.message : `查询失败：${err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err)}`;
    return { ...base, ok: false, remaining: null, used: null, total: null, unit: ask.config.unit || "USD", planName: null, message: message.slice(0, 200) };
  }
}

interface Numbers {
  remaining: number | null;
  used: number | null;
  total: number | null;
  unit: string;
  planName?: string | null;
}

async function query(ask: BalanceAsk): Promise<Numbers> {
  const { config } = ask;
  const site = trimSlash(config.url || ask.baseUrl);
  if (!site && config.template !== "deepseek") throw new BalanceError("没有可查询的网址");
  const bearer = (token: string | null | undefined, what = "API Key") => {
    if (!token) throw new BalanceError(`还没有保存${what}`);
    return { Authorization: `Bearer ${token}` };
  };
  switch (config.template) {
    case "general": {
      const j = await getJson(ask, `${site}/user/balance`, bearer(ask.key));
      const remaining = num(pick(j, "balance"));
      if (remaining === null) throw new BalanceError("返回里没有 balance");
      return { remaining, used: null, total: null, unit: "USD" };
    }
    case "deepseek": {
      const j = await getJson(ask, "https://api.deepseek.com/user/balance", bearer(ask.key));
      const info = (pick(j, "balance_infos") as Array<Record<string, unknown>> | undefined)?.[0];
      const remaining = num(info?.total_balance);
      if (remaining === null) throw new BalanceError("返回里没有 balance_infos");
      return { remaining, used: null, total: null, unit: String(info?.currency ?? "CNY"), planName: pick(j, "is_available") === false ? "余额不足" : null };
    }
    case "newapi": {
      if (!config.userId?.trim()) throw new BalanceError("New API 需要填用户 ID");
      const j = (await getJson(ask, `${siteOf(site)}/api/user/self`, { ...bearer(ask.accessToken, "系统访问令牌"), "New-Api-User": config.userId.trim() })) as Record<string, unknown>;
      if (!j.success || !j.data) throw new BalanceError(String(j.message || "New API 没有返回账户信息"));
      const quota = num(pick(j, "data.quota"));
      const used = num(pick(j, "data.used_quota"));
      const remaining = quota === null ? null : quota / 500000;
      const spent = used === null ? null : used / 500000;
      const group = pick(j, "data.group");
      return { remaining, used: spent, total: remaining !== null && spent !== null ? remaining + spent : null, unit: "USD", planName: typeof group === "string" && group ? group : null };
    }
    case "sub2api": {
      const j = (await getJson(ask, `${siteOf(site)}/v1/usage`, bearer(ask.key))) as Record<string, unknown>;
      if (j.isValid === false) throw new BalanceError(String(j.status || "这个 Key 无效"));
      const quota = (j.quota ?? {}) as Record<string, unknown>;
      const limit = num(quota.limit);
      const used = num(quota.used);
      const remaining = num(j.remaining) ?? num(quota.remaining) ?? (limit !== null && used !== null ? limit - used : null);
      return { remaining, used, total: limit && limit > 0 ? limit : null, unit: String(j.unit ?? quota.unit ?? "USD"), planName: typeof j.planName === "string" ? j.planName : null };
    }
    case "openai": {
      const root = siteOf(site);
      const sub = await getJson(ask, `${root}/v1/dashboard/billing/subscription`, bearer(ask.key));
      const total = num(pick(sub, "hard_limit_usd")) ?? num(pick(sub, "system_hard_limit_usd"));
      if (total === null) throw new BalanceError("返回里没有 hard_limit_usd");
      const now = new Date();
      const start = new Date(now.getTime() - 99 * 86400_000).toISOString().slice(0, 10);
      const end = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10);
      const usage = await getJson(ask, `${root}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`, bearer(ask.key));
      const cents = num(pick(usage, "total_usage"));
      const used = cents === null ? null : cents / 100;
      return { remaining: used === null ? null : total - used, used, total, unit: "USD" };
    }
    case "custom": {
      const raw = config.url?.trim();
      if (!raw) throw new BalanceError("自定义查询需要填查询地址");
      const url = raw.replaceAll("{{baseUrl}}", trimSlash(ask.baseUrl)).replaceAll("{{apiKey}}", encodeURIComponent(ask.key ?? ""));
      const j = await getJson(ask, url, ask.key ? { Authorization: `Bearer ${ask.key}` } : {});
      const d = config.divisor && config.divisor > 0 ? config.divisor : 1;
      const at = (path: string | undefined) => {
        const n = num(pick(j, path));
        return n === null ? null : n / d;
      };
      const remaining = at(config.remainingPath);
      const used = at(config.usedPath);
      const total = at(config.totalPath);
      if (remaining === null && used === null && total === null) throw new BalanceError("按填的位置在返回里找不到数字");
      return { remaining: remaining ?? (total !== null && used !== null ? total - used : null), used, total, unit: config.unit?.trim() || "USD" };
    }
    default:
      throw new BalanceError(`不认识的查询方式 ${String((config as { template?: unknown }).template)}`);
  }
}

async function getJson(ask: BalanceAsk, url: string, headers: Record<string, string>): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BalanceError("查询地址不是一个网址");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new BalanceError("查询地址要以 http:// 或 https:// 开头");
  const res = await (ask.fetch ?? fetch)(parsed, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "amo-studio/1.0", ...headers },
    signal: AbortSignal.timeout(ask.timeoutMs ?? 10_000),
  }).catch((err: unknown) => {
    const name = err instanceof Error ? err.name : "";
    throw new BalanceError(name === "TimeoutError" || name === "AbortError" ? "查询超时（10 秒）" : `连不上 ${parsed.host}`);
  });
  const text = await res.text();
  if (!res.ok) throw new BalanceError(`${parsed.host} 返回 ${res.status}${res.status === 401 || res.status === 403 ? "：Key 或令牌不对" : res.status === 404 ? "：这个站没有这个查询接口" : ""}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BalanceError(`${parsed.host} 返回的不是 JSON`);
  }
}
