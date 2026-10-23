import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_VIEW_HIGHLIGHTS, type ViewHighlight } from "@amo-studio/protocol";
import { HostError } from "../../../core/shared.js";
import { common, lineNumber, optionalText, type ViewKindModule } from "./kind.js";

// A file as it is now, with the agent's 重点: lines it points the person at, each with why. The window reads the file
// when it shows it (the pack keeps the path, not the text), so it is always the latest.

export const fileKind: ViewKindModule<"file"> = {
  kind: "file",

  async check(input, ctx) {
    const path = ctx.relative(input.path, "path");
    const info = await stat(resolve(ctx.workspace.path, path)).catch(() => null);
    if (!info) throw new HostError("not_found", `file ${path} not found in ${ctx.workspace.name}`);
    if (!info.isFile()) throw new HostError("bad_request", `${path} is a folder, not a file`);
    const raw = input.highlights ?? [];
    if (!Array.isArray(raw)) throw new HostError("bad_request", "highlights must be a list");
    const highlights: ViewHighlight[] = raw.map((h, i) => highlight(h, `highlights[${i}]`));
    // A plain line or range to show: the first mark, without a note.
    const line = lineNumber(input.line, "line");
    if (line) highlights.unshift(highlight({ line, endLine: input.endLine }, "line"));
    else if (input.endLine !== undefined) throw new HostError("bad_request", "endLine goes with line");
    if (highlights.length > MAX_VIEW_HIGHLIGHTS) throw new HostError("bad_request", `at most ${MAX_VIEW_HIGHLIGHTS} highlights per file`);
    return { kind: "file", path, highlights, ...common(input) };
  },

  merge(prev, next) {
    if (prev.path !== next.path) return null;
    const key = (h: ViewHighlight) => `${h.line}-${h.endLine ?? h.line}-${h.note}`;
    const seen = new Set(prev.highlights.map(key));
    return {
      ...prev,
      ...(next.title ? { title: next.title } : {}),
      ...(next.note ? { note: next.note } : {}),
      highlights: [...prev.highlights, ...next.highlights.filter((h) => !seen.has(key(h)))].slice(0, MAX_VIEW_HIGHLIGHTS),
    };
  },
};

export function highlight(raw: unknown, name: string): ViewHighlight {
  const h = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const line = lineNumber(h.line, `${name}.line`);
  if (!line) throw new HostError("bad_request", `${name}.line is required`);
  const end = lineNumber(h.endLine, `${name}.endLine`);
  if (end !== undefined && end < line) throw new HostError("bad_request", `${name}.endLine must be at least its line`);
  const note = optionalText(h.note, `${name}.note`, 2000) ?? "";
  return { line, ...(end && end > line ? { endLine: end } : {}), note };
}
