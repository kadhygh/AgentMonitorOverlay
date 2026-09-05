import type { AgentSession } from "../types";
import { BROKER_SESSIONS_URL } from "./brokerClient";

export interface SessionSnapshot {
  revision?: number;
  brokerInstanceId?: string;
  storeRevision?: number;
  sessions: AgentSession[];
  counts?: { active: number; archived: number; total: number };
  hasMore?: boolean;
  offset?: number;
  limit?: number;
}

export async function loadActiveSessionSnapshot(signal?: AbortSignal): Promise<SessionSnapshot> {
  const first = await readPage(`${BROKER_SESSIONS_URL}?scope=active&snapshot=1&summary=1`, signal);
  const sessions = [...first.sessions];
  let page = first;
  // Older Brokers ignore snapshot=1; consume their bounded pages without silently dropping cards.
  while (page.hasMore) {
    if (page.sessions.length === 0) throw new Error("Broker pagination did not advance");
    const offset = (page.offset || 0) + page.sessions.length;
    page = await readPage(`${BROKER_SESSIONS_URL}?scope=active&offset=${offset}&limit=200&summary=1`, signal);
    if (page.brokerInstanceId !== first.brokerInstanceId || page.revision !== first.revision || page.storeRevision !== first.storeRevision) {
      throw new Error("Broker changed during paginated hydration; retry the snapshot");
    }
    sessions.push(...page.sessions);
  }
  return { ...first, sessions, hasMore: false };
}

async function readPage(url: string, signal?: AbortSignal): Promise<SessionSnapshot> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`broker returned ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.sessions)) throw new Error("broker response has no sessions");
  return payload;
}
