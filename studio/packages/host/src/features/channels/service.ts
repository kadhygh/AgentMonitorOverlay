import type { ChannelBalance, ChannelInput, ClaudeCodeStatus, ModelChannel, ModelProfile } from "@amo-studio/protocol";
import { askBalance } from "../../runtime/balance.js";
import { claudeCodeStatus } from "../../runtime/claude/executable.js";
import { ChannelError, balanceConfig, type ChannelRegistry } from "../../runtime/channels.js";
import { listSiteModels } from "../../runtime/site-models.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/**
 * 设置 → 模型 (2026-10-15): the person's own channels (a third-party Claude or Codex endpoint), hiding any channel from
 * the model pickers, and asking a channel's site for its balance. Changes go out as `profiles.updated`.
 */
export class ChannelsFeature extends Feature {
  private readonly balances = new Map<string, { at: number; value: ChannelBalance }>();

  private get registry(): ChannelRegistry {
    const r = this.options.channels;
    if (!r) throw new HostError("read_only", "这个 Host 没有渠道设置");
    return r;
  }

  private run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ChannelError) throw new HostError(err.code, err.message);
      throw err;
    }
  }

  private changed(): void {
    this.publish({ type: "profiles.updated", profiles: this.f.allProfiles() });
  }

  list(): ModelChannel[] {
    return this.registry.list();
  }

  /** The Claude Code the Claude channels run on (none in the portable build until the person installs it). */
  claudeCode(): Promise<ClaudeCodeStatus> {
    return claudeCodeStatus();
  }

  /** Looks for Claude Code again: the channels on it become available, or unavailable, at once. */
  async checkClaudeCode(): Promise<ClaudeCodeStatus> {
    this.options.channels?.refresh();
    this.changed();
    return claudeCodeStatus();
  }

  create(input: ChannelInput): ModelChannel {
    const channel = this.run(() => this.registry.create(input));
    this.changed();
    return channel;
  }

  async update(id: string, input: ChannelInput): Promise<ModelChannel & { note?: string }> {
    const { channel, routingChanged } = this.run(() => this.registry.update(id, input));
    this.balances.delete(id);
    this.changed();
    if (routingChanged && channel.kind === "codex" && this.options.restartProfileServer) {
      const done = await this.options.restartProfileServer(id).catch(() => false);
      if (!done) return { ...channel, note: "这个渠道有会话正在运行，新的网址或 Key 等它们停下后、或下次启动 Studio 时生效" };
    }
    return channel;
  }

  remove(id: string): { ok: true } {
    const used = this.store.listSessions().filter((s) => s.profileId === id).length;
    if (used) throw new HostError("conflict", `有 ${used} 个会话用这个渠道，不能删除；可以勾选「在模型选择里隐藏」`);
    this.run(() => this.registry.remove(id));
    this.balances.delete(id);
    this.changed();
    return { ok: true };
  }

  setHidden(profileId: string, hidden: unknown): ModelProfile[] {
    if (typeof hidden !== "boolean") throw new HostError("bad_request", "hidden must be true or false");
    this.run(() => this.registry.setHidden(profileId, hidden));
    this.changed();
    return [...this.profiles];
  }

  /** The profile's balance, asked again at most once a minute unless `refresh`. */
  async balance(profileId: string, refresh: boolean): Promise<ChannelBalance> {
    this.requireProfile(profileId);
    const ask = this.registry.balanceOf(profileId);
    if (!ask) throw new HostError("not_found", "这个渠道没有设置余额查询");
    const cached = this.balances.get(profileId);
    if (cached && Date.now() - cached.at < (refresh ? 5_000 : 60_000)) return cached.value;
    const value = await askBalance({ profileId, ...ask });
    this.balances.set(profileId, { at: Date.now(), value });
    return value;
  }

  /** The 添加/编辑 dialog's 测试: a query with what is typed, filling in what `id` has stored. */
  async testBalance(input: Record<string, unknown>): Promise<ChannelBalance> {
    const id = typeof input.id === "string" && input.id ? input.id : undefined;
    const stored = id ? this.run(() => this.registry.get(id)) : null;
    const config = this.run(() => balanceConfig(input.balance));
    if (!config) throw new HostError("bad_request", "先选一个余额查询方式");
    const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : (stored?.baseUrl ?? "");
    const secrets = this.run(() =>
      this.registry.draftSecrets(id, {
        ...(typeof input.key === "string" ? { key: input.key } : {}),
        ...(typeof input.keyFrom === "string" ? { keyFrom: input.keyFrom } : {}),
        ...(typeof input.accessToken === "string" ? { accessToken: input.accessToken } : {}),
      }),
    );
    return askBalance({ profileId: id ?? "draft", baseUrl, config, ...secrets });
  }

  /** A DSH channel's 从网址读取: the model names its site lists, with what is typed or what `id` has stored. */
  async siteModels(input: Record<string, unknown>): Promise<{ models: string[] }> {
    const id = typeof input.id === "string" && input.id ? input.id : undefined;
    const stored = id ? this.run(() => this.registry.get(id)) : null;
    const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : (stored?.baseUrl ?? "");
    if (!baseUrl) throw new HostError("bad_request", "先填网址");
    const { key } = this.run(() =>
      this.registry.draftSecrets(id, {
        ...(typeof input.key === "string" ? { key: input.key } : {}),
        ...(typeof input.keyFrom === "string" ? { keyFrom: input.keyFrom } : {}),
      }),
    );
    if (!key) throw new HostError("bad_request", "先填 API Key");
    try {
      return { models: await listSiteModels(baseUrl, key) };
    } catch (err) {
      throw new HostError("bad_request", err instanceof Error ? err.message : String(err));
    }
  }
}
