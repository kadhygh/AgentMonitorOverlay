import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { OPTIONAL_FEATURES, type AccountUsage, type CredentialStatus, type OptionalFeature, type ProfileChoices, type SessionPreset, type Id, type StudioSettings } from "@amo-studio/protocol";
import { localClaudeHome, localClaudeSignedIn, readClaudeLogin, writeClaudeLogin } from "../../runtime/claude/claude-login.js";
import { applyModelPrefs, readModelPrefs, writeModelPrefs } from "../../core/model-prefs.js";
import { newId } from "../../store/store.js";
import type { CredentialStore } from "../../runtime/credentials.js";
import { HostError, sessionOptions, boundedText, PRESETS_KEY, MAX_PRESETS, WRITABLE_CREDENTIALS, DISABLED_FEATURES_KEY } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Studio settings, 常用预设, model credentials, model choices and subscription usage. */
export class ConfigFeature extends Feature {
  settings(): StudioSettings {
    const dir = this.options.localClaudeHome ?? localClaudeHome();
    return {
      commonWorkspace: this.commonWorkspace(),
      presets: this.presets(),
      disabledFeatures: this.disabledFeatures(),
      scratchpadShortcut: this.f.scratchpad.shortcut(),
      claudeLogin: readClaudeLogin(this.store),
      claudeLocal: { dir, signedIn: localClaudeSignedIn(dir) },
      modelPrefs: readModelPrefs(this.store),
    };
  }

  /** Optional features the person turned off (设置 → 功能). */
  disabledFeatures(): OptionalFeature[] {
    const raw = this.store.getKv(DISABLED_FEATURES_KEY)?.value;
    if (!raw) return [];
    try {
      const ids = JSON.parse(raw) as unknown;
      return Array.isArray(ids) ? OPTIONAL_FEATURES.map((f) => f.id).filter((id) => ids.includes(id)) : [];
    } catch {
      return [];
    }
  }

  featureOn(id: OptionalFeature): boolean {
    return !this.disabledFeatures().includes(id);
  }

  private presets(): SessionPreset[] {
    const raw = this.store.getKv(PRESETS_KEY)?.value;
    if (!raw) return [];
    try {
      return JSON.parse(raw) as SessionPreset[];
    } catch {
      return [];
    }
  }

  /**
   * Moves the common space to another folder, replaces the 常用预设 list, turns optional features on or off, sets the
   * scratchpad shortcut (便签) and/or how the Claude subscription signs in (sessions started from then on).
   */
  updateSettings(input: { commonDir?: unknown; presets?: unknown; disabledFeatures?: unknown; scratchpadShortcut?: unknown; claudeLogin?: unknown; modelPrefs?: unknown }): StudioSettings {
    if (input.modelPrefs !== undefined) writeModelPrefs(this.store, this.profiles.map((p) => p.id), input.modelPrefs);
    if (input.claudeLogin !== undefined) {
      if (input.claudeLogin !== "token" && input.claudeLogin !== "local") throw new HostError("bad_request", "claudeLogin must be token or local");
      writeClaudeLogin(this.store, input.claudeLogin);
    }
    if (input.scratchpadShortcut !== undefined) this.f.scratchpad.setShortcut(input.scratchpadShortcut);
    if (input.disabledFeatures !== undefined) {
      const known = OPTIONAL_FEATURES.map((f) => f.id);
      const ids = input.disabledFeatures;
      if (!Array.isArray(ids) || ids.some((id) => !known.includes(id as OptionalFeature))) throw new HostError("bad_request", `disabledFeatures must list some of: ${known.join(", ")}`);
      this.store.setKv(DISABLED_FEATURES_KEY, JSON.stringify(known.filter((id) => ids.includes(id))));
    }
    if (input.presets !== undefined) {
      if (!Array.isArray(input.presets) || input.presets.length > MAX_PRESETS) throw new HostError("bad_request", `presets must be a list of at most ${MAX_PRESETS}`);
      const presets: SessionPreset[] = input.presets.map((p: unknown) => {
        const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
        const profileId = typeof o.profileId === "string" ? o.profileId : "";
        if (!this.profiles.some((x) => x.id === profileId)) throw new HostError("bad_request", `unknown profile ${profileId}`);
        return {
          id: typeof o.id === "string" && o.id ? o.id.slice(0, 64) : newId("pre"),
          name: boundedText(o.name, "name", 40),
          profileId,
          options: sessionOptions(o.options),
        };
      });
      this.store.setKv(PRESETS_KEY, JSON.stringify(presets));
    }
    if (input.commonDir !== undefined) {
      if (typeof input.commonDir !== "string" || !input.commonDir.trim()) throw new HostError("bad_request", "commonDir must be a folder path");
      const path = resolve(input.commonDir.trim());
      if (existsSync(path) && !statSync(path).isDirectory()) throw new HostError("bad_request", `not a directory: ${path}`);
      const common = this.commonWorkspace();
      const taken = this.store.findWorkspaceByPath(path);
      if (taken && taken.id !== common.id) throw new HostError("conflict", `这个文件夹已经是项目「${taken.name}」，不能再当公共目录`);
      mkdirSync(path, { recursive: true });
      this.publish({ type: "workspace.upserted", workspace: this.store.setWorkspacePath(common.id, path) });
    }
    const settings = this.settings();
    this.publish({ type: "settings.updated", settings });
    return settings;
  }

  /** The profile's models, efforts and permissions as its CLI offers them, in the person's order and with their defaults. */
  async choices(profileId: Id): Promise<ProfileChoices> {
    if (!this.profiles.some((p) => p.id === profileId)) throw new HostError("not_found", `profile ${profileId} not found`);
    const choices = await this.wrap(() => this.runtime.choices(profileId));
    return applyModelPrefs(choices, readModelPrefs(this.store)[profileId]);
  }

  /** Quota use of the subscription profiles (GPT login, Claude token), in profile order. */
  async usage(refresh: boolean): Promise<AccountUsage[]> {
    const out: AccountUsage[] = [];
    for (const p of this.profiles) {
      const u = this.runtime.usage ? await this.runtime.usage(p.id, refresh).catch(() => null) : null;
      if (u) out.push(u);
    }
    return out;
  }

  /** Which credentials the profiles need, and whether each is stored (the values never leave the Host). */
  credentials(): CredentialStatus[] {
    const reader = this.options.credentials;
    const ids = [...new Set(this.profiles.flatMap((p) => (p.credentialId ? [p.credentialId] : [])))];
    return ids.map((id) => ({
      id,
      usedBy: this.profiles.filter((p) => p.credentialId === id).map((p) => p.label),
      saved: !!reader?.read(id),
      writable: WRITABLE_CREDENTIALS.has(id) && !!reader && "write" in reader,
    }));
  }

  saveCredential(id: string, secret: unknown): CredentialStatus[] {
    const store = this.writableStore(id);
    const value = typeof secret === "string" ? secret.trim() : "";
    if (!value) throw new HostError("bad_request", "secret is required");
    if (value.length > 4096 || /\s/.test(value)) throw new HostError("bad_request", "这不像一个令牌：应是一整串不含空格和换行的字符");
    store.write(id, value);
    return this.credentials();
  }

  removeCredential(id: string): CredentialStatus[] {
    this.writableStore(id).remove(id);
    return this.credentials();
  }

  private writableStore(id: string): CredentialStore {
    const store = this.options.credentials;
    if (!WRITABLE_CREDENTIALS.has(id) || !store || !("write" in store)) throw new HostError("read_only", `credential ${id} cannot be changed from Studio`);
    return store;
  }
}
