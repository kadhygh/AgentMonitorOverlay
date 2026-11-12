import { DEFAULT_QUOTA_DISPLAY, type AccountUsage, type QuotaDisplay, type StudioSettings, type UsageWindow } from "@amo-studio/protocol";

/** Where a profile's quota shows (设置 → 额度); the defaults until the person changes it. */
export function quotaOf(settings: StudioSettings | null, profileId: string): QuotaDisplay {
  return settings?.quotaDisplay?.[profileId] ?? DEFAULT_QUOTA_DISPLAY;
}

/**
 * The windows to show: a model's own weekly limit (Fable 每周…) only when 设置 → 额度 turns those on for the profile
 * (the user, 2026-11-13: 做成设置选项，打开才会显示).
 */
export function shownWindows(settings: StudioSettings | null, u: AccountUsage): UsageWindow[] {
  return quotaOf(settings, u.profileId).modelWeekly ? u.windows : u.windows.filter((w) => !w.model);
}
