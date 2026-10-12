import { useEffect, useState } from "react";
import { PROTOCOL_VERSION, type StateSnapshot } from "@amo-studio/protocol";
import { discoverHost, loadState } from "./host/client.js";

// Shell placeholder until the board lands in S1-09: shows whether the Host is reachable.
type Status = { kind: "connecting" } | { kind: "connected"; state: StateSnapshot } | { kind: "offline"; reason: string };

export function App() {
  const [status, setStatus] = useState<Status>({ kind: "connecting" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const link = await discoverHost();
      if (!link) throw new Error("没有找到 Host（请从 AMO Studio 应用打开）");
      const state = await loadState(link);
      if (!cancelled) setStatus({ kind: "connected", state });
    })().catch((err: unknown) => {
      if (!cancelled) setStatus({ kind: "offline", reason: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main data-protocol={PROTOCOL_VERSION} style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>AMO Studio</h1>
      <p data-testid="host-status">
        {status.kind === "connecting" && "正在连接 Host…"}
        {status.kind === "connected" && `已连接 Host · ${status.state.workspaces.length} 个工作区 · ${status.state.profiles.length} 个模型配置`}
        {status.kind === "offline" && `未连接：${status.reason}`}
      </p>
    </main>
  );
}
