import type { ObsidianOpenResult, ObsidianPluginRuntime } from "../types";

export const OPEN_RESULT_CAPABILITY = "open-result-v1";

export function obsidianOpenAttemptRequestId(operationId: string, attempt: number) {
  const normalizedOperationId = operationId.trim();
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return normalizedAttempt === 1 ? normalizedOperationId : `${normalizedOperationId}-attempt-${normalizedAttempt}`;
}

export function supportsConfirmedObsidianOpen(runtime: ObsidianPluginRuntime | null | undefined) {
  return Boolean(runtime?.active && runtime.capabilities?.includes(OPEN_RESULT_CAPABILITY));
}

export function confirmedObsidianOpen(result: ObsidianOpenResult | null | undefined) {
  return Boolean(result?.ok && (result.status === "opened" || result.status === "focused"));
}

export function retryableObsidianOpenResult(result: ObsidianOpenResult | null | undefined) {
  return Boolean(
    result?.status === "rejected" && result.message?.toLowerCase().includes("targets a different vault"),
  );
}

export function shouldMarkReviewedForObsidianOpen(
  runtime: ObsidianPluginRuntime | null | undefined,
  result: ObsidianOpenResult | null | undefined,
) {
  return supportsConfirmedObsidianOpen(runtime) && confirmedObsidianOpen(result);
}
