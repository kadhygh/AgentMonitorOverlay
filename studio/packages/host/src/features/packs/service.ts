import type { Id, WorkspacePack, PackDocContent, TaskTemplateChoice, PackTemplate, PresetDraft } from "@amo-studio/protocol";
import { PACKS_DIR } from "@amo-studio/protocol";
import { PackError, PackLoader } from "../../packs/pack-loader.js";
import { presetDraft } from "../../packs/presets.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Extension packs (.amo/packs): documents, task templates, session presets. */
export class PacksFeature extends Feature {
  private readonly packLoader = new PackLoader();

  /** Extension packs found in a workspace (`.amo/packs`), valid or not. */
  packs(workspaceId: Id): WorkspacePack[] {
    return this.packLoader.list(this.requireWorkspace(workspaceId).path);
  }

  packDoc(workspaceId: Id, pack: string, docId: string): PackDocContent {
    try {
      return this.packLoader.readDoc(this.requireWorkspace(workspaceId).path, pack, docId);
    } catch (err) {
      if (err instanceof PackError) throw new HostError(err.kind, err.message);
      throw err;
    }
  }

  /** A pack's session preset filled in for a task, for the person to confirm; a workspace task uses its own workspace's packs. */
  presetDraft(workspaceId: Id, packName: string, presetId: string, taskId: unknown): PresetDraft {
    if (typeof taskId !== "string") throw new HostError("bad_request", "taskId is required");
    const task = this.requireTask(taskId);
    const workspace = this.requireWorkspace(workspaceId);
    if (task.workspaceId !== workspaceId) throw new HostError("bad_request", "a task takes presets from its own workspace");
    const pack = this.packs(workspaceId).find((p) => p.dirName === packName);
    if (!pack?.manifest) throw new HostError(pack ? "bad_request" : "not_found", pack ? `扩展包 ${packName} 有错误` : `扩展包 ${packName} 不存在`);
    const preset = pack.manifest.presets.find((p) => p.id === presetId);
    if (!preset) throw new HostError("not_found", `扩展包 ${packName} 里没有启动预设 ${presetId}`);
    // {{pack.dir}} is relative to the workspace (sessions run there), with forward slashes: short and the same on every OS.
    return presetDraft({ preset, packDir: `${PACKS_DIR}/${pack.dirName}`, workspace, taskTitle: task.title, profileIds: this.profiles.map((p) => p.id) });
  }

  /** A template of a valid pack in the task's own workspace. */
  packTemplate(workspaceId: Id, choice: TaskTemplateChoice): PackTemplate {
    const c = choice as Partial<TaskTemplateChoice> | null;
    if (!c || typeof c.workspaceId !== "string" || typeof c.pack !== "string" || typeof c.template !== "string") throw new HostError("bad_request", "template needs workspaceId, pack and template");
    if (c.workspaceId !== workspaceId) throw new HostError("bad_request", "a task takes templates from its own workspace");
    const pack = this.packs(c.workspaceId).find((p) => p.dirName === c.pack);
    if (!pack?.manifest) throw new HostError("bad_request", pack ? `扩展包 ${c.pack} 有错误` : `扩展包 ${c.pack} 不存在`);
    const template = pack.manifest.templates.find((t) => t.id === c.template);
    if (!template) throw new HostError("bad_request", `扩展包 ${c.pack} 里没有模板 ${c.template}`);
    return template;
  }
}
