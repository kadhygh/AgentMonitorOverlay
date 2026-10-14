import { useCallback, useSyncExternalStore } from "react";

// Comment text not saved yet (S14-A): a new comment being written, or a saved one being edited. It lives here, not
// in the comment box, so it survives what redraws the box elsewhere: 只看改动 / 完整文件, 单栏 / 左右对照, the
// viewer's 文件 / 改动 (the rows move to other chunks, and React makes new boxes). Kept for the window's life.

const texts = new Map<string, string>();
const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** A new comment's box: one per project, file and line (`side:line`). */
export const newDraftKey = (workspaceId: string, path: string, rowKey: string) => `new\u0000${workspaceId}\u0000${path}\u0000${rowKey}`;
/** A saved comment being edited. */
export const editDraftKey = (commentId: string) => `edit\u0000${commentId}`;

export const draftText = (key: string): string | undefined => texts.get(key);

export function setDraftText(key: string, text: string): void {
  if (texts.get(key) === text) return;
  texts.set(key, text);
  changed();
}

export function dropDraft(key: string): void {
  if (texts.delete(key)) changed();
}

/** Whether a saved comment is being edited (its box stays open wherever it is drawn again). */
export function useEditing(commentId: string): boolean {
  const key = editDraftKey(commentId);
  const has = useCallback(() => texts.has(key), [key]);
  return useSyncExternalStore(subscribe, has, has);
}
