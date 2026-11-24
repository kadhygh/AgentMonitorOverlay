import type { AgyStatus } from "@amo-studio/protocol";
import { agyCandidates } from "@amo-studio/locate";
import { AGY_MODELS_KEY, agySignIn, readAgyCheck, readAgyModels, resolveAgy } from "../../runtime/agy/install.js";
import { agyOffered } from "../../runtime/agy/agy-runtime.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/**
 * 设置 → 模型 → Antigravity (2026-11-24, plans/agy.md): which agy Gemini sessions run on, whether it signed in,
 * 「检查」, 「登录 Google 账号」 and the models besides Gemini the person turned on (off by default).
 */
export class AgyFeature extends Feature {
  private loginState: AgyStatus["login"] = null;

  status(): AgyStatus {
    const runtime = this.options.agy;
    const env = runtime?.baseEnv() ?? process.env;
    const test = runtime?.testAgent();
    const resolved = test ? { path: test.args.at(-1) ?? test.command, version: "test" } : resolveAgy(env);
    const first = test ? undefined : agyCandidates(env)[0];
    return {
      exe: "error" in resolved ? (first ? { path: first, version: null } : null) : { path: resolved.path, version: resolved.version },
      unavailable: "error" in resolved ? resolved.error : null,
      signIn: test ? null : agySignIn(env),
      check: readAgyCheck(this.store),
      login: this.loginState,
      extraModels: readAgyModels(this.store),
      offered: agyOffered(runtime?.offered() ?? null),
    };
  }

  /** `extraModels`: ids of agy's models besides Gemini to offer in the pickers. */
  update(body: { extraModels?: unknown }): AgyStatus {
    if (body.extraModels !== undefined) {
      if (!Array.isArray(body.extraModels) || body.extraModels.some((x) => typeof x !== "string" || x.length > 200) || body.extraModels.length > 50) {
        throw new HostError("bad_request", "extraModels must be a list of model ids");
      }
      this.store.setKv(AGY_MODELS_KEY, JSON.stringify([...new Set(body.extraModels as string[])]));
      this.profilesChanged();
    }
    return this.status();
  }

  async check(): Promise<AgyStatus> {
    const runtime = this.options.agy;
    if (!runtime) throw new HostError("read_only", "这个 Host 没有 Antigravity 运行时");
    await runtime.check();
    this.profilesChanged();
    return this.status();
  }

  /**
   * agy's own Google sign-in: a browser window waits for the person, so it answers at once with `running` and goes on;
   * a 「检查」 follows a sign-in that went through, so the pickers get agy's models.
   */
  login(): AgyStatus {
    const runtime = this.options.agy;
    if (!runtime) throw new HostError("read_only", "这个 Host 没有 Antigravity 运行时");
    if (this.loginState?.state === "running") return this.status();
    const now = () => new Date().toISOString();
    this.loginState = { state: "running", at: now(), message: "在浏览器里登录 Google 账号（最多等 5 分钟）" };
    this.profilesChanged();
    void runtime
      .login()
      .then(async () => {
        this.loginState = { state: "done", at: now(), message: "已登录" };
        await runtime.check().catch(() => undefined);
      })
      .catch((err: unknown) => {
        this.loginState = { state: "failed", at: now(), message: `没有登录成功：${err instanceof Error ? err.message : String(err)}` };
      })
      .finally(() => this.profilesChanged());
    return this.status();
  }

  private profilesChanged(): void {
    this.options.channels?.refresh();
    this.publish({ type: "profiles.updated", profiles: this.host.allProfiles() });
  }
}
