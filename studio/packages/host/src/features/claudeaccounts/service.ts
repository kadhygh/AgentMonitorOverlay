import type { ClaudeAccountsState, HostErrorCode, Id } from "@amo-studio/protocol";
import { ClaudeAccounts } from "../../runtime/claude/accounts.js";
import { localClaudeHome } from "../../runtime/claude/claude-login.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/**
 * Claude 多账号 (2026-11-03): 设置 → 模型 → Claude adds accounts and signs them in; 额度 (bottom left) and that page
 * switch between them. The accounts themselves live in runtime/claude/accounts.ts, shared with the Claude runtime.
 */
export class ClaudeAccountsFeature extends Feature {
  private own: ClaudeAccounts | null = null;
  // Its changes reach the windows with the settings: ConfigFeature.watchClaudeAccounts (HostService starts it).

  /** The Host's, or (tests without a Claude runtime) one for the person's own dir only. */
  get accounts(): ClaudeAccounts {
    if (this.options.claudeAccounts) return this.options.claudeAccounts;
    const dir = this.options.localClaudeHome ?? localClaudeHome();
    this.own ??= new ClaudeAccounts(this.store, { defaultDir: dir, defaultExplicit: !!this.options.localClaudeHome });
    return this.own;
  }

  state(): ClaudeAccountsState {
    return this.accounts.state();
  }

  /** `signIn: false` only in test runs (AMO_STUDIO_TEST=1): the test writes the login itself, no browser opens. */
  add(label: unknown, signIn?: unknown): ClaudeAccountsState {
    const skip = signIn === false && process.env.AMO_STUDIO_TEST === "1";
    return this.run(() => this.accounts.add(typeof label === "string" ? label : "", { signIn: !skip }));
  }

  login(id: Id): ClaudeAccountsState {
    return this.run(() => this.accounts.login(id));
  }

  loginCode(id: Id, code: unknown): ClaudeAccountsState {
    if (typeof code !== "string") throw new HostError("bad_request", "code is required");
    return this.run(() => this.accounts.loginCode(id, code));
  }

  cancelLogin(id: Id): ClaudeAccountsState {
    return this.run(() => this.accounts.cancelLogin(id));
  }

  async refresh(id: Id): Promise<ClaudeAccountsState> {
    await this.runAsync(() => this.accounts.refresh(id));
    return this.state();
  }

  rename(id: Id, label: unknown): ClaudeAccountsState {
    if (typeof label !== "string") throw new HostError("bad_request", "label is required");
    return this.run(() => this.accounts.rename(id, label));
  }

  async switchTo(id: unknown): Promise<ClaudeAccountsState> {
    if (typeof id !== "string" || !id) throw new HostError("bad_request", "id is required");
    await this.runAsync(() => this.accounts.switchTo(id));
    return this.state();
  }

  remove(id: Id): ClaudeAccountsState {
    return this.run(() => this.accounts.remove(id));
  }

  private run(fn: () => unknown): ClaudeAccountsState {
    try {
      fn();
    } catch (err) {
      throw asHostError(err);
    }
    return this.state();
  }

  private async runAsync(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      throw asHostError(err);
    }
  }
}

function asHostError(err: unknown): HostError {
  if (err instanceof HostError) return err;
  const e = err as { code?: string; message?: string };
  const code: HostErrorCode = e.code === "bad_request" || e.code === "not_found" || e.code === "conflict" ? e.code : "runtime_error";
  return new HostError(code, e.message ?? String(err));
}
