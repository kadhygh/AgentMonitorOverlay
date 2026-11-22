// The models the 协作 scenario runs (the user, 2026-11-23: dxx-ds、gpt6.2sol、sonnet), each as a sandbox Host sets it up:
// a channel or a built-in profile, the session options, and the budget.json provider its turns count against.
// Keys are never read here: a channel with keyFrom reads old AMO's saved key from the Credential Manager itself; the
// Claude one is this computer's Claude Code login (as the person's Studio uses it).

export const MODELS = {
  // Codex on the DXX site (old AMO's DXX key, read only); the site lists gpt-6.2-sol (probe-models.mjs).
  "gpt6.2sol": {
    budget: "gpt",
    channel: { kind: "codex", label: "gpt6.2sol", baseUrl: "https://gorilla-api.dxxapi.com/v1", keyFrom: "dxx", model: "gpt-6.2-sol" },
    options: { permission: "full-auto" },
  },
  // Claude Code with this computer's login (the built-in subscription profile, local login), Sonnet.
  sonnet: {
    budget: "claude",
    profileId: "claude-subscription",
    options: { model: "sonnet", permission: "bypassPermissions" },
  },
  // DeepSeek through DSH (a DSH source clone, only run; Studio's own DSH home in the sandbox's data folder). The person's
  // 「Dxx-DS」 channel lives in their Studio's .data, which this never reads: it runs the built-in DeepSeek profile
  // instead (old AMO's deepseek-v4 key, read only), as dsh-real.integration.test.ts does, counted on deepseek
  // (中转迭代讨论 for the user, 2026-11-23: 选 1 … 报告里写明这次跑的是 DeepSeek 内置渠道，不是用户的 Dxx-DS 渠道).
  "dxx-ds": {
    budget: "deepseek",
    note: "DeepSeek 内置渠道（DSH），不是用户的 Dxx-DS 渠道",
    profileId: "dsh-deepseek",
    dsh: { path: process.env.AMO_STUDIO_DSH_CLONE || "G:\\PROJECT\\deepseek-harness" },
    options: { permission: "full-access" },
  },
};
