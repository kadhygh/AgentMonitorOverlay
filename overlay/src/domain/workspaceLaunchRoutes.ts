import { CLAUDE_PROVIDER_DEFINITIONS, CODEX_PROVIDER_DEFINITIONS, GROK_PROVIDER_DEFINITIONS } from "../native/modelProviders";
import type { LaunchPanelAdapterId } from "./workspaceModel";

export function workspaceLaunchRoutes(adapter: LaunchPanelAdapterId) {
  const definitions = adapter === "codex-cli" ? CODEX_PROVIDER_DEFINITIONS
    : adapter === "claude-cli" ? CLAUDE_PROVIDER_DEFINITIONS : GROK_PROVIDER_DEFINITIONS;
  const groups: { id: string; title: string; models: typeof definitions[number][] }[] = [];
  for (const definition of definitions.filter(item => !item.hidden)) {
    const id = definition.id === "dxx-gpt-6-astra" ? "dxx"
      : definition.id === "deepseek-v4-pro" || definition.id.startsWith("deepseek-profile-") ? "deepseek-v4" : definition.id;
    let group = groups.find(item => item.id === id);
    if (!group) {
      group = { id, title: id === "dxx" ? "GPT-Dxx" : id === "deepseek-v4" ? "DeepSeek" : definition.title, models: [] };
      groups.push(group);
    }
    group.models.push(definition);
  }
  return groups;
}

export function workspaceLaunchModelLabel(model: string) {
  const names: Record<string, string> = {
    "gpt-5.6-sol": "GPT-5.6 Sol", "gpt-6-astra": "GPT-6 Astra",
    "deepseek-flash": "DeepSeek Flash",
    "deepseek-v4-pro": "DeepSeek V4 Pro", "deepseek-v4-pro[1m]": "DeepSeek V4 Pro",
    "deepseek-v4-flash": "DeepSeek V4 Flash", "glm-5.3[1m]": "GLM-5.3",
  };
  return names[model] || (model.startsWith("Local ") ? "沿用本机配置" : model);
}
