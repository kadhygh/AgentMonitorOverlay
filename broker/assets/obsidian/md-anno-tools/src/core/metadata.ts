const AMO_MARKER_PATTERN = /<!--\s*amo:\s*(\{[\s\S]*?\})\s*-->/u;

export function parseAmoMetadata(markdown): Record<string, string> {
  return {
    ...parseAmoFrontmatterOnly(markdown),
    ...parseAmoMarker(markdown),
  };
}

export function parseAmoFrontmatter(markdown): Record<string, string> {
  return parseAmoMetadata(markdown);
}

export function parseAmoMarker(markdown): Record<string, string> {
  const match = String(markdown || "").slice(0, 4000).match(AMO_MARKER_PATTERN);
  if (!match) return {};

  try {
    const raw = JSON.parse(match[1]);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) continue;
      result[key] = String(value);
    }
    return result;
  } catch {
    return {};
  }
}

export function upsertAmoMarker(markdown, metadata): string {
  const nextMarker = renderAmoMarker(metadata);
  const source = String(markdown || "");
  if (AMO_MARKER_PATTERN.test(source.slice(0, 4000))) {
    return source.replace(AMO_MARKER_PATTERN, nextMarker);
  }

  const frontmatter = source.match(/^---\n[\s\S]*?\n---\n?/u);
  if (frontmatter) {
    const insertAt = frontmatter[0].length;
    return source.slice(0, insertAt) + "\n" + nextMarker + "\n" + source.slice(insertAt).replace(/^\n*/u, "");
  }

  return nextMarker + "\n\n" + source.replace(/^\n*/u, "");
}

export function renderAmoMarker(metadata): string {
  const allowedKeys = [
    "schemaVersion",
    "noteId",
    "workspaceId",
    "kind",
    "role",
    "sequence",
    "displayName",
    "displayTitle",
    "sessionId",
    "turnId",
    "tool",
  ];
  const marker = {};
  for (const key of allowedKeys) {
    const value = metadata && metadata[key];
    if (value === null || value === undefined || value === "") continue;
    marker[key] = value;
  }
  const json = JSON.stringify(marker).replace(/--/gu, "-\\u002d");
  return "<!-- amo: " + json + " -->";
}

export function removeAmoDisplayHeading(markdown, title, fallbackTitle = ""): string {
  const source = String(markdown || "").replace(/\r\n?/gu, "\n");
  const candidates = new Set(
    [normalizeMarkdownTitle(title), normalizeMarkdownTitle(fallbackTitle)].filter((value) => value.length > 0)
  );
  if (candidates.size === 0) return source;

  const frontmatter = source.match(/^---\n[\s\S]*?\n---\n*/u);
  const prefix = frontmatter ? frontmatter[0] : "";
  const body = source.slice(prefix.length);
  const marker = body.match(/^<!--\s*amo:\s*\{[\s\S]*?\}\s*-->\n*/u);
  const markerText = marker ? marker[0] : "";
  const afterMarker = body.slice(markerText.length);
  const leadingBlank = afterMarker.match(/^\n*/u)?.[0] || "";
  const rest = afterMarker.slice(leadingBlank.length);
  const heading = rest.match(/^#\s+(.+)\n*/u);
  if (!heading || !candidates.has(normalizeMarkdownTitle(heading[1]))) return source;

  return prefix + markerText.replace(/\n*$/u, "\n\n") + rest.slice(heading[0].length).replace(/^\n*/u, "");
}

export function normalizeMarkdownTitle(value): string {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").replace(/^#+\s*/u, "").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, 240);
}

function parseAmoFrontmatterOnly(markdown): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  let inAmo = false;
  for (const line of match[1].split(/\r?\n/u)) {
    if (/^amo:\s*$/u.test(line)) {
      inAmo = true;
      continue;
    }
    if (!inAmo) continue;
    if (/^\S/u.test(line)) break;

    const field = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (field) result[field[1]] = parseYamlScalar(field[2]);
  }

  return result;
}

export function parseYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "null") return "";
  if (trimmed.startsWith("\"")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}
