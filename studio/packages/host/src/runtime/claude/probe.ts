import { query, type SDKUserMessage, type SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption, ModelProfile } from "@amo-studio/protocol";

// Starting Claude Code with no prompt just to ask it something (stage 16 split out of claude-runtime.ts): no model
// request is made, and the process is closed right after.

/** The settings files Claude Code reads in a terminal (the SDK reads none unless told). */
export const CLI_SETTING_SOURCES: Array<"user" | "project" | "local"> = ["user", "project", "local"];

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref?.())]);
}

async function asking<T>(options: Parameters<typeof query>[0]["options"], ask: (q: ReturnType<typeof query>) => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  async function* none(): AsyncGenerator<SDKUserMessage> {
    await gate;
  }
  const q = query({ prompt: none(), options });
  try {
    return await ask(q);
  } finally {
    release();
    q.close();
  }
}

/** Claude Code's model list for the account. */
export function askModels(profile: ModelProfile, env: Record<string, string | undefined>, cwd: string): Promise<ModelOption[]> {
  return asking({ cwd, env, settingSources: [], permissionMode: "default" }, async (q) => {
    const list = await withTimeout(q.supportedModels(), 20_000);
    return list.map((m) => ({
      id: m.value,
      label: m.value === "default" ? `默认（${m.resolvedModel ?? m.displayName}）` : m.displayName,
      ...(m.description ? { description: m.description } : {}),
      efforts: m.supportedEffortLevels ?? [],
      ...((profile.model ? m.value === profile.model : m.value === "default") ? { isDefault: true } : {}),
    }));
  });
}

/** Claude Code's commands and skills in a project folder (its settings and skills read as in a terminal). */
export function askCommands(env: Record<string, string | undefined>, cwd: string): Promise<SdkSlashCommand[]> {
  return asking({ cwd, env, settingSources: CLI_SETTING_SOURCES, permissionMode: "default" }, (q) => withTimeout(q.supportedCommands(), 20_000));
}
