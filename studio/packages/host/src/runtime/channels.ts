import { randomBytes } from "node:crypto";
import { AMO_CHANNEL_KEYS, type BalanceConfig, type BalanceTemplate, type ChannelInput, type ChannelKind, type ModelChannel, type ModelOption, type ModelProfile } from "@amo-studio/protocol";
import type { ClaudeProviderDef } from "./claude/claude-env.js";
import { CLAUDE_BUILTIN_MODELS, CLAUDE_EFFORTS } from "./choices.js";
import type { CredentialReader, CredentialStore } from "./credentials.js";
import type { CodexProviderDef } from "./profiles.js";

// The model profiles as the Host runs them (设置 → 模型, 2026-10-15): the built-in ones, then the person's own channels
// — a third-party Claude endpoint run by Claude Code, or a third-party Codex endpoint (Responses API) run by Codex —
// each with a flag that leaves it out of the pickers. `profiles` and the provider tables are the very objects every
// runtime was given, changed in place, so a new channel is usable at once without restarting anything.
//
// Channel keys are Studio's own Credential Manager entries (`channel-<id>`, and `channel-<id>-access` for New API's
// 系统访问令牌); a channel can instead reuse an old AMO key (only DXX), which is then only read.

export const CHANNELS_KEY = "modelChannels";
export const HIDDEN_PROFILES_KEY = "hiddenProfiles";

interface StoredChannel {
  id: string;
  kind: ChannelKind;
  label: string;
  baseUrl: string;
  model: string | null;
  smallModel?: string | null;
  claudeAuth?: "bearer" | "x-api-key";
  keyFrom: string | null;
  balance: BalanceConfig | null;
  createdAt: string;
}

interface Kv {
  getKv(key: string): { value: string } | undefined;
  setKv(key: string, value: string): unknown;
}

export class ChannelError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "conflict" | "read_only",
    message: string,
  ) {
    super(message);
  }
}

const TEMPLATES: BalanceTemplate[] = ["general", "newapi", "sub2api", "openai", "deepseek", "custom"];
const keyId = (id: string) => `channel-${id.slice(3)}`;
const accessId = (id: string) => `channel-${id.slice(3)}-access`;
const codexProviderId = (id: string) => `amo-${id}`;
const isChannelId = (id: string) => /^ch-[0-9a-f]{8}$/.test(id);

function text(value: unknown, what: string, max: number, required = true): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (required && !v) throw new ChannelError("bad_request", `${what}不能为空`);
  if (v.length > max) throw new ChannelError("bad_request", `${what}最多 ${max} 个字`);
  return v;
}

function httpUrl(value: unknown, what: string): string {
  const v = text(value, what, 300);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ChannelError("bad_request", `${what}不是一个网址`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ChannelError("bad_request", `${what}要以 http:// 或 https:// 开头`);
  return v.replace(/\/+$/, "");
}

/** A model id: one word, no spaces. */
function modelId(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  const v = text(value, what, 100, false);
  if (/\s/.test(v)) throw new ChannelError("bad_request", `${what}不能有空格`);
  return v || null;
}

function secret(value: unknown, what: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length > 8192 || /\s/.test(v)) throw new ChannelError("bad_request", `这不像一个${what}：应是一整串不含空格和换行的字符`);
  return v;
}

export function balanceConfig(value: unknown): BalanceConfig | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new ChannelError("bad_request", "balance must be an object or null");
  const o = value as Record<string, unknown>;
  const template = o.template as BalanceTemplate;
  if (!TEMPLATES.includes(template)) throw new ChannelError("bad_request", `余额查询方式只能是 ${TEMPLATES.join("、")}`);
  const out: BalanceConfig = { template };
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (url) {
    // A custom address may carry {{baseUrl}}; check it with the placeholder filled.
    if (template === "custom") httpUrl(url.replaceAll("{{baseUrl}}", "https://x").replaceAll("{{apiKey}}", "k"), "查询地址");
    else httpUrl(url, "查询网址");
    out.url = url.slice(0, 300);
  }
  if (template === "custom" && !url) throw new ChannelError("bad_request", "自定义查询需要填查询地址");
  if (template === "newapi") {
    const userId = text(o.userId, "用户 ID", 40, false);
    if (userId) out.userId = userId;
  }
  if (template === "custom") {
    for (const k of ["remainingPath", "usedPath", "totalPath"] as const) {
      const p = text(o[k], "JSON 位置", 120, false);
      if (p) out[k] = p;
    }
    if (!out.remainingPath && !out.usedPath && !out.totalPath) throw new ChannelError("bad_request", "自定义查询至少要填一个数字的位置（剩余、已用或总额）");
    const d = typeof o.divisor === "number" ? o.divisor : Number(o.divisor);
    if (o.divisor !== undefined && o.divisor !== "" && (!Number.isFinite(d) || d <= 0)) throw new ChannelError("bad_request", "除数要是大于 0 的数");
    if (Number.isFinite(d) && d > 0 && d !== 1) out.divisor = d;
    const unit = text(o.unit, "单位", 10, false);
    if (unit) out.unit = unit;
  }
  return out;
}

