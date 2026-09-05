import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TaskCard } from "../../overlay/src/components/TaskCard";
import { SessionRowContent } from "../../overlay/src/components/SessionCard";
import "../../overlay/src/styles.css";

const noop = () => {};
const actions = Object.fromEntries([
  "openNote", "openVSCode", "openCanvas", "markReviewed", "unbindWindow", "archive",
  "dismiss", "openApp", "activate", "resume", "handleAttention",
  "openLaunchPanel", "openWorkspacePanel", "startWindowBindDrag",
].map((name) => [name, noop]));
const flags = {
  activating: false, openingTarget: null, openingVSCode: false, unbindingWindow: false,
  archiving: false, reviewing: false, dismissing: false, attentionSignal: false,
  attentionVisualActive: false, windowBindDragging: false,
};
const count = Number(new URLSearchParams(location.search).get("count") || 100);
const baseline = new URLSearchParams(location.search).get("mode") === "baseline";
const legacyActions = {
  onOpenNote: noop, onOpenVSCode: noop, onOpenCanvas: noop, onMarkReviewed: noop,
  onUnbindWindow: noop, onArchive: noop, onDismiss: noop, onOpenCodexAppTarget: noop,
  onActivateSession: noop, onResumeSession: noop, onHandleAttention: noop,
  onOpenLaunchPanel: noop, onOpenWorkspacePanel: noop, onStartWindowBindDrag: noop,
};
const sessions = Array.from({ length: count }, (_, index) => ({
  sessionId: `perf-${index}`, tool: "codex", title: `Task ${index}`, taskTitle: `Investigate module ${index}`,
  cwd: "D:/Projects/Audit", state: "running", lastEvent: "PostToolUse", lastMessage: "Processing module",
  needsAttention: false, updatedAt: "2026-09-05T00:00:00Z", createdAt: "2026-09-05T00:00:00Z", eventCount: 1,
}));
function App() {
  const [items, setItems] = useState(sessions);
  (window as any).updateCard = (index: number) => {
    const start = performance.now();
    flushSync(() => setItems((current) => current.map((item, itemIndex) => itemIndex === index
      ? { ...item, eventCount: item.eventCount + 1, lastMessage: `Event ${item.eventCount}` } : item)));
    return performance.now() - start;
  };
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 360px)", gap: 12, padding: 16 }}>
    {items.map((session) => <div key={session.sessionId} className="session-row">
      <span className="row-drag-handle" aria-hidden="true" />
      {baseline ? <SessionRowContent session={session as any} {...flags} {...legacyActions} />
        : <TaskCard session={session as any} {...flags} commands={actions as any} />}
    </div>)}
  </div>;
}
const start = performance.now();
flushSync(() => createRoot(document.getElementById("root")!).render(<App />));
(window as any).mountMs = performance.now() - start;
