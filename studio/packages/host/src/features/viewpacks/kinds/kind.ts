import { isAbsolute, relative, resolve } from "node:path";
import type { GitFileDiff, ViewItem, ViewItemInput, ViewItemKind, Workspace } from "@amo-studio/protocol";
import { HostError } from "../../../core/shared.js";

// What every kind of 查看包 item is on the Host side (2026-10-23): it checks what an agent sent and resolves it into
// the stored item, says when a later item is the same one (two quick calls about the same file make one item), and,
// for kinds shown as a diff the Host computes, gives it.

export interface KindContext {
  /** The pack's project. */
  workspace: Workspace;
  /** A path the agent gave, as the project-relative path (forward slashes); refused when outside the project. */
  relative(path: unknown, name: string): string;
}

type Of<K extends ViewItemKind> = Extract<ViewItem, { kind: K }>;

export interface ViewKindModule<K extends ViewItemKind = ViewItemKind> {
  kind: K;
  /** The item without its id; throws HostError on what cannot be shown. */
  check(input: ViewItemInput, ctx: KindContext): Promise<Omit<Of<K>, "id">>;
  /** `next` is about the same thing as `prev`: the two as one (keeping `prev`'s id); null when they differ. */
  merge(prev: Of<K>, next: Omit<Of<K>, "id">): Of<K> | null;
  /** A kind the window shows as a diff the Host works out (proposal). */
  diff?(item: Of<K>, ctx: KindContext): Promise<GitFileDiff>;
}

export function kindContext(workspace: Workspace): KindContext {
  return {
    workspace,
    relative(path, name) {
      if (typeof path !== "string" || !path.trim() || path.length > 1000 || /[\0\r\n]/.test(path)) throw new HostError("bad_request", `${name} must be a file path`);
      const rel = relative(workspace.path, resolve(workspace.path, path.trim())).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new HostError("bad_request", `${name} must be inside the project folder (${workspace.path})`);
      return rel;
    },
  };
}

/** An optional short text field. */
export function optionalText(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new HostError("bad_request", `${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw new HostError("bad_request", `${name} is longer than ${max} characters`);
  return t || undefined;
}

/** A 1-based line number, or undefined. */
export function lineNumber(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new HostError("bad_request", `${name} must be a positive whole number`);
  return v;
}

/** title and note, as every kind takes them. */
export function common(input: ViewItemInput): { title?: string; note?: string } {
  const title = optionalText(input.title, "title", 120);
  const note = optionalText(input.note, "note", 4000);
  return { ...(title ? { title } : {}), ...(note ? { note } : {}) };
}
