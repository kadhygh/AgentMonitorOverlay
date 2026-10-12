import { renderPresetPrompt, safeRelativePath, type PackPreset, type PresetDraft } from "@amo-studio/protocol";
import { resolveInside } from "./pack-loader.js";

// A preset becomes a draft for the new-session form: the person sees (and may edit) the prompt, the model and the files
// before anything is sent. Context files are listed by path for the agent to read; their contents are not inlined.

export function presetDraft(input: {
  preset: PackPreset;
  packDir: string;
  workspace: { id: string; path: string };
  taskTitle: string;
  profileIds: readonly string[];
}): PresetDraft {
  const { preset, packDir, workspace } = input;
  const warnings: string[] = [];
  const files: string[] = [];
  for (const f of preset.contextFiles ?? []) {
    if (resolveInside(workspace.path, f)) files.push(safeRelativePath(f) ?? f);
    else warnings.push(`相关文件 ${f} 不存在，或指到了工作区外面，已略过`);
  }
  let profileId: string | null = null;
  if (preset.profile) {
    if (input.profileIds.includes(preset.profile)) profileId = preset.profile;
    else warnings.push(`没有模型配置 ${preset.profile}，改用默认模型`);
  }
  const prompt = renderPresetPrompt(preset.prompt, { "task.title": input.taskTitle || "（未命名任务）", "workspace.path": workspace.path, "pack.dir": packDir });
  const text = files.length ? `${prompt}\n\n相关文件（开始前请先阅读）：\n${files.map((f) => `- ${f}`).join("\n")}` : prompt;
  return { presetId: preset.id, title: preset.title, workspaceId: workspace.id, profileId, text, contextFiles: files, warnings };
}
