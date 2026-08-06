import type { ObsidianOpenResult, ObsidianPluginRuntime } from "../types";

export const OPEN_RESULT_CAPABILITY = "open-result-v1";

export function supportsConfirmedObsidianOpen(runtime: ObsidianPluginRuntime | null | undefined) {
  return Boolean(runtime?.active && runtime.capabilities?.includes(OPEN_RESULT_CAPABILITY));
}

export function confirmedObsidianOpen(result: ObsidianOpenResult | null | undefined) {
  return Boolean(result?.ok && (result.status === "opened" || result.status === "focused"));
}

export function shouldMarkReviewedForObsidianOpen(
  runtime: ObsidianPluginRuntime | null | undefined,
  result: ObsidianOpenResult | null | undefined,
) {
  return supportsConfirmedObsidianOpen(runtime) && confirmedObsidianOpen(result);
}