export interface ChannelRegistryOptions {
  kv: Kv;
  credentials: CredentialReader | CredentialStore;
  builtins: readonly ModelProfile[];
  codexProviders: Record<string, CodexProviderDef>;
  claudeProviders: Record<string, ClaudeProviderDef>;
  /** Balance queries of built-in profiles (DeepSeek's own endpoint). */
  builtinBalance?: Record<string, { baseUrl: string; config: BalanceConfig }>;
  /** Why a built-in profile cannot start sessions now (a DSH profile with no clone set up), or undefined. */
  unavailable?: (profile: ModelProfile) => string | undefined;
}

export class ChannelRegistry {
  /** Every profile, built in first; the same array for the Host's whole life. */
  readonly profiles: ModelProfile[] = [];

  constructor(private readonly options: ChannelRegistryOptions) {
    this.rebuild();
  }

  get codexProviders(): Record<string, CodexProviderDef> {
    return this.options.codexProviders;
  }
  get claudeProviders(): Record<string, ClaudeProviderDef> {
    return this.options.claudeProviders;
  }

  list(): ModelChannel[] {
    return this.stored().map((c) => this.view(c));
  }

  get(id: string): ModelChannel {
    return this.view(this.require(id));
  }

  isChannel(profileId: string): boolean {
    return this.stored().some((c) => c.id === profileId);
  }

  create(input: ChannelInput): ModelChannel {
    const kind = input.kind;
    if (kind !== "claude" && kind !== "codex") throw new ChannelError("bad_request", "渠道类型只能是 claude 或 codex");
    let id: string;
    do id = `ch-${randomBytes(4).toString("hex")}`;
    while (this.profiles.some((p) => p.id === id));
    const channel: StoredChannel = {
      id,
      kind,
      label: text(input.label, "名字", 40),
      baseUrl: httpUrl(input.baseUrl, "网址"),
      model: modelId(input.model, "模型"),
      keyFrom: null,
      balance: balanceConfig(input.balance),
      createdAt: new Date().toISOString(),
    };
    if (kind === "claude") {
      channel.smallModel = modelId(input.smallModel, "快速模型");
      channel.claudeAuth = input.claudeAuth === "x-api-key" ? "x-api-key" : "bearer";
    }
    this.checkLabel(channel.label, id);
    this.applySecrets(channel, input);
    this.save([...this.stored(), channel]);
    return this.view(channel);
  }

  update(id: string, input: ChannelInput): { channel: ModelChannel; routingChanged: boolean } {
    const before = this.require(id);
    const c: StoredChannel = { ...before };
    if (input.kind !== undefined && input.kind !== c.kind) throw new ChannelError("bad_request", "渠道类型建好后不能改；新建一个渠道");
    if (input.label !== undefined) c.label = text(input.label, "名字", 40);
    if (input.baseUrl !== undefined) c.baseUrl = httpUrl(input.baseUrl, "网址");
    if (input.model !== undefined) c.model = modelId(input.model, "模型");
    if (c.kind === "claude") {
      if (input.smallModel !== undefined) c.smallModel = modelId(input.smallModel, "快速模型");
      if (input.claudeAuth !== undefined) c.claudeAuth = input.claudeAuth === "x-api-key" ? "x-api-key" : "bearer";
    }
    if (input.balance !== undefined) c.balance = balanceConfig(input.balance);
    this.checkLabel(c.label, id);
    const keyBefore = this.keyOf(before);
    this.applySecrets(c, input);
    this.save(this.stored().map((x) => (x.id === id ? c : x)));
    const routingChanged = c.baseUrl !== before.baseUrl || c.model !== before.model || c.label !== before.label || c.keyFrom !== before.keyFrom || this.keyOf(c) !== keyBefore;
    return { channel: this.view(c), routingChanged };
  }

