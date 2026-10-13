import { useEffect, useState } from "react";
import type { Id } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

interface OnCanvasToggleProps {
  link: HostLink;
  taskId: Id;
  topicId: Id;
  disabled?: boolean;
  onError(message: string): void;
}

/**
 * "显示在画布上" on the task page (S11-A): whether the task's card is on its topic's canvas. Tasks created on the canvas
 * are always there; others only when the person ticks this. Hiding keeps the task in the topic.
 */
export function OnCanvasToggle({ link, taskId, topicId, disabled, onError }: OnCanvasToggleProps) {
  const [placed, setPlaced] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const has = (nodes: ReadonlyArray<{ kind: string }>) => nodes.some((n) => n.kind === "task" && (n as { taskId?: Id }).taskId === taskId);
    const load = () =>
      void call(link, "GET /api/topics/:id/canvas", { id: topicId })
        .then((doc) => alive && setPlaced(has(doc.nodes)))
        .catch(() => undefined);
    load();
    const off = onHostEvent((e) => {
      if (e.type === "canvas.updated" && e.canvas.id === topicId) setPlaced(has(e.canvas.nodes));
    });
    const offReconnect = onHostReconnect(load);
    return () => {
      alive = false;
      off();
      offReconnect();
    };
  }, [link, taskId, topicId]);

  async function toggle(onCanvas: boolean) {
    const before = placed;
    setPlaced(onCanvas); // optimistic
    setBusy(true);
    try {
      const doc = await call(link, "PUT /api/tasks/:id/canvas", { id: taskId }, { onCanvas });
      setPlaced(doc.nodes.some((n) => n.kind === "task" && n.taskId === taskId));
    } catch (err) {
      setPlaced(before);
      onError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="inline-field check" title="在专题的画布上显示这个任务的卡片；不显示时任务仍在专题里">
      <input type="checkbox" checked={!!placed} disabled={disabled || busy || placed === null} onChange={(e) => void toggle(e.target.checked)} data-testid="task-on-canvas" />
      显示在画布上
    </label>
  );
}
