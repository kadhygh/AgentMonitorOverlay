import { createContext, useContext, type ReactNode } from "react";
import type { OptionalFeature } from "@amo-studio/protocol";

// Optional features the person turned off in 设置 → 功能 (kept by the Host, so both windows and the agents' tools
// agree). Until the settings arrive everything counts as on, so nothing blinks away on a normal start.

const Disabled = createContext<readonly OptionalFeature[]>([]);

export function FeaturesProvider({ disabled, children }: { disabled: readonly OptionalFeature[] | undefined; children: ReactNode }) {
  return <Disabled.Provider value={disabled ?? []}>{children}</Disabled.Provider>;
}

/** Whether an optional feature is on. */
export function useFeature(id: OptionalFeature): boolean {
  return !useContext(Disabled).includes(id);
}

/** Whether a feature-tagged item (a view, a panel) shows. */
export function featureOn(disabled: readonly OptionalFeature[] | undefined, id: OptionalFeature | undefined): boolean {
  return !id || !(disabled ?? []).includes(id);
}
