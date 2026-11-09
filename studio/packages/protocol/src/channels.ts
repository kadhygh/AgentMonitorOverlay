import type { Id, ModelProfile, Timestamp } from "./entities.js";

// 设置 → 模型 (2026-10-15): the person's own model channels on top of the built-in ones — a third-party Claude endpoint
// (Anthropic-compatible, run by Claude Code) or a third-party Codex endpoint (Responses API, run by Codex), each with
// its address, key, and optionally how to ask the site for its balance (the templates CC Switch offers). Every
// channel, built in or not, can be hidden from the model pickers.

/** `dsh` (2026-10-19): a third-party DeepSeek endpoint run by DeepSeek Harness (its Anthropic-compatible address). */
export type ChannelKind = "claude" | "codex" | "dsh";

export const CHANNEL_KIND_LABEL: Record<ChannelKind, string> = { claude: "第三方 Claude", codex: "第三方 Codex", dsh: "第三方 DeepSeek" };

/**
 * How a balance is asked for (CC Switch's 用量查询 templates):
 * - `general`: GET {baseUrl}/user/balance with the key → `balance`.
 * - `newapi`: GET {site}/api/user/self with the panel's 系统访问令牌 and user id → `quota`/`used_quota` (÷500000 = USD).
 * - `sub2api`: GET {site}/v1/usage with the key → `remaining`, `quota.used`/`quota.limit`.
 * - `openai`: the old OpenAI billing endpoints many relays keep (`/v1/dashboard/billing/subscription` and `/usage`).
 * - `deepseek`: GET https://api.deepseek.com/user/balance.
 * - `custom`: any GET address (`{{baseUrl}}`, `{{apiKey}}` filled in) and where the numbers are in its JSON.
 * - `deepseek-account`: the built-in DeepSeek on the DSH desktop app's account (2026-11-09): DeepSeek Platform's own
 *   account summary with that sign-in. Studio's own, not offered for a channel.
 */
export type BalanceTemplate = "general" | "newapi" | "sub2api" | "openai" | "deepseek" | "deepseek-account" | "custom";

export const BALANCE_TEMPLATES: ReadonlyArray<{ id: BalanceTemplate; label: string; hint: string }> = [
  { id: "general", label: "通用", hint: "GET 网址/user/balance，用 API Key，读 balance" },
  { id: "newapi", label: "New API", hint: "New API / One API 面板：要面板里的系统访问令牌和用户 ID" },
  { id: "sub2api", label: "Sub2API", hint: "GET 网址/v1/usage，用 API Key" },
  { id: "openai", label: "OpenAI 计费接口", hint: "/v1/dashboard/billing/subscription 和 /usage，不少中转站保留了" },
  { id: "deepseek", label: "DeepSeek", hint: "DeepSeek 官方余额接口" },
  { id: "custom", label: "自定义", hint: "自己填查询地址和 JSON 里数字的位置" },
];

export interface BalanceConfig {
  template: BalanceTemplate;
  /** The site to ask when it is not the channel's address (New API: the panel's address). */
  url?: string;
  /** New API: the user id sent as `New-Api-User`. */
  userId?: string;
  /** custom: where the numbers are, as dotted paths into the JSON (`data.quota`, `balance_infos.0.total_balance`). */
  remainingPath?: string;
  usedPath?: string;
  totalPath?: string;
  /** custom: the numbers are divided by this (New API style quotas: 500000). */
  divisor?: number;
  /** custom: shown after the numbers; default USD. */
  unit?: string;
}

/** A channel as 设置 shows it. The key and the New API token stay in the Windows Credential Manager. */
export interface ModelChannel {
  /** Also the id of its model profile. */
  id: Id;
  kind: ChannelKind;
  label: string;
  baseUrl: string;
  /** The model new sessions start on; null = the CLI's default. */
  model: string | null;
  /**
   * DSH (2026-10-19): the site's own names for its DeepSeek models (`deepseek/deepseek-v4-pro`), offered instead of
   * DSH's built-in catalog, whose names a relay may not know; the first is the default when `model` is empty.
   */
  models?: string[];
  /** Claude: the model for background and quick work (ANTHROPIC_DEFAULT_HAIKU_MODEL); null = the CLI's default. */
  smallModel?: string | null;
  /** Claude: how the key is sent. "bearer" (ANTHROPIC_AUTH_TOKEN, most relays) or "x-api-key" (ANTHROPIC_API_KEY). */
  claudeAuth?: "bearer" | "x-api-key";
  keySaved: boolean;
  /** The key is old AMO's saved one (read only), e.g. "dxx"; null = the channel's own. */
  keyFrom: string | null;
  balance: BalanceConfig | null;
  /** New API: whether the 系统访问令牌 is saved. */
  accessTokenSaved: boolean;
  createdAt: Timestamp;
}

