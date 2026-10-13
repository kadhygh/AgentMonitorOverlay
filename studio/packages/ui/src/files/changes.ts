import type { FileDiff, SessionItem } from "@amo-studio/protocol";

// What a turn changed (stage 12, S12-C): the files its edit calls touched, with line counts and the diff of the turn,
// and a diff read as rows for the preview's 本轮改动 view.

/** One file a turn changed: its edits' diffs joined, counts summed. */
export interface ChangedFile extends FileDiff {
  /** How many edit calls touched it. */
  edits: number;
}

const keyOf = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** The files the turn's finished edit calls changed, in the order they were first touched. */
export function turnChanges(items: readonly SessionItem[]): ChangedFile[] {
  const files = new Map<string, ChangedFile & { first: FileDiff["change"] }>();
  for (const item of items) {
    if (item.type !== "tool" || item.status !== "completed" || !item.files?.length) continue;
    if ((item.kind ?? (item.name === "edit" || item.name === "write" ? "edit" : null)) !== "edit") continue;
    for (const f of item.files) {
      const key = keyOf(f.path);
      const cur = files.get(key);
      if (!cur) {
        files.set(key, { ...f, edits: 1, first: f.change });
        continue;
      }
      cur.added += f.added;
      cur.removed += f.removed;
      cur.edits++;
      if (f.diff) cur.diff = cur.diff ? `${cur.diff.replace(/\n$/, "")}\n${f.diff}` : f.diff;
      cur.change = f.change === "delete" ? "delete" : cur.first === "add" ? "add" : "update";
    }
  }
  return [...files.values()].map(({ first: _first, ...f }) => f);
}

export type DiffRowKind = "add" | "del" | "ctx" | "hunk";

/** One row of a diff, with the line it has in the new file when the diff tells (hunk headers). */
export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  newLine?: number;
}

/**
 * A unified diff as rows. Hunk headers (`@@ -1,4 +1,6 @@`) give the new file's line numbers; diffs without them (a
 * replaced block) have none. A new file whose "diff" is just its text shows every line as added.
 */
export function diffRows(file: Pick<FileDiff, "change" | "diff">): DiffRow[] {
  const lines = (file.diff ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (!file.diff) return [];
  const marked = lines.some((l) => /^[-+@]/.test(l));
  if (file.change === "add" && !marked) return lines.map((text, i) => ({ kind: "add", text, newLine: i + 1 }));
  const rows: DiffRow[] = [];
  let next: number | undefined;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\ ") || line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      next = m ? Number(m[1]) : undefined;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1) });
      continue;
    }
    const kind: DiffRowKind = line.startsWith("+") ? "add" : "ctx";
    const text = kind === "add" || line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ kind, text, ...(next !== undefined ? { newLine: next } : {}) });
    if (next !== undefined) next++;
  }
  return rows;
}
