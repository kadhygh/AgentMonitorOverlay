import { useEffect, useState } from "react";

// 工作步骤展示 (DSH's transcript view): how much of the work the conversation shows. Stored per install, like the theme.

export type TranscriptView = "compact" | "standard" | "detailed" | "verbose";

export const TRANSCRIPT_VIEW_LABELS: Record<TranscriptView, string> = { compact: "简洁", standard: "标准", detailed: "详细", verbose: "完全展开" };
export const TRANSCRIPT_VIEW_HINTS: Record<TranscriptView, string> = {
  compact: "只看每段工作的类别，不显示思考预览",
  standard: "工作过程收成一行标题，运行中显示正在做什么",
  detailed: "运行中的工作逐条展开，完成后收起",
  verbose: "所有工作逐条展开，完成后也不收起",
};

const KEY = "amo.transcriptView";
const EVENT = "amo:transcript-view";

export function transcriptView(): TranscriptView {
  try {
    const v = localStorage.getItem(KEY);
    return v === "compact" || v === "detailed" || v === "verbose" || v === "standard" ? v : "standard";
  } catch {
    return "standard";
  }
}

export function setTranscriptView(view: TranscriptView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // private profile: still applies until reload
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: view }));
}

/** The current view, following changes made in this window (settings) or another (storage event). */
export function useTranscriptView(): TranscriptView {
  const [view, setView] = useState<TranscriptView>(transcriptView);
  useEffect(() => {
    const local = (e: Event) => setView((e as CustomEvent<TranscriptView>).detail);
    const other = (e: StorageEvent) => e.key === KEY && setView(transcriptView());
    window.addEventListener(EVENT, local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(EVENT, local);
      window.removeEventListener("storage", other);
    };
  }, []);
  return view;
}

// 发送后跳到最新 (2026-10-19): sending a message takes the conversation to its end, wherever it was being read, and
// keeps following the reply. On unless turned off in 设置 → 界面; stored per install like the view above.

const SEND_KEY = "amo.scrollOnSend";
const SEND_EVENT = "amo:scroll-on-send";

export function scrollOnSend(): boolean {
  try {
    return localStorage.getItem(SEND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setScrollOnSend(on: boolean): void {
  try {
    localStorage.setItem(SEND_KEY, on ? "on" : "off");
  } catch {
    // private profile: still applies until reload
  }
  window.dispatchEvent(new CustomEvent(SEND_EVENT, { detail: on }));
}

/** Whether sending jumps to the end, following changes made in this window (settings) or another (storage event). */
export function useScrollOnSend(): boolean {
  const [on, setOn] = useState(scrollOnSend);
  useEffect(() => {
    const local = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    const other = (e: StorageEvent) => e.key === SEND_KEY && setOn(scrollOnSend());
    window.addEventListener(SEND_EVENT, local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(SEND_EVENT, local);
      window.removeEventListener("storage", other);
    };
  }, []);
  return on;
}
