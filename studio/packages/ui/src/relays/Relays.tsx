import { useEffect, useState } from "react";
import type { Relay, Task } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

// 传话 (stage 16, from the stage 15 design): a 主控's message for another task's session waits here for the person —
// on both tasks' pages and in Focus — unless that task takes relays without asking.

/** The relays the Host lists (pending ones, and those decided in the last day), kept current. */
export function useRelays(link: HostLink): Relay[] {
  const [relays, setRelays] = useState<Relay[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => call(link, "GET /api/relays", {}).then((r) => live && setRelays(r)).catch(() => undefined);
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "relay.upserted") setRelays((cur) => (cur.some((r) => r.id === e.relay.id) ? cur.map((r) => (r.id === e.relay.id ? e.relay : r)) : [...cur, e.relay]));
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      live = false;
      off();
      offReconnect();
    };
  }, [link]);
  return relays;
}

/** One pending relay: from which 主控 to which task, what it says, and 发送 / 不发. */
export function RelayCard({ link, relay, tasks, className = "relay-card" }: { link: HostLink; relay: Relay; tasks: readonly Task[]; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = (id: string | null) => (id ? tasks.find((t) => t.id === id)?.title || "未命名任务" : "主控");
  const act = async (what: "deliver" | "dismiss") => {
    setBusy(true);
    setError(null);
    try {
      await call(link, what === "deliver" ? "POST /api/relays/:id/deliver" : "POST /api/relays/:id/dismiss", { id: relay.id });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className={className} role="group" aria-label="传话" data-testid="relay-card">
      <span className="relay-head">
        <span className="relay-mark">传话</span>
        主控「{title(relay.fromTaskId)}」→「{title(relay.toTaskId)}」
      </span>
      <p className="relay-text">{relay.text}</p>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <span className="relay-actions">
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void act("dismiss")} data-testid="relay-dismiss">
          不发
        </button>
        <button type="button" className="btn-primary small" disabled={busy} title="送进那个任务的会话（正在回复时排在这一轮之后）" onClick={() => void act("deliver")} data-testid="relay-deliver">
          发送
        </button>
      </span>
    </div>
  );
}

/** The pending relays to or from a task, on its page. */
export function RelayBanner({ link, relays, tasks }: { link: HostLink; relays: readonly Relay[]; tasks: readonly Task[] }) {
  const pending = relays.filter((r) => r.state === "pending");
  if (!pending.length) return null;
  return (
    <div className="relay-banner" data-testid="relay-banner">
      {pending.map((r) => (
        <RelayCard key={r.id} link={link} relay={r} tasks={tasks} />
      ))}
    </div>
  );
}
