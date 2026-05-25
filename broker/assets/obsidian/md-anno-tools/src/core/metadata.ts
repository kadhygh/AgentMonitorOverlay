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

export function extractFirstMarkdownHeading(markdown): string {
  const source = String(markdown || "").replace(/\r\n?/gu, "\n");
  const frontmatter = source.match(/^---\n[\s\S]*?\n---\n*/u);
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  const lines = body.split("\n");
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/u);
    if (match) return normalizeMarkdownTitle(match[1]);
    if (line.trim() && !line.startsWith("<!--")) break;
  }
  return "";
}

export function upsertFirstMarkdownHeading(markdown, title): string {
  const cleanTitle = normalizeMarkdownTitle(title) || "AMO note";
  const source = String(markdown || "").replace(/\r\n?/gu, "\n");
  const frontmatter = source.match(/^---\n[\s\S]*?\n---\n*/u);
  const prefix = frontmatter ? frontmatter[0] : "";
  const body = source.slice(prefix.length);
  return prefix + upsertFirstMarkdownHeadingInBody(body, cleanTitle);
}

function upsertFirstMarkdownHeadingInBody(body, cleanTitle): string {
  const lines = String(body || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#\s+.+/u.test(line)) {
      lines[index] = "# " + cleanTitle;
      return lines.join("\n");
    }
    if (line.trim() && !line.trim().startsWith("<!--") && line.trim() !== "---") {
      break;
    }
  }

  const source = String(body || "");
  const marker = source.match(/^<!--\s*amo:\s*\{[\s\S]*?\}\s*-->\n*/u);
  if (marker) {
    return marker[0].replace(/\n*$/u, "\n\n") + "# " + cleanTitle + "\n\n" + source.slice(marker[0].length).replace(/^\n*/u, "");
  }

  return "# " + cleanTitle + "\n\n" + source.replace(/^\n*/u, "");
}

export function normalizeMarkdownTitle(value): string {
  return String(value || "")
    .replace(/\r?\n/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^#+\s*/u, "")
    .trim()
    .slice(0, 120);
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
