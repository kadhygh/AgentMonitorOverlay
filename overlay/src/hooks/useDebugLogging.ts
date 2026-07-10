import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BROKER_DEBUG_LOGS_URL,
  BROKER_DEBUG_URL,
  postBrokerJson,
} from "../api/brokerClient";
import type { BrokerDebugStatus } from "../types";

const DEBUG_STATUS_CHANGED_EVENT = "amo-debug-status-changed";
const DEBUG_STATUS_WINDOW_LABELS = ["main", "settings"];

interface DebugStatusChangedEvent {
  enabled: boolean;
  count: number;
}

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

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .listen<DebugStatusChangedEvent>(DEBUG_STATUS_CHANGED_EVENT, (event) => {
        if (!event.payload) return;
        applyDebugStatus(event.payload.enabled, event.payload.count);
      })
      .then((handler) => {
        unlisten = handler;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  function attachFeedbackSetter(setFeedback: Dispatch<SetStateAction<string>>) {
    feedbackSetterRef.current = setFeedback;
  }

  function setFeedback(message: string) {
    feedbackSetterRef.current?.(message);
  }

  function applyDebugStatus(enabled: boolean, count: number) {
    const normalizedCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    debugEnabledRef.current = enabled;
    debugCountRef.current = normalizedCount;
    setDebugEnabled(enabled);
    setDebugCount(normalizedCount);
  }

  async function publishDebugStatus(enabled: boolean, count: number) {
    const payload = { enabled, count } satisfies DebugStatusChangedEvent;
    await Promise.all(
      DEBUG_STATUS_WINDOW_LABELS.map((label) =>
        getCurrentWindow().emitTo(label, DEBUG_STATUS_CHANGED_EVENT, payload).catch(() => undefined),
      ),
    );
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
      applyDebugStatus(nextEnabled, nextCount);
      await publishDebugStatus(nextEnabled, nextCount);
    } catch {
      applyDebugStatus(false, 0);
    }
  }

  async function toggleDebugLogging() {
    const nextEnabled = !debugEnabledRef.current;
    setDebugBusy(true);
    setFeedback(nextEnabled ? "Enabling AMO debug logs..." : "Disabling AMO debug logs...");
    try {
      const status = await postBrokerJson<BrokerDebugStatus>(BROKER_DEBUG_URL, { enabled: nextEnabled });
      const resultEnabled = Boolean(status.enabled);
      const resultCount = status.count ?? 0;
      applyDebugStatus(resultEnabled, resultCount);
      await publishDebugStatus(resultEnabled, resultCount);
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
      const nextCount = result.count ?? debugCountRef.current;
      applyDebugStatus(debugEnabledRef.current, nextCount);
      await publishDebugStatus(debugEnabledRef.current, nextCount);
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
