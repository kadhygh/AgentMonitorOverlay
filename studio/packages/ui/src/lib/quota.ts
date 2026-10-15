import { DEFAULT_QUOTA_DISPLAY, type QuotaDisplay, type StudioSettings } from "@amo-studio/protocol";

/** Where a profile's quota shows (设置 → 额度); the defaults until the person changes it. */
export function quotaOf(settings: StudioSettings | null, profileId: string): QuotaDisplay {
  return settings?.quotaDisplay?.[profileId] ?? DEFAULT_QUOTA_DISPLAY;
}