/**
 * 问题 #14 (2026-11-03): where a built-in channel that runs on the person's own CLI setup (Claude 订阅 on their Claude
 * Code, GPT on their Codex) sends its requests, read from that setup's files — tools like ccswitch change them.
 */
export interface ProfileEndpoint {
  /** The address requests go to; "" when the file names a provider without one. */
  url: string;
  /** Where it was read ("C:\…\settings.json 的 env.ANTHROPIC_BASE_URL"); null: nothing set, the CLI's own default. */
  from: string | null;
  /** The model the setup names (a model picked for a session goes before it); null: none named. */
  model: string | null;
  modelFrom: string | null;
  /** What else decides it (a project's own settings). */
  note: string;
  /** A file that could not be read, and why. */
  problem?: string;
  readAt: Timestamp;
}

/** What a create or an edit sends. Absent fields keep their value; `key`/`accessToken` "" removes it. */
export interface ChannelInput {
  kind?: ChannelKind;
  label?: string;
  baseUrl?: string;
  model?: string | null;
  /** DSH: the site's model names; [] = DSH's built-in ones. */
  models?: string[];
  smallModel?: string | null;
  claudeAuth?: "bearer" | "x-api-key";
  key?: string;
  /** Use old AMO's saved key with this id instead of the channel's own (only "dxx"). */
  keyFrom?: string | null;
  balance?: BalanceConfig | null;
  accessToken?: string;
}

/** Old AMO's saved keys a channel can reuse, and the address that went with them. */
export const AMO_CHANNEL_KEYS: ReadonlyArray<{ id: string; label: string; kind: ChannelKind; baseUrl: string }> = [
  { id: "dxx", label: "旧 AMO 的 DXX Key", kind: "codex", baseUrl: "https://gorilla-api.dxxapi.com" },
];

/** At most this many model names on a DSH channel. */
export const CHANNEL_MODELS_MAX = 30;

/** A channel's balance as last asked. Numbers are in `unit`. */
export interface ChannelBalance {
  profileId: Id;
  ok: boolean;
  remaining: number | null;
  used: number | null;
  total: number | null;
  unit: string;
  planName: string | null;
  /** Why it failed, or a note. */
  message: string | null;
  checkedAt: Timestamp;
}

// ---- Host routes (declared here, part of api.ts's HostRoutes) --------------------------------------------------

/** 设置 → 模型 (2026-10-15): the person's own channels, hiding a channel from the pickers, balances. */
export interface ChannelRoutes {
  "GET /api/channels": { req: void; res: ModelChannel[] };
  "POST /api/channels": { req: ChannelInput; res: ModelChannel };
  "PATCH /api/channels/:id": { req: ChannelInput; res: ModelChannel };
  /** Only a channel no session uses; otherwise hide it. */
  "DELETE /api/channels/:id": { req: void; res: { ok: true } };
  /** DSH channel (2026-10-19): the model names the site lists (GET {baseUrl}/v1/models), for the dialog's 从网址读取. */
  "POST /api/channels/models-test": { req: { id?: Id; baseUrl?: string; key?: string; keyFrom?: string | null }; res: { models: string[] } };
  /** Asks a balance with settings not saved yet (the 添加/编辑 dialog's 测试); `id` fills in what is stored. */
  "POST /api/channels/balance-test": { req: { id?: Id; kind?: ChannelKind; baseUrl?: string; balance: BalanceConfig; key?: string; keyFrom?: string | null; accessToken?: string }; res: ChannelBalance };
  "PUT /api/profiles/:id/hidden": { req: { hidden: boolean }; res: ModelProfile[] };
  /** `?refresh=1` asks the site again; otherwise the last answer within a minute. */
  "GET /api/profiles/:id/balance": { req: void; res: ChannelBalance };
  /** 问题 #14: Claude 订阅's and GPT's request address as the person's Claude Code / Codex setup has it; null for other profiles. */
  "GET /api/profiles/:id/endpoint": { req: void; res: ProfileEndpoint | null };
}
