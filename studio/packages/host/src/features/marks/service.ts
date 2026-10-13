import { statSync } from "node:fs";
import { sep } from "node:path";
import { FILE_MARK_NOTE_MAX, isCommon, type FileMark, type FileMarkPatch, type Id, type NewFileMark, type Workspace } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Windows paths compare without case. */
const CASELESS = process.platform === "win32";

/** A path in the form marks compare by: no trailing separator (except a root), lowercase on Windows. */
export function pathKey(path: string): string {
  const trimmed = path.length > 3 ? path.replace(/[\\/]+$/, "") : path;
  return CASELESS ? trimmed.toLowerCase() : trimmed;
}

/** Whether `path` is `folder` or lies inside it (both absolute and normalised). */
export function isInside(path: string, folder: string): boolean {
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep);
}

/**
 * The project a path belongs to: the registered project whose folder holds it (the innermost when folders nest).
 * The common space is not a project the person sees, so files there count as 其他 (null).
 */
export function projectOf(path: string, workspaces: readonly Workspace[]): Id | null {
  let best: Workspace | null = null;
  for (const ws of workspaces) {
    if (isCommon(ws) || !isInside(path, ws.path)) continue;
    if (!best || ws.path.length > best.path.length) best = ws;
  }
  return best?.id ?? null;
}

/**
 * File marks (stage 12, S12-D): files and folders the person marked with a note, grouped by the project their path
 * lies in. Every change publishes `marks.changed`, so the marks window and the composers' @ lists follow.
 */
export class MarksFeature extends Feature {
  /** All marks, a project's, or (`"other"`) those outside every project; with whether each still exists. */
  list(workspace?: unknown): FileMark[] {
    this.rehome();
    let marks: FileMark[];
    if (workspace === undefined || workspace === null || workspace === "") marks = this.store.listFileMarks();
    else if (workspace === "other") marks = this.store.listFileMarks(null);
    else if (typeof workspace === "string") marks = this.store.listFileMarks(this.requireWorkspace(workspace).id);
    else throw new HostError("bad_request", "workspace must be a project id or other");
    return marks.map(withDisk);
  }

  create(input: Partial<NewFileMark> | undefined): { mark: FileMark; created: boolean } {
    const path = this.f.openIn.resolve(unquote(input?.path), input?.workspaceId);
    const disk = withDisk({ path } as FileMark);
    if (!disk.exists) throw new HostError("not_found", `文件不存在：${path}`);
    const { startLine, endLine } = this.range(input?.startLine ?? null, input?.endLine ?? null);
    if (disk.folder && startLine) throw new HostError("bad_request", "folders cannot have a line range");
    const key = pathKey(path);
    const same = this.store.listFileMarks().find((m) => pathKey(m.path) === key && m.startLine === startLine && m.endLine === endLine);
    if (same) return { mark: withDisk(same), created: false };
    const workspaceId = projectOf(path, this.store.listWorkspaces());
    // New marks go on top of their project.
    const first = this.store.listFileMarks(workspaceId)[0];
    const at = new Date().toISOString();
    const mark: FileMark = {
      id: newId("mark"),
      path,
      workspaceId,
      startLine,
      endLine,
      note: this.note(input?.note ?? ""),
      order: first ? first.order - 1 : 0,
      createdAt: at,
      updatedAt: at,
      exists: disk.exists,
      folder: disk.folder,
    };
    this.store.putFileMark(mark);
    this.changed(mark);
    return { mark, created: true };
  }

  update(id: Id, patch: Partial<FileMarkPatch> | undefined): FileMark {
    const current = this.require(id);
    const p = patch ?? {};
    let next: FileMark = { ...current };
    if (p.note !== undefined) next.note = this.note(p.note);
    if (p.startLine !== undefined || p.endLine !== undefined) {
      const range = this.range(p.startLine === undefined ? current.startLine : p.startLine, p.endLine === undefined ? (p.startLine === null ? null : current.endLine) : p.endLine);
      if (range.startLine && withDisk(current).folder) throw new HostError("bad_request", "folders cannot have a line range");
      const key = pathKey(current.path);
      if (this.store.listFileMarks().some((m) => m.id !== id && pathKey(m.path) === key && m.startLine === range.startLine && m.endLine === range.endLine)) {
        throw new HostError("conflict", "this file and range is marked already");
      }
      next = { ...next, ...range };
    }
    if (p.order !== undefined) {
      if (typeof p.order !== "number" || !Number.isFinite(p.order)) throw new HostError("bad_request", "order must be a number");
      next.order = Math.round(p.order);
    }
    next.updatedAt = new Date().toISOString();
    this.store.putFileMark(next);
    this.changed(next);
    return withDisk(next);
  }

  remove(id: Id): void {
    const mark = this.require(id);
    this.store.deleteFileMark(id);
    this.changed(mark);
  }

  private changed(mark: FileMark): void {
    this.publish({ type: "marks.changed", markId: mark.id, workspaceId: mark.workspaceId });
  }

  /** Marks of 其他 whose path a project added since now holds move into it. */
  private rehome(): void {
    const workspaces = this.store.listWorkspaces();
    for (const m of this.store.listFileMarks(null)) {
      const ws = projectOf(m.path, workspaces);
      if (ws) this.store.putFileMark({ ...m, workspaceId: ws });
    }
  }

  private require(id: Id): FileMark {
    const m = this.store.getFileMark(id);
    if (!m) throw new HostError("not_found", `file mark ${id} not found`);
    return m;
  }

  private note(v: unknown): string {
    if (typeof v !== "string") throw new HostError("bad_request", "note must be text");
    const note = v.trim();
    if (note.length > FILE_MARK_NOTE_MAX) throw new HostError("bad_request", `note is limited to ${FILE_MARK_NOTE_MAX} characters`);
    return note;
  }

  /** A line range: none, one line (`endLine` null or equal), or start ≤ end. */
  private range(start: unknown, end: unknown): { startLine: number | null; endLine: number | null } {
    const line = (v: unknown, name: string) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new HostError("bad_request", `${name} must be a line number`);
      return v;
    };
    const s = line(start, "startLine");
    const e = line(end, "endLine");
    if (!s) {
      if (e) throw new HostError("bad_request", "endLine needs startLine");
      return { startLine: null, endLine: null };
    }
    if (e !== null && e < s) throw new HostError("bad_request", "endLine is before startLine");
    return { startLine: s, endLine: e === s ? null : e };
  }
}

/** Pasted paths ("Copy as path" in Explorer quotes them). */
function unquote(v: unknown): unknown {
  return typeof v === "string" ? v.trim().replace(/^"(.*)"$/, "$1") : v;
}

function withDisk(mark: FileMark): FileMark {
  try {
    const info = statSync(mark.path);
    return { ...mark, exists: true, folder: info.isDirectory() };
  } catch {
    return { ...mark, exists: false, folder: !!mark.folder };
  }
}
