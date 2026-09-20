/**
 * Registry-version helpers for the Harness Lab version catalogue.
 *
 * The backend validates every registry version with a real semver parse before
 * it reaches the frontend, so these helpers only need to order well-formed
 * versions, including prerelease identifiers (alpha/rc cycles mix freely in
 * the @deepseek-ai/dsh release history).
 */

/** Semver ordering: negative when `left` is older, positive when newer, 0 when equal. */
export function compareRegistryVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4]?.split(".").filter((part) => part !== "") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const length = Math.min(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const partA = a.pre[index];
    const partB = b.pre[index];
    if (partA === partB) continue;
    const numericA = /^\d+$/.test(partA);
    const numericB = /^\d+$/.test(partB);
    if (numericA && numericB) return Number(partA) - Number(partB);
    if (numericA) return -1;
    if (numericB) return 1;
    return partA < partB ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

/** "2026-09-17T13:52:10.201Z" -> "2026-09-17 13:52 UTC" for compact version rows. */
export function formatPublishTime(iso: string): string {
  if (!iso.includes("T")) return iso;
  const compact = iso.slice(0, 16).replace("T", " ");
  return compact ? `${compact} UTC` : iso;
}
