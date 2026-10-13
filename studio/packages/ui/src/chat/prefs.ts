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
