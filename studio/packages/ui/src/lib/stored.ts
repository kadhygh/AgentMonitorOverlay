// What a window keeps per machine in localStorage (架构整理第 7 步, 2026-11-05): about thirty places each wrapped
// getItem / setItem / JSON.parse in their own try. Storage can be missing or full (then a choice lasts as long as the
// window) and a stored value can be from an older version or hand-edited (then it reads as nothing).

/** The stored text, or null when there is none or no storage. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`; null takes it away. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // no storage, or full: kept as long as the window
  }
}

/** The stored JSON, or undefined when there is none or it does not parse; check its shape before trusting it. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  writeStored(key, JSON.stringify(value));
}
