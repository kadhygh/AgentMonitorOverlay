import type { BalanceConfig, ChannelBalance } from "@amo-studio/protocol";
import { DSH_ACCOUNT_ORIGIN, readDshAccountGrant } from "./dsh/install.js";

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
  /** `deepseek-account`: the DSH desktop app's credentials file, read for its sign-in when asked. */
  accountFile?: string;
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

export interface Numbers {
  remaining: number | null;
  used: number | null;
  total: number | null;
  unit: string;
  planName?: string | null;
}

async function query(ask: BalanceAsk): Promise<Numbers> {
  const { config } = ask;
  const site = trimSlash(config.url || ask.baseUrl);
  if (!site && config.template !== "deepseek" && config.template !== "deepseek-account") throw new BalanceError("没有可查询的网址");
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
    case "deepseek-account": {
      // 设置 → 模型 → DeepSeek on「DSH 桌面版的账号」(2026-11-09, checked on the person's account that day): the
      // account summary DeepSeek Platform's own pages and the DSH desktop app read, with the app's sign-in. The token
      // goes only to Platform, as DSH sends it; the wallets are 充值 (normal) and 赠送 (bonus), amounts as strings.
      const grant = ask.accountFile ? readDshAccountGrant(ask.accountFile) : null;
      if (!grant) throw new BalanceError("DSH 桌面版还没有登录 DeepSeek 账号：打开 DeepSeek Harness 桌面版登录");
      if (grant.issuer !== DSH_ACCOUNT_ORIGIN) throw new BalanceError(`这个账号不是在 ${DSH_ACCOUNT_ORIGIN} 登录的，Studio 不把它的登录发到别处`);
      const j = await getJson(ask, `${DSH_ACCOUNT_ORIGIN}/api/v0/users/get_user_summary`, { "x-dsh-auth-token": grant.token }, { unauthorized: "DeepSeek 账号的登录过期了：打开 DSH 桌面版重新登录", noRedirect: true });
      if (pick(j, "code") !== 0 || pick(j, "data.biz_code") !== 0) throw new BalanceError(`DeepSeek 没有返回余额：${String(pick(j, "data.biz_msg") || pick(j, "msg") || "未知原因")}`.slice(0, 120));
      return accountWallets(pick(j, "data.biz_data"));
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

type Wallet = { currency: string; balance: number };

/** Platform's 充值 and 赠送 wallets: their sum in CNY (or the first currency there is); the 赠送 part and any other currency named. */
export function accountWallets(data: unknown): Numbers {
  const read = (path: string): Wallet[] => {
    const list = pick(data, path);
    return Array.isArray(list) ? list.flatMap((w: unknown) => (w && typeof w === "object" && typeof (w as Wallet).currency === "string" && num((w as { balance?: unknown }).balance) !== null ? [{ currency: (w as Wallet).currency, balance: num((w as { balance?: unknown }).balance)! }] : [])) : [];
  };
  const normal = read("normal_wallets");
  const bonus = read("bonus_wallets");
  if (!normal.length && !bonus.length) throw new BalanceError("返回里没有钱包余额");
  const all = [...normal, ...bonus];
  const unit = all.some((w) => w.currency === "CNY") ? "CNY" : all[0]!.currency;
  const sum = (ws: Wallet[]) => ws.filter((w) => w.currency === unit).reduce((n, w) => n + w.balance, 0);
  const gift = round(sum(bonus))!;
  const others = [...new Set(all.filter((w) => w.currency !== unit && w.balance !== 0).map((w) => w.currency))].map((c) => `${round(all.filter((w) => w.currency === c).reduce((n, w) => n + w.balance, 0))} ${c}`);
  const notes = [gift ? `含赠送 ${gift}` : "", others.length ? `另有 ${others.join("、")}` : ""].filter(Boolean);
  return { remaining: sum(normal) + sum(bonus), used: null, total: null, unit, planName: notes.length ? notes.join("，") : null };
}

/** `unauthorized`: what a 401 or 403 means here; `noRedirect`: a sign-in in the headers never follows a redirect elsewhere. */
async function getJson(ask: BalanceAsk, url: string, headers: Record<string, string>, opts: { unauthorized?: string; noRedirect?: boolean } = {}): Promise<unknown> {
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
    ...(opts.noRedirect ? { redirect: "error" as const } : {}),
    signal: AbortSignal.timeout(ask.timeoutMs ?? 10_000),
  }).catch((err: unknown) => {
    const name = err instanceof Error ? err.name : "";
    throw new BalanceError(name === "TimeoutError" || name === "AbortError" ? "查询超时（10 秒）" : opts.noRedirect ? `连不上 ${parsed.host}，或它要跳转到别处` : `连不上 ${parsed.host}`);
  });
  const text = await res.text();
  if ((res.status === 401 || res.status === 403) && opts.unauthorized) throw new BalanceError(opts.unauthorized);
  if (!res.ok) throw new BalanceError(`${parsed.host} 返回 ${res.status}${res.status === 401 || res.status === 403 ? "：Key 或令牌不对" : res.status === 404 ? "：这个站没有这个查询接口" : ""}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BalanceError(`${parsed.host} 返回的不是 JSON`);
  }
}
