import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentSession } from "../types";
import { SessionReplica } from "../runtime/sessionReplica";

export function useSessionReplica() {
  const replicaRef = useRef<SessionReplica | null>(null);
  if (!replicaRef.current) replicaRef.current = new SessionReplica();
  const [sessions, render] = useState<AgentSession[]>([]);
  const sessionsRef = useRef(sessions);
  const setSessions: Dispatch<SetStateAction<AgentSession[]>> = useCallback((update) => {
    const replica = replicaRef.current!;
    const proposed = typeof update === "function" ? update(replica.current()) : update;
    const next = replica.replace(proposed);
    sessionsRef.current = next;
    render(next);
  }, []);
  return { sessions, sessionsRef, setSessions, replica: replicaRef.current };
}
