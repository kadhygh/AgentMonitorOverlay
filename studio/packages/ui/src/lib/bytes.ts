// One way to show a size (2026-11-05, 架构整理第 7 步): attachments, file previews, 便签 and the platform each had their
// own (whole KB or one decimal, GB or not). The user (11-04): one decimal everywhere, up to GB.

const UNITS = ["KB", "MB", "GB"] as const;

/** "512 B", "12.5 KB", "3.4 MB", "1.2 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(Number.isFinite(n) ? n : 0))} B`;
  let v = n / 1024;
  let i = 0;
  // 1023.96 KB would read "1024.0 KB": the next unit instead.
  while (i < UNITS.length - 1 && Number(v.toFixed(1)) >= 1024) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${UNITS[i]}`;
}
