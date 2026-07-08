import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  BROKER_DEBUG_LOGS_URL,
  BROKER_DEBUG_URL,
  postBrokerJson,
} from "../api/brokerClient";
import type { BrokerDebugStatus } from "../types";

export function useDebugLogging() {
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugCount, setDebugCount] = useState(0);
  const [debugBusy, setDebugBusy] = useState(false);
  const debugEnabledRef = useRef(debugEnabled);
  const debugCountRef = useRef(debugCount);
  const feedbackSetterRef = useRef<Dispatch<SetStateAction<string>> | null>(null);

  useEffect(() => {
    debugEnabledRef.current = debugEnabled;
  }, [debugEnabled]);

  useEffect(() => {
    debugCountRef.current = debugCount;
  }, [debugCount]);

  function attachFeedbackSetter(setFeedback: Dispatch<SetStateAction<string>>) {
    feedbackSetterRef.current = setFeedback;
  }

  function setFeedback(message: string) {
    feedbackSetterRef.current?.(message);
  }

  async function refreshDebugStatus() {
    try {
      const response = await fetch(BROKER_DEBUG_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }
      const status = (await response.json()) as BrokerDebugStatus;
      const nextEnabled = Boolean(status.enabled);
      const nextCount = status.count ?? 0;
      debugEnabledRef.current = nextEnabled;
      debugCountRef.current = nextCount;
      setDebugEnabled(nextEnabled);
      setDebugCount(nextCount);
    } catch {
      debugEnabledRef.current = false;
      debugCountRef.current = 0;
      setDebugEnabled(false);
      setDebugCount(0);
    }
  }

  async function toggleDebugLogging() {
    const nextEnabled = !debugEnabled;
    setDebugBusy(true);
    setFeedback(nextEnabled ? "Enabling AMO debug logs..." : "Disabling AMO debug logs...");
    try {
      const status = await postBrokerJson<BrokerDebugStatus>(BROKER_DEBUG_URL, { enabled: nextEnabled });
      const resultEnabled = Boolean(status.enabled);
      const resultCount = status.count ?? 0;
      debugEnabledRef.current = resultEnabled;
      debugCountRef.current = resultCount;
      setDebugEnabled(resultEnabled);
      setDebugCount(resultCount);
      setFeedback(resultEnabled ? `Debug logging enabled (${resultCount} entries).` : "Debug logging disabled.");
    } catch (error) {
      setFeedback(`Debug toggle failed: ${(error as Error).message}`);
    } finally {
      setDebugBusy(false);
    }
  }

  async function postDebugLog(event: string, data?: unknown) {
    if (!debugEnabledRef.current) return;
    try {
      const result = await postBrokerJson<{ ok: boolean; count: number }>(BROKER_DEBUG_LOGS_URL, {
        source: "overlay",
        event,
        data: data ?? {},
      });
      setDebugCount(result.count ?? debugCountRef.current);
    } catch {
      // Debug logging must never block the overlay action being debugged.
    }
  }

  return {
    attachFeedbackSetter,
    debugBusy,
    debugCount,
    debugEnabled,
    postDebugLog,
    refreshDebugStatus,
    toggleDebugLogging,
  };
}