  /** Removes the channel and its own saved keys; the caller checks no session uses it. */
  remove(id: string): void {
    const c = this.require(id);
    const store = this.writable();
    if (store) {
      store.remove(keyId(c.id));
      store.remove(accessId(c.id));
    }
    this.save(this.stored().filter((x) => x.id !== id));
  }

  setHidden(profileId: string, hidden: boolean): void {
    if (!this.profiles.some((p) => p.id === profileId)) throw new ChannelError("not_found", `profile ${profileId} not found`);
    const set = new Set(this.hidden());
    if (hidden) {
      const visible = this.profiles.filter((p) => !set.has(p.id) && p.id !== profileId);
      if (!visible.length) throw new ChannelError("conflict", "至少要留一个渠道在模型选择里");
      set.add(profileId);
    } else set.delete(profileId);
    this.options.kv.setKv(HIDDEN_PROFILES_KEY, JSON.stringify([...set]));
    this.rebuild();
  }

  /** What a balance query of this profile needs, or null when it has none. */
  balanceOf(profileId: string): { baseUrl: string; config: BalanceConfig; key: string | null; accessToken: string | null } | null {
    const c = this.stored().find((x) => x.id === profileId);
    if (c) return c.balance ? { baseUrl: c.baseUrl, config: c.balance, key: this.keyOf(c), accessToken: this.read(accessId(c.id)) } : null;
    const b = this.options.builtinBalance?.[profileId];
    if (!b) return null;
    const p = this.profiles.find((x) => x.id === profileId);
    return { ...b, key: p?.credentialId ? this.read(p.credentialId) : null, accessToken: null };
  }

  /** The key and New API token a draft (the dialog's 测试) would use, falling back to what `id` has stored. */
  draftSecrets(id: string | undefined, input: { key?: string; keyFrom?: string | null; accessToken?: string }): { key: string | null; accessToken: string | null } {
    const stored = id ? this.require(id) : null;
    const key = input.key?.trim() || (input.keyFrom ? this.read(this.amoKey(input.keyFrom)) : null) || (stored ? this.keyOf(stored) : null);
    const accessToken = input.accessToken?.trim() || (stored ? this.read(accessId(stored.id)) : null);
    return { key, accessToken };
  }

  // ---- internals ----

  private stored(): StoredChannel[] {
    const raw = this.options.kv.getKv(CHANNELS_KEY)?.value;
    if (!raw) return [];
    try {
      const list = JSON.parse(raw) as unknown;
      return Array.isArray(list) ? (list as StoredChannel[]).filter((c) => c && isChannelId(c.id) && (c.kind === "claude" || c.kind === "codex")) : [];
    } catch {
      return [];
    }
  }

