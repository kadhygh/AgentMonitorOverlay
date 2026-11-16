import { useEffect, useState } from "react";

// 会话弹窗 as windows of their own (2026-11-17, the user: 脉络点击的弹窗要独立弹窗，不然会被限制拖动范围; app/src/round-window.ts):
// what the workbench hears about them and what such a window is asked to show. Pure, but for the hook.

/** An open 会话弹窗 window, as the shell tells the workbench (amo:rounds). */
export interface RoundInfo {
  id: number;
  taskId: string;
  sessionId: string;
  /** The building it was opened from (its own session, or the one that started `sessionId`). */
  towerFor: string;
  pinned: boolean;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The shell's list, the entries that are not one left out. */
export function roundList(v: unknown): RoundInfo[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r: Partial<RoundInfo> | null) =>
    r && typeof r.id === "number" && str(r.taskId) && str(r.sessionId) && str(r.towerFor) ? [{ id: r.id, taskId: r.taskId, sessionId: r.sessionId, towerFor: r.towerFor, pinned: r.pinned === true }] : [],
  );
}

/** The building's card stays marked while its window not pinned is open (closing it lets the card go, and back). */
export function cardWindowOpen(rounds: readonly RoundInfo[], towerFor: string): boolean {
  return rounds.some((r) => r.towerFor === towerFor && !r.pinned);
}

/**
 * The composer under the building steps aside while a window shows the building's own session (the user, 2026-11-16:
 * 弹窗开启时，下面的输入栏先隐藏，且输入栏的内容也展示到弹窗里); one of a session it started leaves it be.
 */
export function composerInWindow(rounds: readonly RoundInfo[], sessionId: string): boolean {
  return rounds.some((r) => r.sessionId === sessionId && r.towerFor === sessionId);
}

/** The open windows, kept current (none outside Studio, where there are no windows). */
export function useRoundWindows(): readonly RoundInfo[] {
  const [list, setList] = useState<readonly RoundInfo[]>([]);
  useEffect(() => {
    const api = window.amo?.round;
    if (!api) return;
    let live = true;
    const off = api.onList((v) => setList(roundList(v)));
    void api.list().then((v) => live && setList(roundList(v)));
    return () => {
      live = false;
      off();
    };
  }, []);
  return list;
}

/** What a 会话弹窗 window shows, from its address (#round?task=…&session=…&tower=…&item=…&title=…&n=…); null without a session. */
export interface RoundAsk {
  taskId: string;
  sessionId: string;
  towerFor: string;
  itemId: string | null;
  title: string;
  /** Changes each time a card is picked, the same one too: the window scrolls to it again. */
  nonce: string;
}

export function parseRoundHash(hash: string): RoundAsk | null {
  if (!hash.startsWith("#round")) return null;
  const q = new URLSearchParams(hash.split("?")[1] ?? "");
  const taskId = q.get("task");
  const sessionId = q.get("session");
  if (!taskId || !sessionId) return null;
  return { taskId, sessionId, towerFor: q.get("tower") || sessionId, itemId: q.get("item") || null, title: q.get("title") ?? "", nonce: q.get("n") ?? "" };
}

/** 到对话里看 from a window (amo:round-chat): the session and row the workbench shows, or null when it is not one. */
export function roundChatTarget(v: unknown): { taskId: string; sessionId: string; towerFor: string; itemId?: string } | null {
  const t = v as { taskId?: unknown; sessionId?: unknown; towerFor?: unknown; itemId?: unknown } | null;
  if (!str(t?.taskId) || !str(t?.sessionId) || !str(t?.towerFor)) return null;
  return { taskId: t.taskId, sessionId: t.sessionId, towerFor: t.towerFor, ...(str(t.itemId) ? { itemId: t.itemId } : {}) };
}
