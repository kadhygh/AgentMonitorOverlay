import { useCallback, useEffect, useRef, useState } from "react";
import type { HostEvent, StateSnapshot } from "@amo-studio/protocol";
import { discoverHost, loadState, type HostLink } from "./client.js";
import { emitHostEvent, emitHostReconnect } from "./events.js";

// Board-level state: the snapshot plus live workspace/task/session updates from the Host event stream.
// Session items are loaded per task page (S1-11).

export type HostState =
  | { kind: "connecting" }
  | { kind: "offline"; reason: string }
  | { kind: "ready"; link: HostLink; state: StateSnapshot; live: boolean };

function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function applyEvent(state: StateSnapshot, e: HostEvent): StateSnapshot {
  const next = { ...state, eventSeq: Math.max(state.eventSeq, e.seq) };
  switch (e.type) {
    case "workspace.upserted":
      return { ...next, workspaces: upsert(state.workspaces, e.workspace) };
    case "workspace.removed":
      return { ...next, workspaces: state.workspaces.filter((w) => w.id !== e.workspaceId) };
    case "task.upserted":
      return { ...next, tasks: upsert(state.tasks, e.task) };
    case "topic.upserted":
      return { ...next, topics: upsert(state.topics, e.topic) };
    case "session.upserted":
      return { ...next, sessions: upsert(state.sessions, e.session) };
    case "data.purged": {
      const gone = new Set([...e.workspaceIds, ...e.topicIds, ...e.taskIds, ...e.sessionIds]);
      const keep = <T extends { id: string }>(list: readonly T[]) => list.filter((x) => !gone.has(x.id));
      return { ...next, workspaces: keep(state.workspaces), topics: keep(state.topics), tasks: keep(state.tasks), sessions: keep(state.sessions) };
    }
    default:
      return next;
  }
}

export function useHostState() {
  const [host, setHost] = useState<HostState>({ kind: "connecting" });
  const socket = useRef<WebSocket | null>(null);
  const connectedOnce = useRef(false);

  const connect = useCallback(async () => {
    try {
      const link = await discoverHost();
      if (!link) throw new Error("没有找到 Host（请从 AMO Studio 应用打开）");
      const state = await loadState(link);
      setHost({ kind: "ready", link, state, live: false });

      const ws = new WebSocket(`${link.url.replace(/^http/, "ws")}/api/events?token=${encodeURIComponent(link.token)}&since=${state.eventSeq}`);
      socket.current = ws;
      ws.onopen = () => {
        setHost((h) => (h.kind === "ready" ? { ...h, live: true } : h));
        if (connectedOnce.current) emitHostReconnect();
        connectedOnce.current = true;
      };
      ws.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data)) as HostEvent;
        setHost((h) => (h.kind === "ready" ? { ...h, state: applyEvent(h.state, event) } : h));
        emitHostEvent(event);
      };
      ws.onclose = () => {
        if (socket.current !== ws) return;
        setHost((h) => (h.kind === "ready" ? { ...h, live: false } : h));
        // Reconnect with a fresh snapshot; the Host may have restarted.
        setTimeout(() => void connect(), 2000);
      };
    } catch (err) {
      setHost({ kind: "offline", reason: err instanceof Error ? err.message : String(err) });
      setTimeout(() => void connect(), 3000);
    }
  }, []);

  useEffect(() => {
    void connect();
    return () => {
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
  }, [connect]);

  return host;
}
