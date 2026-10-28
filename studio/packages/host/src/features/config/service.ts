import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseRemoteProfileId, AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, MAX_PROJECT_GROUPS, MAX_QUICK_MODELS, MAX_SUBSESSION_NOTES, SUBSESSION_NOTE_MAX, type SubsessionNote, OPTIONAL_FEATURES, type ProjectGroup, type TopicGroup, type QuickModel, type AccountUsage, type CredentialStatus, type OptionalFeature, type ProfileChoices, type SessionPreset, type Id, type QuotaDisplay, type StudioSettings } from "@amo-studio/protocol";
import { localClaudeHome, localClaudeSignedIn } from "../../runtime/claude/claude-login.js";
import { readAutoCompact, readAutoCompactProfiles, writeAutoCompact, writeAutoCompactProfiles } from "../../runtime/compact.js";
import { applyModelPrefs, readModelPrefs, writeModelPrefs } from "../../core/model-prefs.js";
import { newId } from "../../store/store.js";
import type { CredentialStore } from "../../runtime/credentials.js";
import { HostError, sessionOptions, boundedText, PRESETS_KEY, MAX_PRESETS, WRITABLE_CREDENTIALS, DISABLED_FEATURES_KEY, QUOTA_DISPLAY_KEY, QUICK_MODELS_KEY, PROJECT_GROUPS_KEY, TOPIC_GROUPS_KEY, SUBSESSION_NOTES_KEY } from "../../core/shared.js";
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
      scratchpadSafeNewlines: this.f.scratchpad.safeNewlines(),
      autoCompactTokens: readAutoCompact(this.store),
      autoCompactProfiles: readAutoCompactProfiles(this.store),
      claudeLocal: { dir, signedIn: localClaudeSignedIn(dir) },
      modelPrefs: readModelPrefs(this.store),
      quotaDisplay: this.quotaDisplay(),
      quickModels: this.quickModels(),
      projectGroups: this.projectGroups(),
      topicGroups: this.topicGroups(),
      subsessionNotes: this.subsessionNotes(),
    };
  }

  /** 设置 → 子会话: the notes on models as sub-sessions, for accounts that still exist (the role card reads them). */
  subsessionNotes(): SubsessionNote[] {
    try {
      const v = JSON.parse(this.store.getKv(SUBSESSION_NOTES_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(v) ? (v as SubsessionNote[]).filter((n) => this.profiles.some((p) => p.id === n.profileId)) : [];
    } catch {
      return [];
    }
  }

  /** A new list of 子会话 notes: known accounts, one note per model, empty notes left out. */
  private checkSubsessionNotes(list: unknown): SubsessionNote[] {
    if (!Array.isArray(list) || list.length > MAX_SUBSESSION_NOTES) throw new HostError("bad_request", `subsessionNotes must be a list of at most ${MAX_SUBSESSION_NOTES}`);
    const out: SubsessionNote[] = [];
    for (const n of list as unknown[]) {
      const o = n && typeof n === "object" ? (n as Record<string, unknown>) : {};
      const profileId = typeof o.profileId === "string" ? o.profileId : "";
      if (!this.profiles.some((p) => p.id === profileId)) throw new HostError("bad_request", `unknown profile ${profileId}`);
      const model = o.model === null || o.model === undefined || o.model === "" ? null : typeof o.model === "string" && o.model.length <= 100 ? o.model : undefined;
      if (model === undefined) throw new HostError("bad_request", "subsessionNotes entries are { profileId, model: string | null, note }");
      const note = typeof o.note === "string" ? o.note.trim() : "";
      if (note.length > SUBSESSION_NOTE_MAX) throw new HostError("bad_request", `a note is limited to ${SUBSESSION_NOTE_MAX} characters`);
      if (note && !out.some((x) => x.profileId === profileId && x.model === model)) out.push({ profileId, model, note });
    }
    return out;
  }

  /** 项目分组, as saved (the UI leaves out projects that are gone or archived). */
  private projectGroups(): ProjectGroup[] {
    try {
      const v = JSON.parse(this.store.getKv(PROJECT_GROUPS_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(v) ? (v as ProjectGroup[]) : [];
    } catch {
      return [];
    }
  }

  /** Checks a new list of 项目分组: known projects only, each in one group (the first that names it). */
  private checkProjectGroups(list: unknown): ProjectGroup[] {
    if (!Array.isArray(list) || list.length > MAX_PROJECT_GROUPS) throw new HostError("bad_request", `projectGroups must be a list of at most ${MAX_PROJECT_GROUPS}`);
    const taken = new Set<Id>();
    const ids = new Set<Id>();
    return list.map((g: unknown) => {
      const o = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
      let id = typeof o.id === "string" && o.id ? o.id.slice(0, 64) : newId("pg");
      if (ids.has(id)) id = newId("pg");
      ids.add(id);
      const description = o.description === undefined || o.description === null || o.description === "" ? "" : boundedText(o.description, "description", 2000);
      if (o.workspaceIds !== undefined && !Array.isArray(o.workspaceIds)) throw new HostError("bad_request", "workspaceIds must be a list of project ids");
      const workspaceIds = ((o.workspaceIds as unknown[] | undefined) ?? []).filter((w): w is Id => {
        if (typeof w !== "string" || taken.has(w) || !this.store.getWorkspace(w)) return false;
        taken.add(w);
        return true;
      });
      return { id, name: boundedText(o.name, "name", 40), description, workspaceIds };
    });
  }

  /** 专题分组 (2026-10-27), as saved (the UI leaves out topics that are gone or archived). */
  private topicGroups(): TopicGroup[] {
    try {
      const v = JSON.parse(this.store.getKv(TOPIC_GROUPS_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(v) ? (v as TopicGroup[]) : [];
    } catch {
      return [];
    }
  }

  /** Checks a new list of 专题分组: known topics only, each in one group (the first that names it). */
  private checkTopicGroups(list: unknown): TopicGroup[] {
    if (!Array.isArray(list) || list.length > MAX_PROJECT_GROUPS) throw new HostError("bad_request", `topicGroups must be a list of at most ${MAX_PROJECT_GROUPS}`);
    const taken = new Set<Id>();
    const ids = new Set<Id>();
    return list.map((g: unknown) => {
      const o = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
      let id = typeof o.id === "string" && o.id ? o.id.slice(0, 64) : newId("tg");
      if (ids.has(id)) id = newId("tg");
      ids.add(id);
      const description = o.description === undefined || o.description === null || o.description === "" ? "" : boundedText(o.description, "description", 2000);
      if (o.topicIds !== undefined && !Array.isArray(o.topicIds)) throw new HostError("bad_request", "topicIds must be a list of topic ids");
      const topicIds = ((o.topicIds as unknown[] | undefined) ?? []).filter((t): t is Id => {
        if (typeof t !== "string" || taken.has(t) || !this.store.getTopic(t)) return false;
        taken.add(t);
        return true;
      });
      return { id, name: boundedText(o.name, "name", 40), description, topicIds };
    });
  }

  /** 设置 → 模型 → 快速选择, without profiles that are gone. */
  private quickModels(): QuickModel[] {
    try {
      const v = JSON.parse(this.store.getKv(QUICK_MODELS_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(v) ? (v as QuickModel[]).filter((q) => this.profiles.some((p) => p.id === q.profileId)) : [];
    } catch {
      return [];
    }
  }

  /** 设置 → 额度: per profile, whether its quota shows at the bottom of the left column and in Focus. */
  private quotaDisplay(): Record<string, QuotaDisplay> {
    try {
      const v = JSON.parse(this.store.getKv(QUOTA_DISPLAY_KEY)?.value ?? "{}") as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, QuotaDisplay>) : {};
    } catch {
      return {};
    }
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
  updateSettings(input: { commonDir?: unknown; presets?: unknown; disabledFeatures?: unknown; scratchpadShortcut?: unknown; modelPrefs?: unknown; scratchpadSafeNewlines?: unknown; quotaDisplay?: unknown; quickModels?: unknown; autoCompactTokens?: unknown; autoCompactProfiles?: unknown; projectGroups?: unknown; topicGroups?: unknown; subsessionNotes?: unknown }): StudioSettings {
    if (input.subsessionNotes !== undefined) this.store.setKv(SUBSESSION_NOTES_KEY, JSON.stringify(this.checkSubsessionNotes(input.subsessionNotes)));
    if (input.projectGroups !== undefined) this.store.setKv(PROJECT_GROUPS_KEY, JSON.stringify(this.checkProjectGroups(input.projectGroups)));
    if (input.topicGroups !== undefined) this.store.setKv(TOPIC_GROUPS_KEY, JSON.stringify(this.checkTopicGroups(input.topicGroups)));
    if (input.quickModels !== undefined) {
      const list = input.quickModels;
      if (!Array.isArray(list) || list.length > MAX_QUICK_MODELS) throw new HostError("bad_request", `quickModels must be a list of at most ${MAX_QUICK_MODELS}`);
      const out: QuickModel[] = [];
      for (const q of list as unknown[]) {
        const o = q && typeof q === "object" ? (q as Record<string, unknown>) : {};
        const profileId = typeof o.profileId === "string" ? o.profileId : "";
        if (!this.profiles.some((p) => p.id === profileId)) throw new HostError("bad_request", `unknown profile ${profileId}`);
        const model = o.model === null || o.model === undefined || o.model === "" ? null : typeof o.model === "string" && o.model.length <= 100 ? o.model : undefined;
        if (model === undefined) throw new HostError("bad_request", "quickModels entries are { profileId, model: string | null }");
        if (!out.some((x) => x.profileId === profileId && x.model === model)) out.push({ profileId, model });
      }
      this.store.setKv(QUICK_MODELS_KEY, JSON.stringify(out));
    }
    if (input.quotaDisplay !== undefined) {
      const patch = input.quotaDisplay;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HostError("bad_request", "quotaDisplay must map profile ids to { footer, focus } or null");
      const next = this.quotaDisplay();
      for (const [id, v] of Object.entries(patch as Record<string, unknown>)) {
        if (!this.profiles.some((p) => p.id === id)) throw new HostError("bad_request", `unknown profile ${id}`);
        if (v === null) delete next[id];
        else {
          const o = v as Record<string, unknown>;
          if (!o || typeof o.footer !== "boolean" || typeof o.focus !== "boolean") throw new HostError("bad_request", "quotaDisplay entries are { footer: boolean, focus: boolean }");
          next[id] = { footer: o.footer, focus: o.focus };
        }
      }
      this.store.setKv(QUOTA_DISPLAY_KEY, JSON.stringify(next));
    }
    if (input.modelPrefs !== undefined) writeModelPrefs(this.store, this.profiles.map((p) => p.id), input.modelPrefs);
    if (input.scratchpadShortcut !== undefined) this.f.scratchpad.setShortcut(input.scratchpadShortcut);
    if (input.scratchpadSafeNewlines !== undefined) this.f.scratchpad.setSafeNewlines(input.scratchpadSafeNewlines);
    if (input.autoCompactTokens !== undefined) {
      const n = input.autoCompactTokens;
      if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < AUTO_COMPACT_MIN || n > AUTO_COMPACT_MAX)) {
        throw new HostError("bad_request", `autoCompactTokens must be null or a whole number from ${AUTO_COMPACT_MIN} to ${AUTO_COMPACT_MAX}`);
      }
      writeAutoCompact(this.store, n);
    }
    if (input.autoCompactProfiles !== undefined) {
      try {
        writeAutoCompactProfiles(this.store, this.profiles.map((p) => p.id), input.autoCompactProfiles);
      } catch (err) {
        throw new HostError("bad_request", (err as Error).message);
      }
    }
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
    // A model of a remote task's device (远程 step 2): its list is that device's; here it has none to offer.
    if (parseRemoteProfileId(profileId)) return { profileId, models: [], permissions: [], defaultPermission: "", source: "builtin" };
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
    // The person's own channels keep their keys in their own cards (设置 → 模型 → 渠道).
    const ids = [...new Set(this.profiles.flatMap((p) => (p.credentialId && !p.custom ? [p.credentialId] : [])))];
    return ids.map((id) => ({
      id,
      usedBy: this.profiles.filter((p) => p.credentialId === id && !p.custom).map((p) => p.label),
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