  private hidden(): string[] {
    try {
      const list = JSON.parse(this.options.kv.getKv(HIDDEN_PROFILES_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private save(list: StoredChannel[]): void {
    this.options.kv.setKv(CHANNELS_KEY, JSON.stringify(list));
    this.rebuild();
  }

  private require(id: string): StoredChannel {
    const c = this.stored().find((x) => x.id === id);
    if (!c) throw new ChannelError("not_found", `渠道 ${id} 不存在`);
    return c;
  }

  private checkLabel(label: string, id: string): void {
    const taken = this.profiles.find((p) => p.id !== id && p.label === label && p.custom);
    if (taken) throw new ChannelError("conflict", `已经有叫「${label}」的渠道`);
  }

  private amoKey(from: string): string {
    if (!AMO_CHANNEL_KEYS.some((k) => k.id === from)) throw new ChannelError("bad_request", `不能沿用 ${from} 这个 Key`);
    return from;
  }

  private writable(): CredentialStore | null {
    const c = this.options.credentials;
    return "write" in c ? c : null;
  }

  private read(credentialId: string): string | null {
    try {
      return this.options.credentials.read(credentialId);
    } catch {
      return null;
    }
  }

  private keyOf(c: StoredChannel): string | null {
    return this.read(c.keyFrom ?? keyId(c.id));
  }

  /** Saves or removes the channel's own key and token, or points it at old AMO's key. */
  private applySecrets(c: StoredChannel, input: ChannelInput): void {
    if (input.keyFrom !== undefined) c.keyFrom = input.keyFrom ? this.amoKey(input.keyFrom) : null;
    const key = input.key !== undefined ? secret(input.key, "Key") : undefined;
    const token = input.accessToken !== undefined ? secret(input.accessToken, "令牌") : undefined;
    if (key === undefined && token === undefined) return;
    const store = this.writable();
    if (!store) throw new ChannelError("read_only", "这台电脑上不能保存 Key（没有 Windows 凭据管理器）");
    if (key !== undefined) {
      if (key) {
        store.write(keyId(c.id), key);
        c.keyFrom = null;
      } else store.remove(keyId(c.id));
    }
    if (token !== undefined) {
      if (token) store.write(accessId(c.id), token);
      else store.remove(accessId(c.id));
    }
  }

  private view(c: StoredChannel): ModelChannel {
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      baseUrl: c.baseUrl,
      model: c.model,
      ...(c.kind === "claude" ? { smallModel: c.smallModel ?? null, claudeAuth: c.claudeAuth ?? "bearer" } : {}),
      keySaved: !!this.keyOf(c),
      keyFrom: c.keyFrom,
      balance: c.balance,
      accessTokenSaved: !!this.read(accessId(c.id)),
      createdAt: c.createdAt,
    };
  }

  /** Recomputes the list after something it depends on changed outside the channels (the DSH clone). */
  refresh(): void {
    this.rebuild();
  }

  /** Rewrites the profile list and the provider tables in place from the built-ins and the stored channels. */
  private rebuild(): void {
    const channels = this.stored();
    const hidden = new Set(this.hidden());
    const { codexProviders, claudeProviders, builtins, builtinBalance } = this.options;
    for (const k of Object.keys(codexProviders)) if (/^amo-ch-/.test(k)) delete codexProviders[k];
    for (const k of Object.keys(claudeProviders)) if (/^ch-/.test(k)) delete claudeProviders[k];
    const next: ModelProfile[] = builtins.map((p) => {
      const unavailable = this.options.unavailable?.(p);
      return { ...p, ...(hidden.has(p.id) ? { hidden: true } : {}), ...(builtinBalance?.[p.id] ? { balance: true } : {}), ...(unavailable ? { unavailable } : {}) };
    });
    for (const c of channels) {
      const credentialId = c.keyFrom ?? keyId(c.id);
      const flags = { custom: true, ...(hidden.has(c.id) ? { hidden: true } : {}), ...(c.balance ? { balance: true } : {}) };
      if (c.kind === "codex") {
        const provider = codexProviderId(c.id);
        codexProviders[provider] = { name: c.label, baseUrl: c.baseUrl, wireApi: "responses", envKey: `AMO_${c.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY` };
        next.push({ id: c.id, label: c.label, runtime: "codex", provider, model: c.model, credentialId, ...flags });
      } else {
        claudeProviders[c.id] = {
          baseUrl: c.baseUrl,
          ...(c.claudeAuth === "x-api-key" ? { keyEnv: "ANTHROPIC_API_KEY" as const } : {}),
          ...(c.model ? { models: channelModels(c.model) } : {}),
          ...(c.smallModel ? { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: c.smallModel } } : {}),
        };
        next.push({ id: c.id, label: c.label, runtime: "claude", provider: c.id, model: c.model, credentialId, ...flags });
      }
    }
    this.profiles.splice(0, this.profiles.length, ...next);
  }
}

/** A Claude channel with its own model: that model first, then Claude Code's aliases (a relay usually serves both). */
function channelModels(model: string): ModelOption[] {
  return [{ id: model, label: model, efforts: CLAUDE_EFFORTS }, ...CLAUDE_BUILTIN_MODELS.filter((m) => m.id !== model && m.id !== "default").map(({ isDefault: _, ...m }) => m)];
}
